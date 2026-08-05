//! Review-screen commands (PLAN.md §3 "Review screen", §4 step 4 "Preview &
//! fix"): audio playback grants, the fix editor's save / re-align / export
//! bookkeeping.
//!
//! ## Playback (this milestone only)
//!
//! The review screen plays the instrumental / vocal / original **plain** —
//! no key/tempo shift — through the webview's `<audio>` element and Tauri's
//! asset protocol. The asset scope starts *empty* (tauri.conf.json) and
//! [`playback_sources`] allows individual files at runtime, only after
//! resolving them through the library row or the job manifest — the webview
//! can never mint read access to arbitrary paths. The Phase 3 performance
//! player (cpal + Signalsmith stretch, PLAN.md §5) replaces this for actual
//! singing; the §5 player-clock rules live there — nothing here stretches, so
//! `<audio>.currentTime` *is* original-song time.
//!
//! ## Stale exports
//!
//! Exports are snapshots of the timing map. A sidecar (`song.exports.json`
//! beside the map) records the map-content hash each export was rendered
//! from; when the fix editor saves a new map the hashes stop matching and the
//! UI marks those exports stale — the simplest honest answer to "is this
//! .lrc still current?".

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use karaoke_core::alignment::{anchor, WindowAligner, SAMPLE_RATE};
use karaoke_core::audio;
use karaoke_core::pipeline::hash::sha256_hex;
use karaoke_core::pipeline::manifest::{self, JobManifest, StageId};
use karaoke_core::separation;
use karaoke_core::timing::WordTimingMap;

use crate::library::LibraryHandle;

// ---------------------------------------------------------------------------
// playback sources
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct PlaybackSources {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instrumental: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vocals: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original: Option<PathBuf>,
}

/// Resolve the three playable files for a song through **trusted records
/// only**: a library row (`song_id`) or the job manifest beside `map_path` —
/// and in the manifest case the manifest must actually own that map, so an
/// arbitrary path can't be used as a skeleton key. Shared by the review
/// screen's asset-scope grants below and the performance player's
/// `player_load` (player.rs), which reads the same files via cpal instead.
pub fn resolve_song_sources(
    library: &LibraryHandle,
    song_id: Option<i64>,
    map_path: Option<&str>,
) -> Result<(Option<PathBuf>, Option<PathBuf>, Option<PathBuf>), String> {
    if let Some(id) = song_id {
        let store = library.lock()?;
        let song = store
            .song(id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("no song {id} in the library"))?;
        Ok((
            song.instrumental_path,
            song.vocals_path,
            Some(song.audio_path),
        ))
    } else if let Some(map) = map_path {
        let map = PathBuf::from(map);
        let dir = map
            .parent()
            .ok_or_else(|| "map path has no parent directory".to_string())?;
        let man = JobManifest::load(&JobManifest::manifest_path(dir))
            .map_err(|e| format!("no job manifest beside that map: {e}"))?;
        let owns = man
            .artifact_path(StageId::Align, "map")
            .map(|p| same_file(p, &map))
            .unwrap_or(false);
        if !owns {
            return Err("job manifest does not own that timing map".into());
        }
        Ok((
            man.artifact_path(StageId::Separate, "instrumental")
                .map(Path::to_path_buf),
            man.artifact_path(StageId::Separate, "vocals")
                .map(Path::to_path_buf),
            Some(man.audio.path.clone()),
        ))
    } else {
        Err("source resolution needs song_id or map_path".into())
    }
}

/// Review screen: resolve the playable files and allow exactly those files in
/// the asset-protocol scope (webview `<audio>` playback — see module docs).
#[tauri::command]
pub async fn playback_sources(
    app: AppHandle,
    library: State<'_, Arc<LibraryHandle>>,
    song_id: Option<i64>,
    map_path: Option<String>,
) -> Result<PlaybackSources, String> {
    let (instrumental, vocals, original) =
        resolve_song_sources(&library, song_id, map_path.as_deref())?;

    let scope = app.asset_protocol_scope();
    let allow = |p: Option<PathBuf>| -> Result<Option<PathBuf>, String> {
        match p {
            Some(p) if p.is_file() => {
                scope
                    .allow_file(&p)
                    .map_err(|e| format!("asset scope: {e}"))?;
                Ok(Some(p))
            }
            _ => Ok(None), // stems cleaned up / source moved: play what exists
        }
    };
    Ok(PlaybackSources {
        instrumental: allow(instrumental)?,
        vocals: allow(vocals)?,
        original: allow(original)?,
    })
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    }
}

// ---------------------------------------------------------------------------
// re-align a selection (PLAN.md §3: "re-run alignment on a selection")
// ---------------------------------------------------------------------------

