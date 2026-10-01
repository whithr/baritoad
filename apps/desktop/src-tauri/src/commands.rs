//! Tauri commands — the whole webview↔core surface.
//!
//! All commands are `async` so they run on Tauri's command thread pool, never
//! the main/UI thread. The only long-running work (the pipeline itself) is
//! handed to the queue worker; every command here returns promptly.
//!
//! EP policy (PLAN.md §5 GPU story): requests use `EpChoice::Auto` —
//! DirectML for separation and wav2vec2 (each parity-gated, falling closed
//! to CPU) — unless Properties → Processing pins the processor
//! (`cpu_only`), which keeps the whole import off the graphics card.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use karaoke_core::formats::{self, ExportMeta, Format};
use karaoke_core::import;
use karaoke_core::library::store::SongQuery;
use karaoke_core::lyrics;
use karaoke_core::pipeline::manifest::{self, StageId};
use karaoke_core::pipeline::{self, GenerateRequest};
use karaoke_core::separation;
use karaoke_core::timing::WordTimingMap;

use crate::library::LibraryHandle;
use crate::queue::{self, JobQueue, JobSnapshot, PostImport};

/// Wizard → pipeline request. Lyrics arrive as pasted *text* (the paste box is
/// the golden path — PLAN.md §4); the command persists them beside the job's
/// outputs so karaoke-core's file-based contract and resume hashing apply.
#[derive(Debug, Deserialize)]
pub struct GenerateSongRequest {
    pub audio_path: String,
    #[serde(default)]
    pub lyrics_text: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub artist: Option<String>,
    #[serde(default)]
    pub out_dir: Option<String>,
    /// "lrc" | "ass" | "ultrastar"; empty ⇒ all three.
    #[serde(default)]
    pub exports: Vec<String>,
    /// Redo every stage even if the manifest says up-to-date.
    #[serde(default)]
    pub force: bool,
    /// High-quality separation: higher overlap + shift-averaging (~3x
    /// slower, cleaner stems). See the preset note in [`generate_song`].
    #[serde(default)]
    pub hq_separation: bool,
    /// Run the import on the CPU only (Properties → Processing): slower,
    /// leaves the graphics card free.
    #[serde(default)]
    pub cpu_only: bool,
    /// An UltraStar .txt whose timings are used as they are (bulk import);
    /// `lyrics_text` is ignored when set.
    #[serde(default)]
    pub timings_path: Option<String>,
}

/// Where `generate_song` persists pasted lyrics, inside the job's out dir.
const PASTED_LYRICS: &str = "pasted.lyrics.txt";

fn parse_format(s: &str) -> Result<Format, String> {
    match s {
        "lrc" => Ok(Format::Lrc),
        "ass" => Ok(Format::Ass),
        "ultrastar" => Ok(Format::UltraStar),
        other => Err(format!("unknown export format '{other}' (lrc, ass, ultrastar)")),
    }
}

#[tauri::command]
pub async fn generate_song(
    app: AppHandle,
    queue: State<'_, Arc<JobQueue>>,
    request: GenerateSongRequest,
) -> Result<JobSnapshot, String> {
    let job = build_job(request)?;
    Ok(queue.enqueue(&app, job.request, job.title, job.artist, job.out_dir, PostImport::default()))
}

/// A wizard/import request resolved into what the queue runs.
struct BuiltJob {
    request: GenerateRequest,
    title: String,
    artist: Option<String>,
    out_dir: PathBuf,
}

