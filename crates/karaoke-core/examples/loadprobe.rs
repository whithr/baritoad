//! Dev probe for player load latency. Measures the streaming load path's
//! time-to-first-audio and time-to-fully-loaded (and, with `--full`, the old
//! full decode+resample path for a baseline). Not shipped; run with
//!   cargo run -p karaoke-core --example loadprobe -- [--full] <instrumental> <vocals>

use std::path::Path;
use std::time::{Duration, Instant};

use karaoke_core::audio;
use karaoke_core::player::Player;

fn main() {
    let mut full = false;
    let mut paths: Vec<String> = Vec::new();
    for a in std::env::args().skip(1) {
        if a == "--full" {
            full = true;
        } else {
            paths.push(a);
        }
    }
    let (inst, voc) = match paths.as_slice() {
        [i, v] => (i.clone(), v.clone()),
        _ => {
            eprintln!("usage: loadprobe [--full] <instrumental> <vocals>");
            std::process::exit(2);
        }
    };
    let t = Instant::now();

    eprintln!("[{:>8.3?}] Player::new (device open + negotiate)...", t.elapsed());
    let mut p = Player::new().expect("Player::new");
    eprintln!("[{:>8.3?}] device: {:?}", t.elapsed(), p.device_info());

    if full {
        // Baseline: the old fully-eager path (decode all, resample all, then
        // build the stream).
        eprintln!("[{:>8.3?}] FULL PATH: decode instrumental...", t.elapsed());
        let inst_audio = audio::decode_to_stereo_44k(Path::new(&inst)).expect("decode inst");
        eprintln!("[{:>8.3?}] decode vocals...", t.elapsed());
        let voc_audio = audio::decode_to_stereo_44k(Path::new(&voc)).expect("decode voc");
        eprintln!(
            "[{:>8.3?}] load_decoded (resample + stream build + play)...",
            t.elapsed()
        );
        p.load_decoded(inst_audio, Some(voc_audio)).expect("load_decoded");
        eprintln!(
            "[{:>8.3?}] loaded: dur {:.2}s — time-to-first-audio == time-to-fully-loaded here",
            t.elapsed(),
            p.duration_seconds()
        );
        p.play();
        std::thread::sleep(Duration::from_secs(2));
        eprintln!(
            "[{:>8.3?}] after 2s play: clock {:.3}s, diag {:?}",
            t.elapsed(),
            p.clock().position_seconds(),
            p.diagnostics()
        );
        return;
    }

    eprintln!("[{:>8.3?}] load_stems (streaming)...", t.elapsed());
    let t_load = Instant::now();
    p.load_stems(Path::new(&inst), Path::new(&voc)).expect("load_stems");
    let tta = t_load.elapsed().as_secs_f64();
    eprintln!(
        "[{:>8.3?}] load returned: TIME-TO-FIRST-AUDIO {:.3} s (primed {:.2} s / {:.2} s)",
        t.elapsed(),
        tta,
        p.loaded_seconds(),
        p.duration_seconds()
    );

    p.play();
    let t_play = Instant::now();

    // Playback runs while the background fill finishes.
    loop {
        if p.loaded_seconds() >= p.duration_seconds() {
            break;
        }
        if let Some(e) = p.fill_error() {
            eprintln!("[{:>8.3?}] FILL ERROR: {e}", t.elapsed());
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    eprintln!(
        "[{:>8.3?}] TIME-TO-FULLY-LOADED {:.3} s after load start ({:.2} s available)",
        t.elapsed(),
        t_load.elapsed().as_secs_f64(),
        p.loaded_seconds()
    );

    // Glitch check at t≈0: keep playing to 2 s total and report diagnostics
    // (stalls must stay 0; starved_frames must stay 0 without seeks).
    if t_play.elapsed() < Duration::from_secs(2) {
        std::thread::sleep(Duration::from_secs(2) - t_play.elapsed());
    }
    eprintln!(
        "[{:>8.3?}] after {:.2}s play: clock {:.3}s, diag {:?}",
        t.elapsed(),
        t_play.elapsed().as_secs_f64(),
        p.clock().position_seconds(),
        p.diagnostics()
    );
}
