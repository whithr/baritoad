//! Pipeline orchestrator (PLAN.md §5): the full generate pipeline —
//! separate → clean lyrics → align → export — run as discrete, resumable
//! stages with a persisted job manifest ([`manifest`]).
//!
//! Resume semantics live in the manifest module docs; the short form: a stage
//! is skipped when its recorded fingerprint (content hashes of its inputs +
//! its config + its version + upstream output tokens) is unchanged and its
//! artifacts are intact. Changed lyrics re-run cleanup + align + export but
//! reuse the stems; `force` redoes everything; `force_stages` redoes named
//! stages (and, via output-token chaining, whatever depends on them).
//!
//! Progress is surfaced through [`PipelineEvent`] — designed for the Tauri
//! app's progress screen (next milestone) and rendered to stderr by the CLI
//! today. Events serialize as tagged JSON (`{"type": "stage_progress", ...}`).
//!
//! Hard rules honored (CLAUDE.md): all processing is local; timing maps store
//! original-song time only (§5); no Python at runtime.

pub mod hash;
pub mod manifest;

use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::alignment::{AlignConfig, Aligner, CTC_ONSET_BIAS_S};
use crate::audio;
use crate::error::{Error, Result};
use crate::formats::{self, ExportMeta, Format};
use crate::lyrics::{self, CleanLyrics};
use crate::output::{FileSink, OutputFormat, StemSink};
use crate::separation::{self, EpChoice};
use crate::timing::WordTimingMap;

use manifest::{Artifact, JobManifest, JobPointer, StageId};

/// Bump when a stage's implementation changes in a way that invalidates old
/// outputs; the version participates in the stage fingerprint, so old jobs
/// rerun the stage instead of trusting stale artifacts.
pub const SEPARATE_STAGE_VERSION: u32 = 1;
pub const CLEAN_LYRICS_STAGE_VERSION: u32 = 1;
/// 3: transcribed lyrics break into lines at the singer's pauses, not
/// whole whisper chunks (alignment::lines).
pub const ALIGN_STAGE_VERSION: u32 = 3;
pub const EXPORT_STAGE_VERSION: u32 = 1;
/// Bump when [`run_import_timings_stage`]'s conversion changes (it stands in
/// for the align stage when a request carries UltraStar timings).
pub const TIMINGS_IMPORT_VERSION: u32 = 1;

/// Progress/diagnostic events for a front end to subscribe to. The Tauri app
/// (next milestone) forwards these to the progress screen; the CLI prints
/// them to stderr. Serialized as `{"type": "...", ...}` (serde tag).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PipelineEvent {
    StageStarted {
        stage: StageId,
    },
    /// `fraction` in [0, 1] when the stage can quantify progress (separation
    /// reports segments); message-only otherwise (alignment reports phases).
    StageProgress {
        stage: StageId,
        #[serde(skip_serializing_if = "Option::is_none")]
        fraction: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    StageSkipped {
        stage: StageId,
        reason: String,
    },
    StageCompleted {
        stage: StageId,
        seconds: f64,
    },
    StageFailed {
        stage: StageId,
        message: String,
    },
    Note {
        message: String,
    },
}

/// Everything `generate` needs. Paths may be relative; they are absolutized
/// against the current directory before hashing so manifests stay meaningful
/// from any working directory. Serializable so the desktop can hand a job to
/// its worker process.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerateRequest {
    pub audio: PathBuf,
    /// Pasted-lyrics file (golden path — PLAN.md §4). None ⇒ the align stage
    /// auto-transcribes and lyric cleanup is not applicable.
    pub lyrics: Option<PathBuf>,
    /// An UltraStar .txt whose hand-made timings replace alignment (bulk
    /// import of community song folders — PLAN.md §3 import). When set,
    /// `lyrics` is ignored: clean-lyrics is not applicable and the align stage
    /// converts the file instead of running the aligner.
    #[serde(default)]
    pub timings: Option<PathBuf>,
    /// Default: `<audio stem>-karaoke` beside the audio file.
    pub out_dir: Option<PathBuf>,
    /// Model root containing htdemucs.onnx, whisper-small/, wav2vec2/.
    pub model_dir: Option<PathBuf>,
    /// Jobs registry dir (default [`manifest::default_jobs_dir`]).
    pub jobs_dir: Option<PathBuf>,
    pub ep: EpChoice,
    /// Where separation runs *if it has to run*, without changing the job's
    /// identity: the separate stage's fingerprint keeps `ep`, so finished
    /// stems stay valid. The desktop's gaming mode sets this to the CPU while
    /// a game is using the graphics card — GPU and CPU stems are
    /// parity-checked equivalents, as `Auto` already treats them. `None` ⇒
    /// `ep`.
    #[serde(default)]
    pub sep_run_on: Option<EpChoice>,
    /// Separation quality knobs (overlap / pinned shifts); default = the
    /// standard single pass.
    pub sep_options: separation::SeparateOptions,
    /// Separation model; [`separation::ModelKind::HtdemucsFt`] needs the four
    /// ft ONNX files in the model dir.
    pub sep_model: separation::ModelKind,
    /// Export formats; empty ⇒ no export stage outputs (stage still records
    /// as complete with zero artifacts — callers usually pass at least one).
    pub exports: Vec<Format>,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub whisper_int8: bool,
    /// None ⇒ the spike-measured default ([`CTC_ONSET_BIAS_S`]).
    pub onset_bias_s: Option<f64>,
    /// Redo every stage regardless of manifest state.
    pub force: bool,
    /// Redo these stages (downstream stages cascade via output tokens).
    pub force_stages: Vec<StageId>,
}