fn build_job(request: GenerateSongRequest) -> Result<BuiltJob, String> {
    let audio = PathBuf::from(&request.audio_path);
    if !audio.is_file() {
        return Err(format!("audio file not found: {}", audio.display()));
    }
    let out_dir = match &request.out_dir {
        Some(d) => PathBuf::from(d),
        None => pipeline::default_out_dir(&audio),
    };
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("cannot create out dir: {e}"))?;

    // Persist pasted lyrics as the job's lyrics file (content-hashed by the
    // manifest, so edited lyrics re-run cleanup+align+export and reuse stems).
    let lyrics_path = match request.lyrics_text.as_deref().map(str::trim) {
        Some(text) if !text.is_empty() => {
            let p = out_dir.join(PASTED_LYRICS);
            std::fs::write(&p, text).map_err(|e| format!("cannot write lyrics: {e}"))?;
            Some(p)
        }
        _ => None,
    };

    let (default_title, default_artist) = queue::meta_from_filename(&audio);
    let title = request
        .title
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .unwrap_or(default_title);
    let artist = request
        .artist
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .or(default_artist);

    let mut req = GenerateRequest::new(audio);
    req.lyrics = lyrics_path;
    req.timings = request.timings_path.as_deref().filter(|p| !p.is_empty()).map(PathBuf::from);
    req.out_dir = Some(out_dir.clone());
    req.title = Some(title.clone());
    req.artist = artist.clone();
    req.force = request.force;
    if !request.exports.is_empty() {
        let mut formats = Vec::new();
        for s in &request.exports {
            let f = parse_format(s)?;
            if !formats.contains(&f) {
                formats.push(f);
            }
        }
        req.exports = formats;
    }
    // EpChoice::Auto: DML separation, CPU alignment (module docs).
    if request.cpu_only {
        req.ep = separation::EpChoice::Cpu;
    }

    if request.hq_separation {
        // ~3x standard cost either way, always ONE resident session (the
        // DirectML-safe profile — four resident ft sessions once hung the
        // GPU; see ModelKind::HtdemucsFt docs). The pipeline only needs the
        // vocals + instrumental outputs, so "the ft model" here is just its
        // vocals-specialized sub-model.
        req.sep_options = separation::SeparateOptions {
            overlap: 0.5,
            shifts: 2,
        };
        let model_dir = separation::default_model_dir();
        if separation::ModelKind::HtdemucsFt.available_for_default(&model_dir) {
            req.sep_model = separation::ModelKind::HtdemucsFt;
        }
    }

    Ok(BuiltJob {
        request: req,
        title,
        artist,
        out_dir,
    })
}

// ---------------------------------------------------------------- bulk import

/// One song the folder scan found, as the review list shows it.
#[derive(Debug, Serialize)]
pub struct ImportCandidate {
    pub audio_path: PathBuf,
    pub title: String,
    pub artist: Option<String>,
    pub lyrics: import::LyricsFile,
    pub collection: Option<String>,
    /// The library already has a song from this file (unchecked by default).
    pub in_library: bool,
    /// From an UltraStar header, when the song has one.
    pub year: Option<i32>,
    pub genre: Option<String>,
    pub language: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ImportScan {
    pub items: Vec<ImportCandidate>,
    pub unmatched_lyrics: Vec<PathBuf>,
}

/// Scan dropped/picked folders and files for songs to import
/// (karaoke-core `import` module docs: pairing, collections, skips).
#[tauri::command]
pub async fn scan_import(
    library: State<'_, Arc<LibraryHandle>>,
    paths: Vec<String>,
) -> Result<ImportScan, String> {
    let roots: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    let scan = tauri::async_runtime::spawn_blocking(move || import::scan(&roots))
        .await
        .map_err(|e| format!("scan failed: {e}"))?;
    let known: std::collections::HashSet<String> = {
        let store = library.lock()?;
        store
            .list_songs(&SongQuery::default())
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|s| path_key(&s.audio_path))
            .collect()
    };
    Ok(ImportScan {
        items: scan
            .items
            .into_iter()
            .map(|i| ImportCandidate {
                in_library: known.contains(&path_key(&i.audio)),
                audio_path: i.audio,
                title: i.title,
                artist: i.artist,
                lyrics: i.lyrics,
                collection: i.collection,
                year: i.year,
                genre: i.genre,
                language: i.language,
            })
            .collect(),
        unmatched_lyrics: scan.unmatched_lyrics,
    })
}

fn path_key(p: &Path) -> String {
    p.to_string_lossy().replace('/', "\\").to_lowercase()
}

/// The lyrics an import item brings (the scan's `LyricsFile`, echoed back).
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ImportLyrics {
    None,
    Text { path: PathBuf },
    Lrc { path: PathBuf },
    #[serde(rename = "ultrastar")]
    UltraStar { path: PathBuf },
    Unreadable {
        #[allow(dead_code)]
        path: PathBuf,
    },
}

