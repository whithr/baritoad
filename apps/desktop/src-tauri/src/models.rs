//! The model packs in the app (karaoke-core `models`): what's on disk, one
//! download at a time on its own thread with progress on `karaoke://models`,
//! cancel, and the check every import makes first. Downloads happen only
//! when the person asks.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use karaoke_core::models::{self, ModelStatus, Pack, PackStatus, Progress};
use karaoke_core::separation;

pub const MODELS_EVENT: &str = "karaoke://models";

/// The running download's cancel flag, if one is running.
#[derive(Default)]
pub struct ModelDownloads {
    running: Mutex<Option<Arc<AtomicBool>>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ModelEvent {
    Progress { progress: Progress },
    Done { pack: Pack },
    Failed { pack: Pack, message: String },
    Cancelled { pack: Pack },
    /// The download thread is done (after its last Done/Failed/Cancelled).
    Finished,
}

#[derive(Debug, Serialize)]
pub struct ModelsInfo {
    pub packs: Vec<PackStatus>,
    /// The same files by model, in download order — what the dialogs list.
    pub models: Vec<ModelStatus>,
    /// Where downloads come from (said plainly in the dialog).
    pub mirror: String,
    pub downloading: bool,
}

fn dir() -> std::path::PathBuf {
    separation::default_model_dir()
}

#[tauri::command]
pub async fn models_status(downloads: State<'_, Arc<ModelDownloads>>) -> Result<ModelsInfo, String> {
    let downloading = downloads.running.lock().map(|r| r.is_some()).unwrap_or(false);
    Ok(ModelsInfo { packs: models::status(&dir()), models: models::model_status(&dir()), mirror: models::mirror_base(), downloading })
}

/// Download these packs, in order, on a background thread.
#[tauri::command]
pub async fn models_download(
    app: AppHandle,
    downloads: State<'_, Arc<ModelDownloads>>,
    packs: Vec<Pack>,
) -> Result<(), String> {
    let cancel = {
        let mut running = downloads.running.lock().map_err(|_| "download state poisoned")?;
        if running.is_some() {
            return Err("a download is already running".into());
        }
        let c = Arc::new(AtomicBool::new(false));
        *running = Some(c.clone());
        c
    };
    let state = downloads.inner().clone();
    let user_agent = crate::tools::user_agent(&app);
    std::thread::Builder::new()
        .name("model-download".into())
        .spawn(move || {
            let base = models::mirror_base();
            for pack in packs {
                let mut last = Instant::now() - Duration::from_secs(1);
                let r = models::download_pack(&dir(), pack, &base, &user_agent, &cancel, &mut |p| {
                    // ~10 updates a second is plenty for a progress bar.
                    if last.elapsed() >= Duration::from_millis(100) || p.model_done == p.model_total {
                        last = Instant::now();
                        let _ = app.emit(MODELS_EVENT, ModelEvent::Progress { progress: p.clone() });
                    }
                });
                let ev = match r {
                    Ok(()) => ModelEvent::Done { pack },
                    Err(karaoke_core::Error::Cancelled) => ModelEvent::Cancelled { pack },
                    Err(e) => ModelEvent::Failed { pack, message: e.to_string() },
                };
                let stop = !matches!(ev, ModelEvent::Done { .. });
                let _ = app.emit(MODELS_EVENT, ev);
                if stop {
                    break;
                }
            }
            if let Ok(mut running) = state.running.lock() {
                *running = None;
            }
            let _ = app.emit(MODELS_EVENT, ModelEvent::Finished);
        })
        .map_err(|e| format!("couldn't start the download: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn models_cancel(downloads: State<'_, Arc<ModelDownloads>>) -> Result<(), String> {
    if let Ok(running) = downloads.running.lock() {
        if let Some(c) = running.as_ref() {
            c.store(true, Ordering::Relaxed);
        }
    }
    Ok(())
}

fn mb(pack: Pack) -> u64 {
    models::manifest().files.iter().filter(|f| f.pack == pack).map(|f| f.size).sum::<u64>() / 1_000_000
}

/// Before an import is queued: are the packs it needs on disk? `None` when
/// they are; otherwise what to tell the person. The UI checks first and
/// offers the download; this is the backstop.
pub fn missing_for(needs_transcription: bool, hq: bool) -> Option<String> {
    let st = models::status(&dir());
    let usable = |p: Pack| st.iter().any(|s| s.pack == p && s.usable);
    if !usable(Pack::Core) {
        return Some(format!(
            "Demucs v4 and wav2vec 2.0 aren't downloaded yet ({} MB). Download them in Tools › Models.",
            mb(Pack::Core)
        ));
    }
    if hq && !usable(Pack::HighQuality) {
        return Some(format!(
            "High-quality separation needs Demucs v4, fine-tuned ({} MB). Download it in Tools › Models, or untick High-quality separation.",
            mb(Pack::HighQuality)
        ));
    }
    if needs_transcription && !usable(Pack::Transcription) {
        return Some(format!(
            "Songs without lyrics need Whisper small ({} MB). Download it in Tools › Models, or paste the lyrics.",
            mb(Pack::Transcription)
        ));
    }
    None
}
