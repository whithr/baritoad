//! Tauri commands — the whole webview↔core surface.
//!
//! All commands are `async` so they run on Tauri's command thread pool, never
//! the main/UI thread. The only long-running work (the pipeline itself) is
//! handed to the queue worker; every command here returns promptly.
//!
//! EP policy (task decision, PLAN.md §5 GPU story): requests always use
//! `EpChoice::Auto` — DirectML for separation (parity-gated, falls closed to
//! CPU) and CPU for wav2vec2 (TDR risk; already encoded in the pipeline). An
//! advanced setting can surface this later; no settings UI in milestone 1.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use karaoke_core::formats::{self, ExportMeta, Format};
use karaoke_core::lyrics;
use karaoke_core::pipeline::manifest::{self, StageId};
use karaoke_core::pipeline::{self, GenerateRequest};
use karaoke_core::separation;
use karaoke_core::timing::WordTimingMap;

use crate::queue::{self, JobQueue, JobSnapshot};

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
}

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
            let p = out_dir.join("pasted.lyrics.txt");
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
    // req.ep stays EpChoice::Auto (module docs: DML separation, CPU alignment).

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

    Ok(queue.enqueue(&app, req, title, artist, out_dir))
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