/// Lazily-loaded windowed aligner, shared across re-align calls (the wav2vec2
/// session is ~360 MB of weights — load once, reuse). CPU EP only, by
/// [`WindowAligner`]'s design.
#[derive(Default)]
pub struct RealignState(Arc<Mutex<Option<WindowAligner>>>);

/// Longest window the interactive path will align. CPU cost is ~linear
/// (measured: 10 s window → 0.40 s wall, release, 8-core — alignment smoke
/// test); 120 s stays comfortably interactive while covering any sane
/// line-range selection.
const MAX_WINDOW_S: f64 = 120.0;

#[derive(Debug, Deserialize)]
pub struct RealignRequest {
    /// The vocal stem (the caller got it from `playback_sources` /
    /// the library row).
    pub vocals_path: String,
    /// Window bounds in original-song seconds (PLAN.md §5 time base).
    pub window_start: f64,
    pub window_end: f64,
    /// Display text of the selected words, in map order.
    pub words: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct RealignedWord {
    pub word: String,
    pub start: f64,
    pub end: f64,
    pub confidence: f32,
}

/// Re-run the CTC pass over just `[window_start, window_end]` of the vocal
/// stem with the selection's words. Returns new timings (original-song time,
/// monotonic); the frontend splices them into the editor state as one
/// undoable edit. Runs on a blocking thread — decode + inference take on the
/// order of a second.
#[tauri::command]
pub async fn realign_selection(
    state: State<'_, RealignState>,
    request: RealignRequest,
) -> Result<Vec<RealignedWord>, String> {
    if !(request.window_end > request.window_start) {
        return Err("re-align window is empty".into());
    }
    if request.window_end - request.window_start > MAX_WINDOW_S {
        return Err(format!(
            "selection window is {:.0}s — re-align works on selections up to {MAX_WINDOW_S:.0}s",
            request.window_end - request.window_start
        ));
    }
    if request.words.is_empty() {
        return Err("selection contains no words".into());
    }

    let aligner = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // 1:1 word mapping: each display word becomes exactly one LyricWord
        // (unalignable ones come back as zero-length placeholders).
        let words: Vec<anchor::LyricWord> = request
            .words
            .iter()
            .map(|w| anchor::LyricWord {
                display: w.clone(),
                norm: anchor::normalize_word(w),
            })
            .collect();

        let decoded = audio::decode_to_mono_16k(Path::new(&request.vocals_path))
            .map_err(|e| format!("decode vocal stem: {e}"))?;
        let s0 = ((request.window_start * SAMPLE_RATE as f64) as usize).min(decoded.samples.len());
        let s1 = ((request.window_end * SAMPLE_RATE as f64).ceil() as usize)
            .min(decoded.samples.len());
        if s1 <= s0 {
            return Err("re-align window is outside the vocal stem".into());
        }

        let mut guard = aligner.lock().map_err(|_| "aligner poisoned".to_string())?;
        if guard.is_none() {
            // Model root is the same directory the pipeline uses
            // (%LOCALAPPDATA%/karaoke/models); only wav2vec2/ loads.
            let threads = std::thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(4);
            *guard = Some(
                WindowAligner::load(&separation::default_model_dir(), threads)
                    .map_err(|e| e.to_string())?,
            );
        }
        let out = guard
            .as_mut()
            .expect("just loaded")
            .align_window(&decoded.samples[s0..s1], request.window_start, &words)
            .map_err(|e| e.to_string())?;
        Ok(out
            .into_iter()
            .map(|w| RealignedWord {
                word: w.word,
                start: w.start,
                end: w.end,
                confidence: w.confidence,
            })
            .collect())
    })
    .await
    .map_err(|e| format!("re-align task failed: {e}"))?
}

// ---------------------------------------------------------------------------
// save (fix editor → disk, atomically, with .bak)
// ---------------------------------------------------------------------------

/// Validate and persist an edited timing map. karaoke-core enforces the
/// invariants (original-song time base, monotonic onsets — `validate()`) and
/// writes atomically with a `.bak` of the previous map. Returns the saved
/// map's content hash for stale-export tracking.
#[tauri::command]
pub async fn save_timing_map(path: String, map: serde_json::Value) -> Result<String, String> {
    let raw = serde_json::to_string(&map).map_err(|e| e.to_string())?;
    // from_json re-checks the time_base — a map claiming any other time base
    // than original-song is refused here, same as everywhere (PLAN.md §5).
    let map = WordTimingMap::from_json(&raw).map_err(|e| e.to_string())?;
    map.save_atomic(Path::new(&path)).map_err(|e| e.to_string())?;
    let json = map.to_json_pretty().map_err(|e| e.to_string())?;
    Ok(sha256_hex(json.as_bytes()))
}