#[derive(Debug, Deserialize)]
pub struct ImportSongItem {
    pub audio_path: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub artist: Option<String>,
    pub lyrics: ImportLyrics,
    #[serde(default)]
    pub collection: Option<String>,
    #[serde(default)]
    pub year: Option<i32>,
    #[serde(default)]
    pub genre: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ImportFailure {
    pub audio_path: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct ImportQueued {
    pub jobs: Vec<JobSnapshot>,
    pub failures: Vec<ImportFailure>,
}

/// Queue a reviewed import: one job per song, in order. Text and LRC lyrics
/// go in as pasted lyrics (LRC stripped to its words); UltraStar timings are
/// used as they are and the song lands checked. A song that can't be queued
/// (file gone, lyrics unreadable) is reported, not fatal.
#[tauri::command]
pub async fn import_songs(
    app: AppHandle,
    queue: State<'_, Arc<JobQueue>>,
    items: Vec<ImportSongItem>,
    hq_separation: bool,
    cpu_only: bool,
) -> Result<ImportQueued, String> {
    let mut jobs = Vec::new();
    let mut failures = Vec::new();
    for item in items {
        let audio_path = item.audio_path.clone();
        let read = |p: &Path| import::read_text_file(p).map_err(|e| format!("cannot read {}: {e}", p.display()));
        let prepared = (|| -> Result<(GenerateSongRequest, bool), String> {
            let (lyrics_text, timings_path, checked) = match &item.lyrics {
                ImportLyrics::Text { path } => (Some(read(path)?), None, false),
                ImportLyrics::Lrc { path } => (Some(formats::lrc::lyrics_text(&read(path)?).text), None, false),
                ImportLyrics::UltraStar { path } => (None, Some(path.to_string_lossy().into_owned()), true),
                ImportLyrics::None | ImportLyrics::Unreadable { .. } => (None, None, false),
            };
            Ok((
                GenerateSongRequest {
                    audio_path: item.audio_path.clone(),
                    lyrics_text,
                    title: item.title.clone(),
                    artist: item.artist.clone(),
                    out_dir: None,
                    exports: Vec::new(),
                    force: false,
                    hq_separation,
                    cpu_only,
                    timings_path,
                },
                checked,
            ))
        })();
        match prepared.and_then(|(req, checked)| build_job(req).map(|j| (j, checked))) {
            Ok((job, checked)) => {
                let post = PostImport {
                    collection: item.collection.clone().filter(|c| !c.trim().is_empty()),
                    mark_checked: checked,
                    year: item.year,
                    genre: item.genre.clone(),
                    language: item.language.clone(),
                };
                jobs.push(queue.enqueue(&app, job.request, job.title, job.artist, job.out_dir, post));
            }
            Err(message) => failures.push(ImportFailure { audio_path, message }),
        }
    }
    Ok(ImportQueued { jobs, failures })
}

/// The lyrics the job in `out_dir` last ran with — what the wizard's
/// "Process again…" pre-fills, so a retry never silently drops pasted lyrics
/// and transcribes instead. The manifest is authoritative (its `lyrics` is
/// None when that run transcribed); a job that failed before its manifest was
/// written falls back to the file `generate_song` persisted.
#[tauri::command]
pub async fn job_lyrics(out_dir: String) -> Result<Option<String>, String> {
    let out_dir = PathBuf::from(out_dir);
    let path = match manifest::JobManifest::load(&manifest::JobManifest::manifest_path(&out_dir)) {
        Ok(man) => match man.lyrics {
            Some(lyrics) => lyrics.path,
            None => return Ok(None),
        },
        Err(_) => out_dir.join(PASTED_LYRICS),
    };
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("cannot read lyrics {}: {e}", path.display())),
    }
}

#[tauri::command]
pub async fn cancel_job(
    app: AppHandle,
    queue: State<'_, Arc<JobQueue>>,
    job_id: u64,
) -> Result<JobSnapshot, String> {
    queue
        .cancel(&app, job_id)
        .ok_or_else(|| format!("unknown job {job_id}"))
}

/// One row of the persisted jobs registry (survives restarts — the manifest
/// beside each job's outputs is authoritative, the registry just points).
#[derive(Debug, Serialize)]
pub struct RegistryJob {
    pub job_id: String,
    pub audio: PathBuf,
    pub out_dir: PathBuf,
    pub updated_unix: u64,
    /// "complete" / "failed@align" / … — None when the manifest is gone.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub map_path: Option<PathBuf>,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artist: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct JobsList {
    /// This process's queue (live progress comes via events).
    pub active: Vec<JobSnapshot>,
    /// The on-disk registry, newest first.
    pub registry: Vec<RegistryJob>,
}