impl GenerateRequest {
    pub fn new(audio: PathBuf) -> Self {
        Self {
            audio,
            lyrics: None,
            timings: None,
            out_dir: None,
            model_dir: None,
            jobs_dir: None,
            ep: EpChoice::Auto,
            sep_run_on: None,
            sep_options: separation::SeparateOptions::default(),
            sep_model: separation::ModelKind::default(),
            exports: vec![Format::Lrc, Format::Ass, Format::UltraStar],
            title: None,
            artist: None,
            whisper_int8: false,
            onset_bias_s: None,
            force: false,
            force_stages: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct StageOutcome {
    pub stage: StageId,
    /// False when the stage was skipped via resume (or not applicable).
    pub ran: bool,
    pub seconds: f64,
}

pub struct GenerateOutcome {
    pub manifest_path: PathBuf,
    pub manifest: JobManifest,
    pub map_path: PathBuf,
    pub export_paths: Vec<PathBuf>,
    pub stages: Vec<StageOutcome>,
    pub total_s: f64,
}

/// Default out dir: `<audio stem>-karaoke` beside the audio.
pub fn default_out_dir(audio: &Path) -> PathBuf {
    let stem = audio
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "song".into());
    audio
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
        .join(format!("{stem}-karaoke"))
}

/// Cheap identity for a model file (size + mtime). Weights are ~350 MB;
/// content-hashing them on every run would dominate resume time. A swapped
/// model file with identical size *and* mtime is out of threat model — the
/// model manager (PLAN.md §3) writes fresh files.
fn model_file_id(path: &Path) -> String {
    match std::fs::metadata(path) {
        Ok(m) => {
            let mtime = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            format!("{}:{}:{}", path.display(), m.len(), mtime)
        }
        Err(_) => format!("{}:missing", path.display()),
    }
}

fn fingerprint(parts: &serde_json::Value) -> String {
    hash::sha256_hex(parts.to_string().as_bytes())
}

fn absolutize(p: &Path) -> PathBuf {
    std::path::absolute(p).unwrap_or_else(|_| p.to_path_buf())
}

/// Models kept loaded between [`generate_with`] calls — the desktop's worker
/// process holds one across a queue of songs so each job skips session
/// setup. Keys include each model file's size + mtime, so a replaced file
/// reloads. Holds at most one separation session: a different model or EP
/// drops the resident one *before* loading (never two htdemucs-class
/// DirectML sessions at once — [`separation::ModelKind`] docs).
#[derive(Default)]
pub struct ModelCache {
    sep: Option<(SepKey, separation::SepModel)>,
    aligner: Option<(AlignKey, Aligner)>,
}

#[derive(PartialEq)]
struct SepKey {
    files: Vec<String>,
    ep: EpChoice,
}

#[derive(PartialEq)]
struct AlignKey {
    files: Vec<String>,
    whisper_int8: bool,
    w2v_dml: bool,
}

/// Run (or resume) the full generate pipeline. Every stage transition is
/// persisted to the job manifest before and after the stage runs, so a kill
/// at any point leaves a resumable record (manifest module docs).
pub fn generate(
    req: &GenerateRequest,
    on_event: &mut dyn FnMut(&PipelineEvent),
) -> Result<GenerateOutcome> {
    generate_with(req, &mut ModelCache::default(), on_event)
}

/// [`generate`], reusing (and refilling) `cache`'s loaded models.
pub fn generate_with(
    req: &GenerateRequest,
    cache: &mut ModelCache,
    on_event: &mut dyn FnMut(&PipelineEvent),
) -> Result<GenerateOutcome> {
    let t_total = Instant::now();
    let audio_path = absolutize(&req.audio);
    if !audio_path.is_file() {
        return Err(Error::InvalidInput(format!(
            "audio file not found: {}",
            audio_path.display()
        )));
    }
    let out_dir = absolutize(&req.out_dir.clone().unwrap_or_else(|| default_out_dir(&audio_path)));
    let model_dir = req
        .model_dir
        .clone()
        .unwrap_or_else(separation::default_model_dir);
    let jobs_dir = req.jobs_dir.clone().unwrap_or_else(manifest::default_jobs_dir);
    std::fs::create_dir_all(&out_dir)?;

    let song_stem = audio_path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "song".into());

    // ---- content-hash the inputs (the resume contract's foundation) ----
    on_event(&PipelineEvent::Note {
        message: format!("hashing inputs for {}", audio_path.display()),
    });
    let audio_ref = manifest::InputRef::from_file(&audio_path)?;
    let lyrics_ref = match &req.lyrics {
        Some(p) => Some(manifest::InputRef::from_file(&absolutize(p))?),
        None => None,
    };
    let timings_ref = match &req.timings {
        Some(p) => Some(manifest::InputRef::from_file(&absolutize(p))?),
        None => None,
    };

    // ---- load or create the manifest ----
    let manifest_path = JobManifest::manifest_path(&out_dir);
    let job_id = manifest::job_id(&audio_path, &out_dir);
    let mut man = match JobManifest::load(&manifest_path) {
        Ok(m) if m.job_id == job_id => m,
        Ok(_) => {
            on_event(&PipelineEvent::Note {
                message: "manifest in out dir belongs to a different job — starting fresh".into(),
            });
            JobManifest::new(job_id.clone(), audio_ref.clone(), lyrics_ref.clone(), &out_dir)
        }
        Err(_) => JobManifest::new(job_id.clone(), audio_ref.clone(), lyrics_ref.clone(), &out_dir),
    };
    man.audio = audio_ref.clone();
    man.lyrics = lyrics_ref.clone();

    let save = |man: &mut JobManifest| -> Result<()> {
        man.save_atomic(&manifest_path)?;
        manifest::write_pointer(
            &jobs_dir,
            &JobPointer {
                job_id: job_id.clone(),
                manifest: manifest_path.clone(),
                audio: audio_path.clone(),
                out_dir: out_dir.clone(),
                updated_unix: man.updated_unix,
            },
        )
    };

    let forced = |stage: StageId| req.force || req.force_stages.contains(&stage);
    let mut outcomes: Vec<StageOutcome> = Vec::new();

    // =====================================================================
    // stage 1: separate
    // =====================================================================
    let stems_dir = out_dir.join("stems");
    // paths_for(false): the pipeline writes vocals + instrumental only, so
    // ft loads just its vocals sub-model (single session — DirectML-safe).
    let model_paths = req.sep_model.paths_for(&model_dir, false);
    // Single-file model keeps the scalar fingerprint shape so existing
    // manifests stay valid; a bag hashes every file.
    let model_id = if model_paths.len() == 1 {
        serde_json::json!(model_file_id(&model_paths[0]))
    } else {
        serde_json::json!(model_paths
            .iter()
            .map(|p| model_file_id(p))
            .collect::<Vec<_>>())
    };
    let mut sep_fp_input = serde_json::json!({
        "stage": "separate",
        "version": SEPARATE_STAGE_VERSION,
        "audio_sha256": audio_ref.sha256,
        "ep": req.ep.as_str(),
        "model": model_id,
        "format": "wav",
    });
    // Non-default quality changes the stems; default omits the key so
    // manifests written before the knobs existed stay valid.
    if req.sep_options != separation::SeparateOptions::default() {
        sep_fp_input["quality"] = serde_json::json!({
            "overlap": req.sep_options.overlap,
            "shifts": req.sep_options.shifts,
        });
    }
    let sep_fp = fingerprint(&sep_fp_input);
    if !forced(StageId::Separate) && man.stage_up_to_date(StageId::Separate, &sep_fp) {
        on_event(&PipelineEvent::StageSkipped {
            stage: StageId::Separate,
            reason: "up to date (stems reused)".into(),
        });
        outcomes.push(StageOutcome {
            stage: StageId::Separate,
            ran: false,
            seconds: 0.0,
        });
    } else {
        man.mark_in_flight(StageId::Separate, SEPARATE_STAGE_VERSION, &sep_fp);
        save(&mut man)?;
        on_event(&PipelineEvent::StageStarted {
            stage: StageId::Separate,
        });
        let t0 = Instant::now();
        let result = run_separate_stage(
            &audio_path,
            &stems_dir,
            &model_paths,
            req.sep_run_on.unwrap_or(req.ep),
            req.sep_options,
            cache,
            on_event,
        );
        match result {
            Ok((artifacts, details)) => {
                let secs = t0.elapsed().as_secs_f64();
                man.mark_complete(StageId::Separate, SEPARATE_STAGE_VERSION, artifacts, secs);
                man.set_details(StageId::Separate, details);
                save(&mut man)?;
                on_event(&PipelineEvent::StageCompleted {
                    stage: StageId::Separate,
                    seconds: secs,
                });
                outcomes.push(StageOutcome {
                    stage: StageId::Separate,
                    ran: true,
                    seconds: secs,
                });
            }
            Err(e) => {
                let msg = e.to_string();
                man.mark_failed(StageId::Separate, SEPARATE_STAGE_VERSION, &msg);
                save(&mut man)?;
                on_event(&PipelineEvent::StageFailed {
                    stage: StageId::Separate,
                    message: msg,
                });
                return Err(e);
            }
        }
    }
    let sep_token = man
        .output_token(StageId::Separate)
        .ok_or_else(|| Error::InvalidInput("separate stage has no output token".into()))?
        .to_string();

    // =====================================================================
    // stage 2: clean lyrics (not applicable without pasted lyrics)
    // =====================================================================
    let clean_artifact_path = out_dir.join(format!("{song_stem}.lyrics.clean.json"));
    let clean_fp = fingerprint(&serde_json::json!({
        "stage": "clean_lyrics",
        "version": CLEAN_LYRICS_STAGE_VERSION,
        "lyrics_sha256": lyrics_ref.as_ref().map(|l| l.sha256.as_str()),
    }));
    // Holds the cleanup output when lyrics exist; populated by run or by
    // loading the artifact on skip (align needs the structure in memory).
    let mut cleaned: Option<CleanLyrics> = None;
    match lyrics_ref.as_ref().filter(|_| timings_ref.is_none()) {
        None => {
            man.mark_not_applicable(StageId::CleanLyrics, CLEAN_LYRICS_STAGE_VERSION, &clean_fp);
            save(&mut man)?;
            on_event(&PipelineEvent::StageSkipped {
                stage: StageId::CleanLyrics,
                reason: if timings_ref.is_some() {
                    "timings imported from an UltraStar file".into()
                } else {
                    "no lyrics given — align stage will auto-transcribe".into()
                },
            });
            outcomes.push(StageOutcome {
                stage: StageId::CleanLyrics,
                ran: false,
                seconds: 0.0,
            });
        }
        Some(lref) => {
            if !forced(StageId::CleanLyrics) && man.stage_up_to_date(StageId::CleanLyrics, &clean_fp)
            {
                let raw = std::fs::read_to_string(&clean_artifact_path)?;
                cleaned = Some(serde_json::from_str(&raw).map_err(|e| {
                    Error::InvalidInput(format!(
                        "cleaned-lyrics artifact parse {}: {e}",
                        clean_artifact_path.display()
                    ))
                })?);
                on_event(&PipelineEvent::StageSkipped {
                    stage: StageId::CleanLyrics,
                    reason: "up to date".into(),
                });
                outcomes.push(StageOutcome {
                    stage: StageId::CleanLyrics,
                    ran: false,
                    seconds: 0.0,
                });
            } else {
                man.mark_in_flight(StageId::CleanLyrics, CLEAN_LYRICS_STAGE_VERSION, &clean_fp);
                save(&mut man)?;
                on_event(&PipelineEvent::StageStarted {
                    stage: StageId::CleanLyrics,
                });
                let t0 = Instant::now();
                let run = || -> Result<CleanLyrics> {
                    let raw = std::fs::read_to_string(&lref.path).map_err(|e| {
                        Error::InvalidInput(format!("cannot read lyrics {}: {e}", lref.path.display()))
                    })?;
                    let c = lyrics::clean(&raw);
                    if c.word_count() == 0 {
                        return Err(Error::InvalidInput(
                            "lyrics contain no words after cleanup".into(),
                        ));
                    }
                    let json = serde_json::to_string_pretty(&c)
                        .map_err(|e| Error::Encode(format!("cleaned lyrics: {e}")))?;
                    manifest::write_atomic(&clean_artifact_path, json.as_bytes())?;
                    Ok(c)
                };
                match run() {
                    Ok(c) => {
                        let secs = t0.elapsed().as_secs_f64();
                        on_event(&PipelineEvent::StageProgress {
                            stage: StageId::CleanLyrics,
                            fraction: None,
                            message: Some(format!("lyric cleanup: {}", c.summary())),
                        });
                        let bytes = std::fs::metadata(&clean_artifact_path)?.len();
                        man.mark_complete(
                            StageId::CleanLyrics,
                            CLEAN_LYRICS_STAGE_VERSION,
                            vec![Artifact {
                                name: "clean".into(),
                                path: clean_artifact_path.clone(),
                                bytes,
                            }],
                            secs,
                        );
                        save(&mut man)?;
                        on_event(&PipelineEvent::StageCompleted {
                            stage: StageId::CleanLyrics,
                            seconds: secs,
                        });
                        outcomes.push(StageOutcome {
                            stage: StageId::CleanLyrics,
                            ran: true,
                            seconds: secs,
                        });
                        cleaned = Some(c);
                    }
                    Err(e) => {
                        let msg = e.to_string();
                        man.mark_failed(StageId::CleanLyrics, CLEAN_LYRICS_STAGE_VERSION, &msg);
                        save(&mut man)?;
                        on_event(&PipelineEvent::StageFailed {
                            stage: StageId::CleanLyrics,
                            message: msg,
                        });
                        return Err(e);
                    }
                }
            }
        }
    }
    let clean_token = man
        .output_token(StageId::CleanLyrics)
        .ok_or_else(|| Error::InvalidInput("clean_lyrics stage has no output token".into()))?
        .to_string();

    // =====================================================================
    // stage 3: align
    // =====================================================================
    let map_path = out_dir.join(format!("{song_stem}.align.json"));
    let onset_bias = req.onset_bias_s.unwrap_or(CTC_ONSET_BIAS_S);
    let align_fp = match &timings_ref {
        // Imported timings depend only on the file (and the audio length).
        Some(t) => fingerprint(&serde_json::json!({
            "stage": "align",
            "version": ALIGN_STAGE_VERSION,
            "source": "ultrastar",
            "import_version": TIMINGS_IMPORT_VERSION,
            "timings_sha256": t.sha256,
            "audio_sha256": audio_ref.sha256,
        })),
        None => fingerprint(&serde_json::json!({
            "stage": "align",
            "version": ALIGN_STAGE_VERSION,
            "separate_token": sep_token,
            "clean_token": clean_token,
            "whisper_int8": req.whisper_int8,
            "onset_bias_s": onset_bias,
            "w2v_dml": req.ep != EpChoice::Cpu,
            "models": [
                model_file_id(&model_dir.join(crate::alignment::WHISPER_DIR_NAME)),
                model_file_id(&model_dir.join(crate::alignment::WAV2VEC2_DIR_NAME)),
            ],
        })),
    };
    // The map, in memory, for the export stage (loaded from disk on skip).
    let map: Option<WordTimingMap>;
    if !forced(StageId::Align) && man.stage_up_to_date(StageId::Align, &align_fp) {
        let raw = std::fs::read_to_string(&map_path)?;
        map = Some(WordTimingMap::from_json(&raw)?);
        on_event(&PipelineEvent::StageSkipped {
            stage: StageId::Align,
            reason: "up to date".into(),
        });
        outcomes.push(StageOutcome {
            stage: StageId::Align,
            ran: false,
            seconds: 0.0,
        });
    } else {
        man.mark_in_flight(StageId::Align, ALIGN_STAGE_VERSION, &align_fp);
        save(&mut man)?;
        on_event(&PipelineEvent::StageStarted {
            stage: StageId::Align,
        });
        let t0 = Instant::now();
        let result = match &timings_ref {
            Some(t) => run_import_timings_stage(&t.path, &audio_path, &map_path, on_event),
            None => run_align_stage(req, &stems_dir, &model_dir, cleaned.as_ref(), &map_path, cache, on_event)
                .map(|(m, stats)| (m, serde_json::to_value(&stats).unwrap_or(serde_json::Value::Null))),
        };
        match result {
            Ok((m, details)) => {
                let secs = t0.elapsed().as_secs_f64();
                let bytes = std::fs::metadata(&map_path)?.len();
                man.mark_complete(
                    StageId::Align,
                    ALIGN_STAGE_VERSION,
                    vec![Artifact {
                        name: "map".into(),
                        path: map_path.clone(),
                        bytes,
                    }],
                    secs,
                );
                man.set_details(StageId::Align, details);
                save(&mut man)?;
                on_event(&PipelineEvent::StageCompleted {
                    stage: StageId::Align,
                    seconds: secs,
                });
                outcomes.push(StageOutcome {
                    stage: StageId::Align,
                    ran: true,
                    seconds: secs,
                });
                map = Some(m);
            }
            Err(e) => {
                let msg = e.to_string();
                man.mark_failed(StageId::Align, ALIGN_STAGE_VERSION, &msg);
                save(&mut man)?;
                on_event(&PipelineEvent::StageFailed {
                    stage: StageId::Align,
                    message: msg,
                });
                return Err(e);
            }
        }
    }
    let align_token = man
        .output_token(StageId::Align)
        .ok_or_else(|| Error::InvalidInput("align stage has no output token".into()))?
        .to_string();

    // =====================================================================
    // stage 4: export
    // =====================================================================
    let meta = ExportMeta {
        title: req.title.clone().or_else(|| Some(song_stem.clone())),
        artist: req.artist.clone(),
        audio_name: audio_path
            .file_name()
            .map(|s| s.to_string_lossy().into_owned()),
    };
    let mut formats_sorted: Vec<&'static str> =
        req.exports.iter().map(|f| f.as_str()).collect();
    formats_sorted.sort_unstable();
    formats_sorted.dedup();
    let export_fp = fingerprint(&serde_json::json!({
        "stage": "export",
        "version": EXPORT_STAGE_VERSION,
        "align_token": align_token,
        "formats": formats_sorted,
        "title": meta.title,
        "artist": meta.artist,
        "audio_name": meta.audio_name,
    }));
    if !forced(StageId::Export) && man.stage_up_to_date(StageId::Export, &export_fp) {
        on_event(&PipelineEvent::StageSkipped {
            stage: StageId::Export,
            reason: "up to date".into(),
        });
        outcomes.push(StageOutcome {
            stage: StageId::Export,
            ran: false,
            seconds: 0.0,
        });
    } else {
        man.mark_in_flight(StageId::Export, EXPORT_STAGE_VERSION, &export_fp);
        save(&mut man)?;
        on_event(&PipelineEvent::StageStarted {
            stage: StageId::Export,
        });
        let t0 = Instant::now();
        let run = || -> Result<Vec<Artifact>> {
            let map = map
                .as_ref()
                .ok_or_else(|| Error::InvalidInput("no timing map for export".into()))?;
            let mut artifacts = Vec::new();
            let mut seen: Vec<Format> = Vec::new();
            for &f in &req.exports {
                if seen.contains(&f) {
                    continue;
                }
                seen.push(f);
                let path = out_dir.join(format!("{song_stem}.{}", f.extension()));
                let rendered = formats::export(map, &meta, f);
                manifest::write_atomic(&path, rendered.as_bytes())?;
                let bytes = std::fs::metadata(&path)?.len();
                artifacts.push(Artifact {
                    name: f.as_str().into(),
                    path,
                    bytes,
                });
            }
            Ok(artifacts)
        };
        match run() {
            Ok(artifacts) => {
                let secs = t0.elapsed().as_secs_f64();
                man.mark_complete(StageId::Export, EXPORT_STAGE_VERSION, artifacts, secs);
                save(&mut man)?;
                on_event(&PipelineEvent::StageCompleted {
                    stage: StageId::Export,
                    seconds: secs,
                });
                outcomes.push(StageOutcome {
                    stage: StageId::Export,
                    ran: true,
                    seconds: secs,
                });
            }
            Err(e) => {
                let msg = e.to_string();
                man.mark_failed(StageId::Export, EXPORT_STAGE_VERSION, &msg);
                save(&mut man)?;
                on_event(&PipelineEvent::StageFailed {
                    stage: StageId::Export,
                    message: msg,
                });
                return Err(e);
            }
        }
    }

    let export_paths = man
        .stage(StageId::Export)
        .map(|e| e.artifacts.iter().map(|a| a.path.clone()).collect())
        .unwrap_or_default();
    Ok(GenerateOutcome {
        manifest_path,
        manifest: man,
        map_path,
        export_paths,
        stages: outcomes,
        total_s: t_total.elapsed().as_secs_f64(),
    })
}

// ---------------------------------------------------------------------------
// stage bodies
// ---------------------------------------------------------------------------

fn run_separate_stage(
    audio_path: &Path,
    stems_dir: &Path,
    model_paths: &[PathBuf],
    ep: EpChoice,
    sep_options: separation::SeparateOptions,
    cache: &mut ModelCache,
    on_event: &mut dyn FnMut(&PipelineEvent),
) -> Result<(Vec<Artifact>, serde_json::Value)> {
    let progress_msg = |m: String, on_event: &mut dyn FnMut(&PipelineEvent)| {
        on_event(&PipelineEvent::StageProgress {
            stage: StageId::Separate,
            fraction: None,
            message: Some(m),
        });
    };

    let decoded = audio::decode_to_stereo_44k(audio_path)?;
    progress_msg(
        format!(
            "decoded {:.1}s ({} Hz, {} ch source)",
            decoded.duration_seconds(),
            decoded.source_sample_rate,
            decoded.source_channels
        ),
        on_event,
    );
    for note in &decoded.notes {
        progress_msg(note.clone(), on_event);
    }

    let parity_cache = separation::default_parity_cache_path();
    let mut sep_events = |e: &separation::Event| {
        let msg = match e {
            separation::Event::ModelInit { ep } => format!("loading model on {ep}"),
            separation::Event::ModelReady { ep, seconds } => {
                format!("{ep} session ready in {seconds:.2}s")
            }
            separation::Event::ParityCheck { ep } => {
                format!("golden-segment parity check ({ep})")
            }
            separation::Event::Parity(r) => format!(
                "parity {}: {}{}",
                r.ep,
                if r.passed { "pass" } else { "FAIL" },
                r.snr_db
                    .map(|s| format!(" ({s:.1} dB)"))
                    .unwrap_or_default()
            ),
            separation::Event::Fallback { from, reason } => {
                format!("{from} unusable: {reason}")
            }
            separation::Event::Note(n) => n.clone(),
        };
        on_event(&PipelineEvent::StageProgress {
            stage: StageId::Separate,
            fraction: None,
            message: Some(msg),
        });
    };
    let key = SepKey {
        files: model_paths.iter().map(|p| model_file_id(p)).collect(),
        ep,
    };
    let (mut model, init_seconds, parity_seconds) = match cache.sep.take() {
        Some((k, m)) if k == key => {
            sep_events(&separation::Event::Note(format!("reusing the loaded {} session", m.ep)));
            (m, 0.0, 0.0)
        }
        other => {
            // Release any resident session before building the next one.
            drop(other);
            let prepared =
                separation::prepare_model(model_paths, ep, Some(&parity_cache), &mut sep_events)?;
            (prepared.model, prepared.init_seconds, prepared.parity_seconds)
        }
    };
    let ep_used = model.ep;
    let sub_models = model.sub_models();

    let mut sink = FileSink::new(stems_dir, OutputFormat::Wav, false)?;
    let stats = separation::separate_streamed(
        &decoded.samples,
        decoded.len,
        &mut model,
        &mut sink,
        sep_options,
        &mut |done, total| {
            on_event(&PipelineEvent::StageProgress {
                stage: StageId::Separate,
                fraction: Some(done as f64 / total.max(1) as f64),
                message: Some(format!("separating: {done}/{total} segments ({ep_used})")),
            });
        },
    )?;
    let files = sink.finalize()?;
    cache.sep = Some((key, model));
    on_event(&PipelineEvent::StageProgress {
        stage: StageId::Separate,
        fraction: Some(1.0),
        message: Some(format!(
            "separated {} segments (inference {:.1}s, {ep_used})",
            stats.segments, stats.infer_seconds
        )),
    });

    let mut artifacts = Vec::with_capacity(files.len());
    for f in files {
        let bytes = std::fs::metadata(&f.path)?.len();
        artifacts.push(Artifact {
            name: f.name,
            path: f.path,
            bytes,
        });
    }
    let details = serde_json::json!({
        "ep": format!("{ep_used}"),
        "segments": stats.segments,
        "infer_seconds": stats.infer_seconds,
        "session_init_seconds": init_seconds,
        "parity_seconds": parity_seconds,
        "sub_models": sub_models,
        "overlap": sep_options.overlap,
        "shifts": sep_options.shifts,
    });
    Ok((artifacts, details))
}

/// The align stage for a request carrying UltraStar timings: the file's
/// words and hand-made timings become the map as they are — no aligner, no
/// cleanup (PLAN.md §3 import: "lyrics + timings used for playback"). The
/// map runs to the audio's end so playback and the Bench see the whole song.
fn run_import_timings_stage(
    timings: &Path,
    audio: &Path,
    map_path: &Path,
    on_event: &mut dyn FnMut(&PipelineEvent),
) -> Result<(WordTimingMap, serde_json::Value)> {
    let text = crate::import::read_text_file(timings)
        .map_err(|e| Error::InvalidInput(format!("cannot read {}: {e}", timings.display())))?;
    let map = timings_map_from_ultrastar(&text, crate::library::tags::read_tags(audio).ok().and_then(|t| t.duration_s))?;
    on_event(&PipelineEvent::StageProgress {
        stage: StageId::Align,
        fraction: Some(1.0),
        message: Some(format!("{} words timed by the UltraStar file", map.words.len())),
    });
    manifest::write_atomic(map_path, map.to_json_pretty()?.as_bytes())?;
    let details = serde_json::json!({
        "source": "ultrastar",
        "file": timings,
        "words": map.words.len(),
    });
    Ok((map, details))
}

/// UltraStar text → a validated, imported-source timing map at least as long
/// as the audio (`audio_s`, when known).
fn timings_map_from_ultrastar(text: &str, audio_s: Option<f64>) -> Result<WordTimingMap> {
    let song = formats::ultrastar::import(text)?;
    let mut map = song.to_timing_map();
    if let Some(d) = audio_s.filter(|d| d.is_finite() && *d > 0.0) {
        map.duration = map.duration.max(d);
    }
    map.lyric_source = Some(crate::timing::LyricSource::Imported);
    let violations = map.validate();
    if !violations.is_empty() {
        return Err(Error::InvalidInput(format!(
            "UltraStar timings failed sanity checks: {}",
            violations.join("; ")
        )));
    }
    Ok(map)
}

fn run_align_stage(
    req: &GenerateRequest,
    stems_dir: &Path,
    model_dir: &Path,
    cleaned: Option<&CleanLyrics>,
    map_path: &Path,
    cache: &mut ModelCache,
    on_event: &mut dyn FnMut(&PipelineEvent),
) -> Result<(WordTimingMap, crate::alignment::AlignStats)> {
    let whisper_int8 = req.whisper_int8;
    let onset_bias_s = req.onset_bias_s.unwrap_or(CTC_ONSET_BIAS_S);
    let w2v_dml = req.ep != EpChoice::Cpu;
    let vocals_path = stems_dir.join("vocals.wav");
    if !vocals_path.is_file() {
        return Err(Error::InvalidInput(format!(
            "vocal stem not found: {} (separate stage output missing)",
            vocals_path.display()
        )));
    }
    let vocals = audio::decode_to_mono_16k(&vocals_path)?;
    on_event(&PipelineEvent::StageProgress {
        stage: StageId::Align,
        fraction: None,
        message: Some(format!("vocal stem: {:.1}s decoded to 16 kHz mono", vocals.duration_s)),
    });

    let cfg = AlignConfig {
        whisper_int8,
        onset_bias_s,
        // wav2vec2 on DirectML unless the request pins the CPU (soak-tested —
        // AlignConfig::w2v_try_dml docs); parity-gated, falls closed to CPU.
        w2v_try_dml: w2v_dml,
        ..AlignConfig::default()
    };
    let key = AlignKey {
        files: [crate::alignment::WHISPER_DIR_NAME, crate::alignment::WAV2VEC2_DIR_NAME]
            .iter()
            .map(|d| model_file_id(&model_dir.join(d)))
            .collect(),
        whisper_int8,
        w2v_dml,
    };
    if !matches!(&cache.aligner, Some((k, _)) if *k == key) {
        cache.aligner = None;
        let (loaded, notes) = Aligner::load(model_dir, cfg)?;
        for n in &notes {
            on_event(&PipelineEvent::StageProgress {
                stage: StageId::Align,
                fraction: None,
                message: Some(n.clone()),
            });
        }
        cache.aligner = Some((key, loaded));
    }
    let aligner = &mut cache.aligner.as_mut().expect("loaded above").1;
    aligner.cfg.onset_bias_s = onset_bias_s;

    let mut progress = |fraction: Option<f64>, m: &str| {
        on_event(&PipelineEvent::StageProgress {
            stage: StageId::Align,
            fraction,
            message: Some(m.to_string()),
        });
    };
    let mut out = match cleaned {
        Some(c) => {
            let words = c.lyric_words();
            aligner.align_words(&vocals.samples, &words, &mut progress)?
        }
        None => aligner.align_transcribe(&vocals.samples, &mut progress)?,
    };
    if let Some(c) = cleaned {
        c.annotate_map(&mut out.map)?;
    }

    let violations = out.map.validate();
    if !violations.is_empty() {
        return Err(Error::InvalidInput(format!(
            "timing map failed sanity checks: {}",
            violations.join("; ")
        )));
    }
    manifest::write_atomic(map_path, out.map.to_json_pretty()?.as_bytes())?;
    Ok((out.map, out.stats))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::timing::LyricSource;

    const SONG: &str = "#TITLE:T\n#ARTIST:A\n#BPM:300\n#GAP:1000\n\
                        : 0 4 0 Hel\n: 4 4 0 lo\n: 10 4 0  there\n- 20\n: 22 6 0 again\nE\n";

    #[test]
    fn ultrastar_timings_become_an_imported_map_to_the_audio_end() {
        let map = timings_map_from_ultrastar(SONG, Some(180.0)).unwrap();
        let words: Vec<&str> = map.words.iter().map(|w| w.word.as_str()).collect();
        assert_eq!(words, ["Hello", "there", "again"]);
        assert_eq!(map.lyric_source, Some(LyricSource::Imported));
        // #GAP 1000 ms, 20 beats/s at #BPM 300.
        assert!((map.words[0].start - 1.0).abs() < 1e-9);
        assert!((map.words[2].start - 2.1).abs() < 1e-9);
        assert_eq!(map.duration, 180.0);
        assert_eq!(map.words[2].line, Some(1));
    }

    #[test]
    fn unknown_audio_length_keeps_the_last_word_end() {
        let map = timings_map_from_ultrastar(SONG, None).unwrap();
        assert!((map.duration - 2.4).abs() < 1e-9);
    }

    #[test]
    fn a_duet_is_refused() {
        let duet = "#TITLE:T\n#BPM:300\nP1\n: 0 4 0 hi\nE\n";
        assert!(timings_map_from_ultrastar(duet, None).is_err());
    }
}