/// Mark a library song reviewed (preview's "Looks good", or a timing-fix
/// save) or clear the mark.
#[tauri::command]
pub async fn song_set_reviewed(
    library: State<'_, Arc<LibraryHandle>>,
    song_id: i64,
    reviewed: bool,
) -> Result<(), String> {
    library
        .lock()?
        .set_reviewed(song_id, reviewed)
        .map_err(|e| e.to_string())
}

/// One library row by id (the song route carries the id; the detail screen
/// needs `reviewed_at` and the stem paths without listing the whole library).
#[tauri::command]
pub async fn library_song(
    library: State<'_, Arc<LibraryHandle>>,
    song_id: i64,
) -> Result<Option<karaoke_core::library::Song>, String> {
    library.lock()?.song(song_id).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// export freshness sidecar
// ---------------------------------------------------------------------------

pub const EXPORTS_SIDECAR_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportRecord {
    pub path: PathBuf,
    /// sha256 of the timing-map JSON this export was rendered from.
    pub map_sha256: String,
    pub written_unix: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportsSidecar {
    pub version: u32,
    /// Keyed by format name ("lrc" | "ass" | "ultrastar").
    pub exports: std::collections::BTreeMap<String, ExportRecord>,
}

impl Default for ExportsSidecar {
    fn default() -> Self {
        Self {
            version: EXPORTS_SIDECAR_VERSION,
            exports: Default::default(),
        }
    }
}

/// `<dir>/song.exports.json` for `<dir>/song.align.json`.
pub fn sidecar_path(map_path: &Path) -> PathBuf {
    let stem = map_path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "song".into());
    let stem = stem.strip_suffix(".align").unwrap_or(&stem).to_string();
    map_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(format!("{stem}.exports.json"))
}

pub fn load_sidecar(map_path: &Path) -> ExportsSidecar {
    std::fs::read_to_string(sidecar_path(map_path))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Record that `formats` were just exported from map content `map_sha256`.
pub fn record_exports(
    map_path: &Path,
    map_sha256: &str,
    written: &[(String, PathBuf)],
) -> Result<(), String> {
    let mut sc = load_sidecar(map_path);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    for (fmt, path) in written {
        sc.exports.insert(
            fmt.clone(),
            ExportRecord {
                path: path.clone(),
                map_sha256: map_sha256.to_string(),
                written_unix: now,
            },
        );
    }
    let json = serde_json::to_string_pretty(&sc).map_err(|e| e.to_string())?;
    manifest::write_atomic(&sidecar_path(map_path), json.as_bytes()).map_err(|e| e.to_string())
}

#[derive(Debug, Serialize)]
pub struct ExportStatusEntry {
    pub path: PathBuf,
    pub map_sha256: String,
    pub written_unix: u64,
    /// The exported file still exists on disk.
    pub exists: bool,
}

#[derive(Debug, Serialize)]
pub struct ExportStatus {
    /// Hash of the map as it is on disk right now.
    pub current_map_sha256: String,
    pub exports: std::collections::BTreeMap<String, ExportStatusEntry>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sidecar_sits_beside_the_map_with_the_song_stem() {
        let p = sidecar_path(Path::new(r"C:\music\song-karaoke\song.align.json"));
        assert_eq!(p, PathBuf::from(r"C:\music\song-karaoke\song.exports.json"));
    }

    #[test]
    fn record_and_load_round_trip_tracks_map_hash_per_format() {
        let dir = std::env::temp_dir().join(format!("karaoke-exports-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let map_path = dir.join("song.align.json");

        record_exports(
            &map_path,
            "hash-1",
            &[("lrc".into(), dir.join("song.lrc"))],
        )
        .unwrap();
        // a later export from a changed map only touches its own format
        record_exports(
            &map_path,
            "hash-2",
            &[("ass".into(), dir.join("song.ass"))],
        )
        .unwrap();

        let sc = load_sidecar(&map_path);
        assert_eq!(sc.exports["lrc"].map_sha256, "hash-1");
        assert_eq!(sc.exports["ass"].map_sha256, "hash-2");
        assert_eq!(sc.exports.len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// Current map hash + per-format export records; the frontend derives
/// fresh/stale from the hash comparison (pure, vitest-covered).
#[tauri::command]
pub async fn export_status(map_path: String) -> Result<ExportStatus, String> {
    let map_path = PathBuf::from(&map_path);
    let raw = std::fs::read_to_string(&map_path)
        .map_err(|e| format!("cannot read timing map {}: {e}", map_path.display()))?;
    let sc = load_sidecar(&map_path);
    Ok(ExportStatus {
        current_map_sha256: sha256_hex(raw.as_bytes()),
        exports: sc
            .exports
            .into_iter()
            .map(|(fmt, r)| {
                let exists = r.path.is_file();
                (
                    fmt,
                    ExportStatusEntry {
                        path: r.path,
                        map_sha256: r.map_sha256,
                        written_unix: r.written_unix,
                        exists,
                    },
                )
            })
            .collect(),
    })
}
