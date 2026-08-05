//! Performance-player host (Phase 3 milestone 3): the karaoke_core cpal
//! engine wired into Tauri.
//!
//! ## Threading (the load-bearing fact)
//! [`karaoke_core::player::Player`] holds a `cpal::Stream`, which is **not
//! `Send`** — it can never live in Tauri managed state. Like the pipeline
//! worker (queue.rs), the whole `Player` lives on one dedicated thread
//! ("player-host") that owns it for the process lifetime; everything else
//! talks to it through a [`PlayerCmd`] mpsc channel. Commands are applied in
//! order; the few that need an answer (`Load`, `Unload`, `Status`) carry a
//! reply channel and the Tauri command awaits it on a blocking thread.
//!
//! ## Position transport (measured decision — see PlayerView.tsx)
//! Word highlighting runs at rAF rate (up to 120 Hz on this panel) but IPC
//! at that rate is unmeasured overhead, so the host emits a
//! [`PlayerEventPayload::Status`] on `karaoke://player` at ~10 Hz while
//! playing (plus immediately after every state-changing command), and the UI
//! interpolates between reports against `performance.now()`:
//! `est = base + dt·rate`, where `rate` is the tempo ratio while playing and
//! 0 while paused — valid because [`PlayerClock::position_seconds`] is
//! **original-song seconds** (PLAN.md §5) and advances at exactly the tempo
//! ratio per wall second during steady playback. Each report corrects the
//! interpolation; the measured correction magnitude is the transport's
//! jitter (reported in the milestone summary; playerClock.ts keeps stats).
//! The UI never translates through stretch ratios itself — the clock already
//! did (PLAN.md §5: timing maps store original-song time only).
//!
//! ## Song end
//! `PlayerEvent::Completed` is forwarded as `{kind: "completed"}`. With
//! stretch active it can lead the audible tail by ≤ ~120 ms (stretch.rs
//! module docs) — milestone 4's queue auto-advance must debounce on that;
//! this milestone's UI just lands in a paused-at-end state.

use std::path::PathBuf;
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use karaoke_core::player::{Player, PlayerEvent, StretchConfig, TransportState};

use crate::library::LibraryHandle;
use crate::review::resolve_song_sources;

/// Single event channel the player view subscribes to.
pub const PLAYER_EVENT: &str = "karaoke://player";

/// Status cadence while playing (the 10 Hz transport above).
const STATUS_PERIOD: Duration = Duration::from_millis(100);

/// UI-facing snapshot of the engine (fields the view actually renders plus
/// the Diagnostics subset the advanced flyout shows).
#[derive(Debug, Clone, Serialize)]
pub struct PlayerStatus {
    /// "stopped" | "playing" | "paused" | "finished" | "unloaded".
    pub state: &'static str,
    /// Original-song seconds (PlayerClock — the §5 time base).
    pub position: f64,
    pub duration: f64,
    pub guide: f32,
    pub pitch: f32,
    pub tempo: f64,
    /// "default" | "low_latency" (StretchConfig).
    pub stretch_config: &'static str,
    /// Library row backing the loaded song (None for manifest-resolved).
    pub song_id: Option<i64>,
    /// True when only the original mix is loaded (no stems → guide is inert).
    pub single_source: bool,
    pub device: Option<String>,
    // Diagnostics subset (diag.rs)
    pub callbacks: u64,
    pub stalls: u64,
    pub max_gap_ms: f64,
    pub stretch_engaged: bool,
    pub mmcss: &'static str,
}

/// Everything emitted on [`PLAYER_EVENT`].
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PlayerEventPayload {
    /// Periodic + after-command state report (the position transport).
    Status { status: PlayerStatus },
    /// Song played to the end (may lead the audible tail — module docs).
    Completed { position: f64 },
}

pub enum PlayerCmd {
    Load {
        instrumental: Option<PathBuf>,
        vocals: Option<PathBuf>,
        original: Option<PathBuf>,
        song_id: Option<i64>,
        autoplay: bool,
        reply: Sender<Result<PlayerStatus, String>>,
    },
    Play,
    Pause,
    Stop,
    Seek(f64),
    SetGuide(f32),
    SetPitch(f32),
    SetTempo(f64),
    SetStretchConfig(StretchConfig),
    Status(Sender<Result<PlayerStatus, String>>),
    /// Drop the engine (closes the output stream); leaving the player view.
    Unload(Sender<()>),
}

