//! Real-device playback smoke test (Phase 3 milestone 1).
//!
//! `#[ignore]`d: it plays audio on the default output device for ~30 s and
//! is meaningless on CI. Run on a dev box with:
//!
//! ```text
//! cargo test -p karaoke-core --release --test player_smoke -- --ignored --nocapture
//! ```
//!
//! Sources are deterministic generated sines by default (nothing committed,
//! nothing copyrighted — CLAUDE.md hard rule). Set `KARAOKE_SMOKE_STEMS` to a
//! directory containing `instrumental.wav` + `vocals.wav` (e.g. the local
//! separation-spike output) to smoke real stems instead.
//!
//! Click-freedom of the guide ramp is asserted by rendered-buffer inspection
//! in the mixer unit tests (mock sink), not by ear here; this test verifies
//! the real-device integration: device negotiation, clock-vs-wall-clock
//! tracking, seek, pause, completion event, and callback-health numbers.

use std::time::{Duration, Instant};

use karaoke_core::audio::DecodedAudio;
use karaoke_core::player::{Player, PlayerEvent, TransportState};

fn sine_decoded(hz: f32, secs: f64, amp: f32) -> DecodedAudio {
    let n = (secs * 44_100.0) as usize;
    let ch: Vec<f32> = (0..n)
        .map(|i| amp * (2.0 * std::f32::consts::PI * hz * i as f32 / 44_100.0).sin())
        .collect();
    let mut samples = ch.clone();
    samples.extend_from_slice(&ch);
    DecodedAudio {
        samples,
        len: n,
        source_sample_rate: 44_100,
        source_channels: 2,
        notes: vec![],
    }
}

#[test]
#[ignore = "plays ~30 s of audio on the default output device"]
fn playback_smoke_30s() {
    let mut player = Player::new().expect("open default output device");
    let info = player.device_info().clone();
    println!(
        "device: {} | {} Hz | {} ch | {} | buffer {}",
        info.name, info.sample_rate, info.channels, info.sample_format, info.buffer
    );

    // 30 s song: quiet sines by default, real stems when pointed at some.
    let load0 = Instant::now();
    match std::env::var("KARAOKE_SMOKE_STEMS") {
        Ok(dir) => {
            let dir = std::path::PathBuf::from(dir);
            println!("using real stems from {}", dir.display());
            player
                .load_stems(&dir.join("instrumental.wav"), &dir.join("vocals.wav"))
                .expect("load stems");
        }
        Err(_) => {
            println!("using generated sine stems (set KARAOKE_SMOKE_STEMS for real stems)");
            let inst = sine_decoded(220.0, 30.0, 0.15);
            let voc = sine_decoded(440.0, 30.0, 0.15);
            player.load_decoded(inst, Some(voc)).expect("load sines");
        }
    }
    let dur = player.duration_seconds();
    println!(
        "load (decode + resample to device rate + stream build): {:.0} ms",
        load0.elapsed().as_secs_f64() * 1000.0
    );
    println!("duration: {dur:.3} s (original-song time)");
    assert!(dur > 26.0, "want ~30 s of material, got {dur:.1}");

    let events = player.take_events().expect("events receiver");
    let clock = player.clock();
    player.set_vocal_guide(0.0);
    player.play();
    assert_eq!(player.state(), TransportState::Playing);

    // Phase 1 (0–6 s wall): plain playback; clock must track wall time at
    // 1.0x (both derive from the same device rate; drift means the clock is
    // not frame-derived).
    let wall0 = Instant::now();
    let pos0 = clock.position_seconds();
    std::thread::sleep(Duration::from_secs(6));
    let wall_elapsed = wall0.elapsed().as_secs_f64();
    let clock_elapsed = clock.position_seconds() - pos0;
    let rate_ratio = clock_elapsed / wall_elapsed;
    println!(
        "clock vs wall over {wall_elapsed:.2} s: clock advanced {clock_elapsed:.3} s (ratio {rate_ratio:.4})"
    );
    assert!(
        (rate_ratio - 1.0).abs() < 0.02,
        "clock drift vs wall: ratio {rate_ratio:.4}"
    );

    // Phase 2: vocal-guide changes mid-playback (audible as the 440 Hz tone
    // blending in; click-freedom is asserted in mixer unit tests).
    player.set_vocal_guide(1.0);
    std::thread::sleep(Duration::from_secs(3));
    player.set_vocal_guide(0.25);
    std::thread::sleep(Duration::from_secs(3));

    // Phase 3: pause freezes the clock.
    player.pause();
    std::thread::sleep(Duration::from_millis(300)); // let the ramp settle
    let paused_pos = clock.position_seconds();
    std::thread::sleep(Duration::from_secs(2));
    let paused_pos2 = clock.position_seconds();
    println!("paused at {paused_pos:.3} s; after 2 s wall: {paused_pos2:.3} s");
    assert!(
        (paused_pos2 - paused_pos).abs() < 1e-9,
        "clock advanced while paused"
    );
    assert_eq!(player.state(), TransportState::Paused);

    // Phase 4: sample-accurate seek while paused, then resume.
    player.seek(5.0);
    std::thread::sleep(Duration::from_millis(200));
    let after_seek = clock.position_seconds();
    println!("seek(5.0) while paused -> clock reads {after_seek:.6} s");
    assert!(
        (after_seek - 5.0).abs() < 1e-6,
        "seek landed at {after_seek}"
    );
    player.play();
    std::thread::sleep(Duration::from_secs(4));
    let resumed = clock.position_seconds();
    println!("4 s after resume: {resumed:.3} s");
    assert!((resumed - 9.0).abs() < 0.25, "resume tracking off: {resumed}");

    // Phase 5: seek near the end and run to completion.
    player.seek(dur - 3.0);
    let completed = events
        .recv_timeout(Duration::from_secs(8))
        .expect("completion event within 8 s of seeking to end-3s");
    assert_eq!(completed, PlayerEvent::Completed);
    assert_eq!(player.state(), TransportState::Finished);
    let end_pos = clock.position_seconds();
    println!("completed; clock at {end_pos:.3} s of {dur:.3} s");
    assert!((end_pos - dur).abs() < 0.05, "end position {end_pos}");

    // Callback-health numbers (measured-numbers convention).
    let d = player.diagnostics();
    println!(
        "diagnostics: {} callbacks, {} stalls, max callback gap {:.2} ms, {} cpal-reported errors, mmcss {:?}",
        d.callbacks, d.stalls, d.max_gap_ms, d.stream_errors, d.mmcss
    );
    assert!(d.callbacks > 100, "suspiciously few callbacks: {}", d.callbacks);
    #[cfg(windows)]
    assert_eq!(
        d.mmcss,
        karaoke_core::player::MmcssStatus::Registered,
        "MMCSS registration failed on Windows"
    );
    assert!(
        d.stalls <= 2,
        "{} callback stalls (max gap {:.2} ms) — investigate before shipping",
        d.stalls,
        d.max_gap_ms
    );
}
