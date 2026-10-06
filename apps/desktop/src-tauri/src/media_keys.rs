//! Hardware media keys and the OS "now playing" panel. A key press goes
//! to the Stage as a
//! `baritoad://media` event and the Stage decides what it means there (play
//! / pause, the next song in Up next, start over); the Stage tells the OS
//! what's on (`media_now_playing`).
//!
//! Windows: the System Media Transport Controls, attached to the main
//! window, through souvlaki (docs/DEPENDENCIES.md). It works whichever
//! window has focus, and doesn't take the keys from other apps the way a global
//! shortcut would. macOS and Linux get it with their releases (v1.x).

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime, State};

/// What the Stage hears when a media key is pressed.
pub const MEDIA_EVENT: &str = "baritoad://media";

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MediaKey {
    Play,
    Pause,
    Toggle,
    Next,
    Previous,
    Stop,
}

/// The controls, once attached (managed state; `None` where unavailable).
#[derive(Default)]
pub struct MediaKeys(Mutex<Option<souvlaki::MediaControls>>);

/// Attach to the main window. Best-effort: no media keys is no crash.
pub fn init<R: Runtime>(app: &AppHandle<R>, keys: &MediaKeys) {
    #[cfg(windows)]
    {
        use souvlaki::{MediaControlEvent, MediaControls, MediaPlayback, PlatformConfig};
        use tauri::{Emitter, Manager};

        let Some(main) = app.get_webview_window(crate::stage::MAIN_LABEL) else { return };
        let Ok(hwnd) = main.hwnd() else { return };
        let config = PlatformConfig {
            display_name: "baritoad",
            dbus_name: "baritoad",
            hwnd: Some(hwnd.0 as *mut std::ffi::c_void),
        };
        let mut controls = match MediaControls::new(config) {
            Ok(c) => c,
            Err(e) => return eprintln!("media keys unavailable: {e}"),
        };
        let to_stage = app.clone();
        let attached = controls.attach(move |event| {
            let key = match event {
                MediaControlEvent::Play => MediaKey::Play,
                MediaControlEvent::Pause => MediaKey::Pause,
                MediaControlEvent::Toggle => MediaKey::Toggle,
                MediaControlEvent::Next => MediaKey::Next,
                MediaControlEvent::Previous => MediaKey::Previous,
                MediaControlEvent::Stop => MediaKey::Stop,
                _ => return,
            };
            let _ = to_stage.emit_to(crate::stage::STAGE_LABEL, MEDIA_EVENT, key);
        });
        if let Err(e) = attached {
            return eprintln!("media keys unavailable: {e}");
        }
        let _ = controls.set_playback(MediaPlayback::Stopped);
        if let Ok(mut slot) = keys.0.lock() {
            *slot = Some(controls);
        }
    }
    #[cfg(not(windows))]
    let _ = (app, keys);
}

/// What the Stage is playing, for the OS panel.
#[derive(Debug, Deserialize)]
pub struct NowPlaying {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub duration_s: Option<f64>,
    /// "playing" | "paused" | "stopped".
    pub state: String,
    pub position_s: Option<f64>,
}

#[tauri::command]
pub async fn media_now_playing(keys: State<'_, MediaKeys>, now: NowPlaying) -> Result<(), String> {
    use souvlaki::{MediaMetadata, MediaPlayback, MediaPosition};
    use std::time::Duration;

    let Ok(mut slot) = keys.0.lock() else { return Ok(()) };
    let Some(controls) = slot.as_mut() else { return Ok(()) };
    let secs = |s: Option<f64>| s.filter(|v| v.is_finite() && *v >= 0.0).map(Duration::from_secs_f64);
    let progress = secs(now.position_s).map(MediaPosition);
    let playback = match now.state.as_str() {
        "playing" => MediaPlayback::Playing { progress },
        "paused" => MediaPlayback::Paused { progress },
        _ => MediaPlayback::Stopped,
    };
    if now.title.is_some() {
        controls
            .set_metadata(MediaMetadata {
                title: now.title.as_deref(),
                artist: now.artist.as_deref(),
                duration: secs(now.duration_s),
                ..Default::default()
            })
            .map_err(|e| e.to_string())?;
    }
    controls.set_playback(playback).map_err(|e| e.to_string())
}