/// Managed handle: just the command-channel sender.
pub struct PlayerHandle {
    tx: Mutex<Sender<PlayerCmd>>,
}

impl PlayerHandle {
    pub fn send(&self, cmd: PlayerCmd) -> Result<(), String> {
        self.tx
            .lock()
            .map_err(|_| "player channel poisoned".to_string())?
            .send(cmd)
            .map_err(|_| "player host thread is gone".to_string())
    }
}

/// Spawn the host thread; call once at setup. Returns the managed handle.
pub fn spawn_host(app: AppHandle) -> Arc<PlayerHandle> {
    let (tx, rx) = channel();
    std::thread::Builder::new()
        .name("player-host".into())
        .spawn(move || run_host(app, rx))
        .expect("spawn player host");
    Arc::new(PlayerHandle { tx: Mutex::new(tx) })
}

/// Host state: the (!Send) engine plus what the engine doesn't know.
struct Host {
    player: Option<Player>,
    events: Option<Receiver<PlayerEvent>>,
    song_id: Option<i64>,
    single_source: bool,
}

impl Host {
    fn status(&self) -> PlayerStatus {
        match &self.player {
            None => PlayerStatus {
                state: "unloaded",
                position: 0.0,
                duration: 0.0,
                guide: 0.0,
                pitch: 0.0,
                tempo: 1.0,
                stretch_config: "default",
                song_id: None,
                single_source: false,
                device: None,
                callbacks: 0,
                stalls: 0,
                max_gap_ms: 0.0,
                stretch_engaged: false,
                mmcss: "not_attempted",
            },
            Some(p) => {
                let d = p.diagnostics();
                PlayerStatus {
                    state: match p.state() {
                        TransportState::Stopped => "stopped",
                        TransportState::Playing => "playing",
                        TransportState::Paused => "paused",
                        TransportState::Finished => "finished",
                    },
                    position: p.clock().position_seconds(),
                    duration: p.duration_seconds(),
                    guide: p.vocal_guide(),
                    pitch: p.pitch_semitones(),
                    tempo: p.tempo_rate(),
                    stretch_config: match p.stretch_config() {
                        StretchConfig::PresetDefault => "default",
                        StretchConfig::LowLatency40x10 => "low_latency",
                    },
                    song_id: self.song_id,
                    single_source: self.single_source,
                    device: Some(p.device_info().name.clone()),
                    callbacks: d.callbacks,
                    stalls: d.stalls,
                    max_gap_ms: d.max_gap_ms,
                    stretch_engaged: d.stretch_engaged,
                    mmcss: match d.mmcss {
                        karaoke_core::player::MmcssStatus::NotAttempted => "not_attempted",
                        karaoke_core::player::MmcssStatus::Registered => "registered",
                        karaoke_core::player::MmcssStatus::Failed => "failed",
                        karaoke_core::player::MmcssStatus::Unsupported => "unsupported",
                    },
                }
            }
        }
    }

    fn playing(&self) -> bool {
        self.player
            .as_ref()
            .map(|p| p.state() == TransportState::Playing)
            .unwrap_or(false)
    }
}

fn run_host(app: AppHandle, rx: Receiver<PlayerCmd>) {
    let mut host = Host {
        player: None,
        events: None,
        song_id: None,
        single_source: false,
    };

    loop {
        let cmd = rx.recv_timeout(STATUS_PERIOD);

        // Forward engine events first so a Completed never trails the status
        // that already says "finished".
        if let Some(events) = &host.events {
            while let Ok(PlayerEvent::Completed) = events.try_recv() {
                let position = host
                    .player
                    .as_ref()
                    .map(|p| p.clock().position_seconds())
                    .unwrap_or(0.0);
                let _ = app.emit(PLAYER_EVENT, PlayerEventPayload::Completed { position });
                emit_status(&app, &host);
            }
        }

        match cmd {
            Err(RecvTimeoutError::Timeout) => {
                if host.playing() {
                    emit_status(&app, &host);
                }
            }
            Err(RecvTimeoutError::Disconnected) => return,
            Ok(cmd) => {
                let emit = handle_cmd(&mut host, cmd);
                if emit {
                    emit_status(&app, &host);
                }
            }
        }
    }
}

fn emit_status(app: &AppHandle, host: &Host) {
    let _ = app.emit(
        PLAYER_EVENT,
        PlayerEventPayload::Status {
            status: host.status(),
        },
    );
}

