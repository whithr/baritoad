//! The Stage: the TV player's own window (Karascape 98).
//!
//! "Sing" opens — or reuses and focuses — a second frameless window (label
//! [`STAGE_LABEL`]) that can be dragged or sent to the TV while the main
//! window stays on the Library/Bench. The engine itself is unchanged: one
//! player host (player.rs), reused across songs; the stage window just hosts
//! the lyric view that drives it.
//!
//! Lifecycle rules (the load-bearing ones):
//! - Windows are created here, in Rust, from the `create: false` "player"
//!   config in tauri.conf.json — never from JS — and the command is `async`
//!   (a synchronous command that builds a window deadlocks on Windows).
//! - A second "Sing" reuses the window: the new route is stored in
//!   [`StageState`] and sent as a `load` event, so the window stays where it
//!   is (full-screen on the TV) and its WebView stays warm.
//! - Only Rust unloads the engine, when the stage window is destroyed. The
//!   stage's own view never calls `player_unload` on unmount: separate
//!   invokes aren't ordered, so a late Unload could silence the next song.
//! - Closing the main window closes the stage.

use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, Manager, Monitor, PhysicalPosition, Runtime, State, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, Window, WindowEvent,
};

use crate::player::PlayerHandle;

pub const STAGE_LABEL: &str = "player";
pub const MAIN_LABEL: &str = "main";
/// Stage lifecycle events: `load` → the stage, `opened` / `closed` → main.
pub const STAGE_EVENT: &str = "karascape://stage";

/// What the stage should play — the same fields as the `#/play` route.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct StageRoute {
    #[serde(default)]
    pub song_id: Option<i64>,
    #[serde(default)]
    pub map_path: Option<String>,
    #[serde(default)]
    pub measure: bool,
}

/// Where the stage window should go. Monitors are matched by name first,
/// then by their physical origin (names can repeat across identical TVs).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StageDisplay {
    #[serde(default)]
    pub name: Option<String>,
    pub x: i32,
    pub y: i32,
    #[serde(default)]
    pub fullscreen: bool,
}

#[derive(Default)]
pub struct StageState {
    route: Mutex<Option<StageRoute>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum StageEvent {
    Opened { route: StageRoute },
    Load { route: StageRoute },
    Closed,
}

/// Percent-encode a query value (RFC 3986 unreserved characters pass).
/// Map paths carry `\`, `:` and spaces; URLSearchParams decodes this.
fn enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// The stage window's start page: the app's `#/play` route.
pub fn stage_url(route: &StageRoute) -> String {
    let mut q: Vec<String> = Vec::new();
    if let Some(id) = route.song_id {
        q.push(format!("id={id}"));
    }
    if let Some(m) = &route.map_path {
        q.push(format!("map={}", enc(m)));
    }
    if route.measure {
        q.push("measure=1".into());
    }
    format!("index.html#/play?{}", q.join("&"))
}

/// Pick the monitor a saved display refers to: by name, then by origin.
fn pick_monitor<'a>(monitors: &'a [Monitor], d: &StageDisplay) -> Option<&'a Monitor> {
    d.name
        .as_ref()
        .and_then(|n| monitors.iter().find(|m| m.name() == Some(n)))
        .or_else(|| monitors.iter().find(|m| m.position().x == d.x && m.position().y == d.y))
}

/// Move the stage onto a display. Fullscreen happens on the window's
/// *current* monitor, and logical positions mis-scale across monitors with
/// different DPI, so: leave fullscreen, move in physical pixels, then
/// (optionally) go fullscreen again.
fn place_on<R: Runtime>(w: &WebviewWindow<R>, d: &StageDisplay, fallback: Option<Monitor>) -> tauri::Result<()> {
    let monitors = w.available_monitors()?;
    let target = match pick_monitor(&monitors, d).cloned().or(fallback) {
        Some(m) => m,
        None => return Ok(()),
    };
    let _ = w.unmaximize();
    let _ = w.set_fullscreen(false);
    let p = target.position();
    w.set_position(PhysicalPosition::new(p.x + 48, p.y + 48))?;
    if d.fullscreen {
        w.set_fullscreen(true)?;
    }
    Ok(())
}

fn main_monitor<R: Runtime>(app: &AppHandle<R>) -> Option<Monitor> {
    app.get_webview_window(MAIN_LABEL)
        .and_then(|m| m.current_monitor().ok().flatten())
}