#[tauri::command]
pub async fn list_jobs(queue: State<'_, Arc<JobQueue>>) -> Result<JobsList, String> {
    let active = queue.snapshots();
    let jobs = manifest::list_jobs(&manifest::default_jobs_dir()).map_err(|e| e.to_string())?;
    let registry = jobs
        .into_iter()
        .map(|(ptr, man)| {
            let (title, artist) = queue::meta_from_filename(&ptr.audio);
            RegistryJob {
                job_id: ptr.job_id,
                audio: ptr.audio,
                out_dir: ptr.out_dir,
                updated_unix: ptr.updated_unix,
                status: man.as_ref().map(|m| m.summary_status()),
                map_path: man
                    .as_ref()
                    .and_then(|m| m.artifact_path(StageId::Align, "map"))
                    .map(Path::to_path_buf),
                title,
                artist,
            }
        })
        .collect();
    Ok(JobsList { active, registry })
}

/// Parse + validate a timing map and hand it to the webview as JSON. The
/// map stores original-song time only (PLAN.md §5) — `from_json` rejects any
/// other time base.
#[tauri::command]
pub async fn read_timing_map(path: String) -> Result<serde_json::Value, String> {
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("cannot read {path}: {e}"))?;
    let map = WordTimingMap::from_json(&raw).map_err(|e| e.to_string())?;
    serde_json::to_value(&map).map_err(|e| e.to_string())
}

/// Dry-run cleanup summary for the wizard's paste box (PLAN.md §4: one-line
/// summary, inspectable, zero decisions by default). Nothing touches disk.
#[derive(Debug, Serialize)]
pub struct CleanPreview {
    pub summary: String,
    pub lines_kept: usize,
    pub words_kept: usize,
    /// Human-readable edit log (each entry Display-rendered).
    pub edits: Vec<String>,
    pub cleaned_text: String,
}

#[tauri::command]
pub async fn clean_lyrics_preview(text: String) -> Result<CleanPreview, String> {
    let c = lyrics::clean(&text);
    Ok(CleanPreview {
        summary: c.summary(),
        lines_kept: c.lines.len(),
        words_kept: c.word_count(),
        edits: c.edits.iter().map(|e| e.to_string()).collect(),
        cleaned_text: c.to_text(),
    })
}

#[derive(Debug, Deserialize)]
pub struct ExportSongRequest {
    /// Path to the job's `.align.json` timing map.
    pub map_path: String,
    /// "lrc" | "ass" | "ultrastar".
    pub formats: Vec<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub artist: Option<String>,
    #[serde(default)]
    pub audio_name: Option<String>,
}

/// Render the timing map to interchange formats beside the map
/// (original-song time verbatim — exporters never see stretch, PLAN.md §5).
#[tauri::command]
pub async fn export_song(request: ExportSongRequest) -> Result<Vec<PathBuf>, String> {
    let map_path = PathBuf::from(&request.map_path);
    let raw = std::fs::read_to_string(&map_path)
        .map_err(|e| format!("cannot read timing map {}: {e}", map_path.display()))?;
    let mut map = WordTimingMap::from_json(&raw).map_err(|e| e.to_string())?;
    if map.words.is_empty() {
        return Err("timing map has no words — nothing to export".into());
    }
    // Maps aligned before the aligner stopped auto-flagging still carry
    // unsung flags. The Bench and Stage show every word, so exports do too
    // (ASS would otherwise drop a fully flagged line).
    for w in &mut map.words {
        w.unsung = false;
    }
    map.unsung_spans.clear();

    // "<dir>/song" for "<dir>/song.align.json"
    let stem = map_path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "song".into());
    let stem = stem.strip_suffix(".align").unwrap_or(&stem).to_string();
    let dir = map_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));

    let meta = ExportMeta {
        title: request.title.clone().or_else(|| Some(stem.clone())),
        artist: request.artist.clone(),
        audio_name: request.audio_name.clone(),
    };
    let mut written = Vec::new();
    let mut seen = Vec::new();
    for s in &request.formats {
        let f = parse_format(s)?;
        if seen.contains(&f) {
            continue;
        }
        seen.push(f);
        let out = dir.join(format!("{stem}.{}", f.extension()));
        let rendered = formats::export(&map, &meta, f);
        std::fs::write(&out, rendered).map_err(|e| format!("cannot write {}: {e}", out.display()))?;
        written.push((f.as_str().to_string(), out));
    }

    // Record which map content these exports came from, so the UI can mark
    // them stale after the fix editor saves a new map (review.rs module docs).
    let map_sha256 = karaoke_core::pipeline::hash::sha256_hex(raw.as_bytes());
    crate::review::record_exports(&map_path, &map_sha256, &written)?;

    Ok(written.into_iter().map(|(_, p)| p).collect())
}