/// Apply one command. Returns true when a status event should follow (every
/// state-changing command reports promptly so UI interpolation re-bases).
fn handle_cmd(host: &mut Host, cmd: PlayerCmd) -> bool {
    match cmd {
        PlayerCmd::Load {
            instrumental,
            vocals,
            original,
            song_id,
            autoplay,
            reply,
        } => {
            let result = do_load(host, instrumental, vocals, original, song_id, autoplay);
            let _ = reply.send(result);
            true
        }
        PlayerCmd::Play => {
            if let Some(p) = &host.player {
                p.play();
            }
            true
        }
        PlayerCmd::Pause => {
            if let Some(p) = &host.player {
                p.pause();
            }
            true
        }
        PlayerCmd::Stop => {
            if let Some(p) = &host.player {
                p.stop();
            }
            true
        }
        PlayerCmd::Seek(t) => {
            if let Some(p) = &host.player {
                p.seek(t);
            }
            true
        }
        PlayerCmd::SetGuide(g) => {
            if let Some(p) = &host.player {
                p.set_vocal_guide(g);
            }
            true
        }
        PlayerCmd::SetPitch(st) => {
            if let Some(p) = &host.player {
                p.set_pitch_semitones(st);
            }
            true
        }
        PlayerCmd::SetTempo(r) => {
            if let Some(p) = &host.player {
                p.set_tempo_rate(r);
            }
            true
        }
        PlayerCmd::SetStretchConfig(c) => {
            if let Some(p) = &host.player {
                p.set_stretch_config(c);
            }
            true
        }
        PlayerCmd::Status(reply) => {
            let _ = reply.send(Ok(host.status()));
            false
        }
        PlayerCmd::Unload(reply) => {
            host.player = None; // drops the cpal stream
            host.events = None;
            host.song_id = None;
            host.single_source = false;
            let _ = reply.send(());
            true
        }
    }
}

fn do_load(
    host: &mut Host,
    instrumental: Option<PathBuf>,
    vocals: Option<PathBuf>,
    original: Option<PathBuf>,
    song_id: Option<i64>,
    autoplay: bool,
) -> Result<PlayerStatus, String> {
    // Engine is created lazily on first load (a machine with no output device
    // can still browse the library) and reused after — the negotiated stream
    // config and stretch/guide settings persist across songs by design.
    if host.player.is_none() {
        let mut p = Player::new().map_err(|e| e.to_string())?;
        host.events = p.take_events();
        host.player = Some(p);
    }
    let p = host.player.as_mut().expect("just ensured");

    // Prefer the stem pair (real karaoke mode); fall back to the original mix
    // when separation outputs are gone (guide becomes inert — status says so).
    let existing = |o: Option<PathBuf>| o.filter(|q| q.is_file());
    let (inst, voc, orig) = (existing(instrumental), existing(vocals), existing(original));
    match (&inst, &voc) {
        (Some(i), Some(v)) => {
            p.load_stems(i, v).map_err(|e| e.to_string())?;
            host.single_source = false;
        }
        _ => {
            let o = orig.ok_or_else(|| {
                "no playable audio: stems and original file are all missing".to_string()
            })?;
            p.load_single(&o).map_err(|e| e.to_string())?;
            host.single_source = true;
        }
    }
    host.song_id = song_id;
    if autoplay {
        p.play();
    }
    Ok(host.status())
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

fn roundtrip<T: Send + 'static>(
    handle: &PlayerHandle,
    make: impl FnOnce(Sender<T>) -> PlayerCmd,
) -> Result<Receiver<T>, String> {
    let (tx, rx) = channel();
    handle.send(make(tx))?;
    Ok(rx)
}

async fn await_reply<T: Send + 'static>(rx: Receiver<T>) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || rx.recv().map_err(|_| "player host dropped the reply".to_string()))
        .await
        .map_err(|e| format!("player reply task failed: {e}"))?
}