/// Open the stage on `route`, or send the route to the stage that's already
/// open. `display` places a newly created window (a reused one stays put).
#[tauri::command]
pub async fn stage_open<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, StageState>,
    route: StageRoute,
    display: Option<StageDisplay>,
) -> Result<(), String> {
    *state.route.lock().map_err(|_| "stage state poisoned")? = Some(route.clone());
    let window = match app.get_webview_window(STAGE_LABEL) {
        Some(w) => {
            app.emit_to(STAGE_LABEL, STAGE_EVENT, StageEvent::Load { route: route.clone() })
                .map_err(|e| e.to_string())?;
            w
        }
        None => {
            let mut cfg = app
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == STAGE_LABEL)
                .cloned()
                .ok_or("tauri.conf.json has no \"player\" window")?;
            cfg.url = WebviewUrl::App(stage_url(&route).into());
            let w = WebviewWindowBuilder::from_config(&app, &cfg)
                .map_err(|e| e.to_string())?
                .build()
                .map_err(|e| e.to_string())?;
            if let Some(d) = &display {
                place_on(&w, d, main_monitor(&app)).map_err(|e| e.to_string())?;
            }
            w
        }
    };
    let _ = window.unminimize();
    window.show().map_err(|e| e.to_string())?;
    let _ = window.set_focus();
    let _ = app.emit_to(MAIN_LABEL, STAGE_EVENT, StageEvent::Opened { route });
    Ok(())
}

/// Move the open stage to another display ("Show on" in Player Options).
#[tauri::command]
pub async fn stage_show_on<R: Runtime>(app: AppHandle<R>, display: StageDisplay) -> Result<(), String> {
    let w = app.get_webview_window(STAGE_LABEL).ok_or("the stage isn't open")?;
    place_on(&w, &display, None).map_err(|e| e.to_string())
}

/// Hand focus to the other window (F6 in either one).
#[tauri::command]
pub async fn stage_focus<R: Runtime>(app: AppHandle<R>, label: String) -> Result<(), String> {
    if label != MAIN_LABEL && label != STAGE_LABEL {
        return Err(format!("no window {label:?}"));
    }
    let w = app.get_webview_window(&label).ok_or("that window isn't open")?;
    let _ = w.unminimize();
    w.set_focus().map_err(|e| e.to_string())
}

/// The route the stage should be showing (a freshly loaded stage asks, in
/// case a `load` was sent before its listener was attached).
#[tauri::command]
pub async fn stage_current(state: State<'_, StageState>) -> Result<Option<StageRoute>, String> {
    Ok(state.route.lock().map_err(|_| "stage state poisoned")?.clone())
}

/// Window lifecycle glue, registered with `Builder::on_window_event`.
pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if !matches!(event, WindowEvent::Destroyed) {
        return;
    }
    let app = window.app_handle();
    match window.label() {
        STAGE_LABEL => {
            if let Some(player) = app.try_state::<Arc<PlayerHandle>>() {
                player.unload_detached();
            }
            if let Some(state) = app.try_state::<StageState>() {
                if let Ok(mut r) = state.route.lock() {
                    *r = None;
                }
            }
            let _ = app.emit_to(MAIN_LABEL, STAGE_EVENT, StageEvent::Closed);
            if let Some(main) = app.get_webview_window(MAIN_LABEL) {
                let _ = main.set_focus();
            }
        }
        MAIN_LABEL => {
            if let Some(stage) = app.get_webview_window(STAGE_LABEL) {
                let _ = stage.destroy();
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stage_url_encodes_windows_map_paths() {
        let r = StageRoute {
            song_id: None,
            map_path: Some(r"C:\Users\me\My Songs\map.json".into()),
            measure: false,
        };
        assert_eq!(
            stage_url(&r),
            "index.html#/play?map=C%3A%5CUsers%5Cme%5CMy%20Songs%5Cmap.json"
        );
    }

    #[test]
    fn stage_url_carries_song_and_measure() {
        let r = StageRoute {
            song_id: Some(42),
            map_path: None,
            measure: true,
        };
        assert_eq!(stage_url(&r), "index.html#/play?id=42&measure=1");
    }

    #[test]
    fn enc_passes_unreserved_and_escapes_utf8() {
        assert_eq!(enc("a-b_c.d~e"), "a-b_c.d~e");
        assert_eq!(enc("é"), "%C3%A9");
        assert_eq!(enc("a&b=c"), "a%26b%3Dc");
    }

    #[test]
    fn stage_route_defaults_missing_fields() {
        let r: StageRoute = serde_json::from_str(r#"{"song_id": 7}"#).unwrap();
        assert_eq!(r, StageRoute { song_id: Some(7), map_path: None, measure: false });
    }
}