/// Load a song into the performance player. Resolution goes through the same
/// trusted records as the review player (`resolve_song_sources`): a library
/// row or the job manifest that owns the map. Marks the library row played
/// (autoplay is the entry-point contract — Play on a card starts singing).
#[tauri::command]
pub async fn player_load(
    library: State<'_, Arc<LibraryHandle>>,
    player: State<'_, Arc<PlayerHandle>>,
    song_id: Option<i64>,
    map_path: Option<String>,
    autoplay: Option<bool>,
) -> Result<PlayerStatus, String> {
    let (inst, voc, orig) = resolve_song_sources(&library, song_id, map_path.as_deref())?;
    let autoplay = autoplay.unwrap_or(true);
    let rx = roundtrip(&player, |reply| PlayerCmd::Load {
        instrumental: inst,
        vocals: voc,
        original: orig,
        song_id,
        autoplay,
        reply,
    })?;
    let status = await_reply(rx).await??;
    if autoplay {
        if let Some(id) = song_id {
            // Best-effort: play stats must never fail playback.
            if let Ok(store) = library.lock() {
                let _ = store.record_played(id);
            }
        }
    }
    Ok(status)
}

#[tauri::command]
pub async fn player_play(player: State<'_, Arc<PlayerHandle>>) -> Result<(), String> {
    player.send(PlayerCmd::Play)
}

#[tauri::command]
pub async fn player_pause(player: State<'_, Arc<PlayerHandle>>) -> Result<(), String> {
    player.send(PlayerCmd::Pause)
}

#[tauri::command]
pub async fn player_stop(player: State<'_, Arc<PlayerHandle>>) -> Result<(), String> {
    player.send(PlayerCmd::Stop)
}

/// Seek to `position` (original-song seconds — the only time base the UI
/// speaks; the engine's clock does all stretch translation, PLAN.md §5).
#[tauri::command]
pub async fn player_seek(player: State<'_, Arc<PlayerHandle>>, position: f64) -> Result<(), String> {
    player.send(PlayerCmd::Seek(position))
}

#[tauri::command]
pub async fn player_set_guide(player: State<'_, Arc<PlayerHandle>>, gain: f32) -> Result<(), String> {
    player.send(PlayerCmd::SetGuide(gain))
}

#[tauri::command]
pub async fn player_set_pitch(
    player: State<'_, Arc<PlayerHandle>>,
    semitones: f32,
) -> Result<(), String> {
    player.send(PlayerCmd::SetPitch(semitones))
}

#[tauri::command]
pub async fn player_set_tempo(player: State<'_, Arc<PlayerHandle>>, rate: f64) -> Result<(), String> {
    player.send(PlayerCmd::SetTempo(rate))
}

/// `config`: "default" | "low_latency" (advanced flyout).
#[tauri::command]
pub async fn player_set_stretch_config(
    player: State<'_, Arc<PlayerHandle>>,
    config: String,
) -> Result<(), String> {
    let c = match config.as_str() {
        "default" => StretchConfig::PresetDefault,
        "low_latency" => StretchConfig::LowLatency40x10,
        other => return Err(format!("unknown stretch config '{other}'")),
    };
    player.send(PlayerCmd::SetStretchConfig(c))
}

#[tauri::command]
pub async fn player_status(player: State<'_, Arc<PlayerHandle>>) -> Result<PlayerStatus, String> {
    let rx = roundtrip(&player, PlayerCmd::Status)?;
    await_reply(rx).await?
}

/// Drop the engine (leaving the player view releases the output stream).
#[tauri::command]
pub async fn player_unload(player: State<'_, Arc<PlayerHandle>>) -> Result<(), String> {
    let rx = roundtrip(&player, PlayerCmd::Unload)?;
    await_reply(rx).await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// dev measurement harness (perf convention: measured numbers, CLAUDE.md)
// ---------------------------------------------------------------------------

/// Plan for an automated render/transport measurement run. Entirely inert
/// unless the app was *launched* with `KARAOKE_MEASURE_*` env vars — a normal
/// user can never trigger it, and it only ever writes to the path the
/// launcher chose. Local files only (no telemetry — CLAUDE.md hard rules).
#[derive(Debug, Clone, Serialize)]
pub struct MeasurePlan {
    pub song_id: Option<i64>,
    pub map_path: Option<String>,
    pub seconds: f64,
    pub out_path: String,
    /// Optional stretch settings the harness applies before measuring, so a
    /// run can cover the engaged-stretcher path (rate ≠ 1 interpolation).
    pub pitch: Option<f32>,
    pub tempo: Option<f64>,
    /// Measure in fullscreen (the TV-output configuration).
    pub fullscreen: bool,
}

#[tauri::command]
pub async fn measure_plan() -> Result<Option<MeasurePlan>, String> {
    let out_path = match std::env::var("KARAOKE_MEASURE_OUT") {
        Ok(p) if !p.is_empty() => p,
        _ => return Ok(None),
    };
    let song_id = std::env::var("KARAOKE_MEASURE_SONG_ID")
        .ok()
        .and_then(|s| s.parse().ok());
    let map_path = std::env::var("KARAOKE_MEASURE_MAP").ok().filter(|s| !s.is_empty());
    if song_id.is_none() && map_path.is_none() {
        return Ok(None);
    }
    let seconds = std::env::var("KARAOKE_MEASURE_SECONDS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(30.0);
    let pitch = std::env::var("KARAOKE_MEASURE_PITCH")
        .ok()
        .and_then(|s| s.parse().ok());
    let tempo = std::env::var("KARAOKE_MEASURE_TEMPO")
        .ok()
        .and_then(|s| s.parse().ok());
    Ok(Some(MeasurePlan {
        song_id,
        map_path,
        seconds,
        out_path,
        pitch,
        tempo,
        fullscreen: std::env::var("KARAOKE_MEASURE_FULLSCREEN")
            .map(|v| v == "1")
            .unwrap_or(false),
    }))
}

/// Write the harness results JSON to the launcher-chosen path (refused when
/// the env var is absent — see [`measure_plan`]).
#[tauri::command]
pub async fn measure_write(json: String) -> Result<(), String> {
    let out = std::env::var("KARAOKE_MEASURE_OUT")
        .map_err(|_| "measurement mode is not active".to_string())?;
    std::fs::write(&out, json).map_err(|e| format!("cannot write {out}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_host() -> Host {
        Host {
            player: None,
            events: None,
            song_id: None,
            single_source: false,
        }
    }

    #[test]
    fn unloaded_status_is_inert_and_well_formed() {
        let s = empty_host().status();
        assert_eq!(s.state, "unloaded");
        assert_eq!(s.position, 0.0);
        assert_eq!(s.duration, 0.0);
        assert_eq!(s.tempo, 1.0);
        assert!(s.song_id.is_none());
        // Serializes cleanly for the event channel.
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(json["state"], "unloaded");
    }

    #[test]
    fn transport_commands_without_a_player_are_safe_noops_that_still_report() {
        let mut host = empty_host();
        for cmd in [
            PlayerCmd::Play,
            PlayerCmd::Pause,
            PlayerCmd::Stop,
            PlayerCmd::Seek(12.0),
            PlayerCmd::SetGuide(0.5),
            PlayerCmd::SetPitch(3.0),
            PlayerCmd::SetTempo(0.9),
            PlayerCmd::SetStretchConfig(StretchConfig::LowLatency40x10),
        ] {
            // Every state-changing command asks for a status emit (the UI
            // interpolation re-bases on it).
            assert!(handle_cmd(&mut host, cmd));
        }
        assert!(host.player.is_none());
    }

    #[test]
    fn status_command_replies_without_emitting() {
        let mut host = empty_host();
        let (tx, rx) = channel();
        let emit = handle_cmd(&mut host, PlayerCmd::Status(tx));
        assert!(!emit, "status is read-only: no event churn");
        let s = rx.try_recv().unwrap().unwrap();
        assert_eq!(s.state, "unloaded");
    }

    #[test]
    fn unload_clears_host_state_and_replies() {
        let mut host = empty_host();
        host.song_id = Some(7);
        host.single_source = true;
        let (tx, rx) = channel();
        assert!(handle_cmd(&mut host, PlayerCmd::Unload(tx)));
        rx.try_recv().unwrap();
        assert!(host.song_id.is_none());
        assert!(!host.single_source);
    }

    #[test]
    fn load_with_nothing_playable_reports_the_error() {
        let mut host = empty_host();
        let missing = PathBuf::from(r"C:\definitely\not\here.wav");
        // Player::new() may fail on CI boxes with no audio device — both the
        // device error and the no-playable-audio error are Err outcomes; the
        // contract under test is "Load never panics and always replies".
        let (tx, rx) = channel();
        let _ = handle_cmd(
            &mut host,
            PlayerCmd::Load {
                instrumental: Some(missing.clone()),
                vocals: None,
                original: Some(missing),
                song_id: Some(1),
                autoplay: true,
                reply: tx,
            },
        );
        let result = rx.try_recv().unwrap();
        assert!(result.is_err());
    }
}
