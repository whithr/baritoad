//! Real-device stretch smoke test (Phase 3 milestone 2).
//!
//! `#[ignore]`d: plays ~45 s of audio on the default output device. Run with:
//!
//! ```text
//! cargo test -p karaoke-core --release --test player_stretch_smoke -- --ignored --nocapture
//! ```
//!
//! Sources are generated sines by default (nothing committed — CLAUDE.md hard
//! rule); set `KARAOKE_SMOKE_STEMS` to a directory with `instrumental.wav` +
//! `vocals.wav` for real stems.
//!
//! What this measures (measured-numbers convention):
//! - scheduling apply latency (setter → callback pickup) per change; the
//!   audible end-to-end adds the stretcher pipeline t90 measured in the spike
//!   (spikes/stretch/REPORT.md §2A: preset_default t90 69–72 ms, 40/10 ms
//!   config 29 ms) plus ~1 device period
//! - gaplessness across ≥16 live changes incl. engage/disengage mode switches
//!   and a config switch: GapTracker stall counter must stay 0
//! - clock-vs-wall ratio under 0.9x and 1.2x tempo, and identity bypass
//!   behavior before/after

use std::time::{Duration, Instant};

use karaoke_core::audio::DecodedAudio;
use karaoke_core::player::{Player, StretchConfig, TransportState};

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

/// Wait until the callback has picked up at least `count` setting changes;
/// returns the pickup latency (ms) reported for the most recent one.
fn wait_pickup(player: &Player, count: u64, timeout: Duration) -> f64 {
    let t0 = Instant::now();
    loop {
        let d = player.diagnostics();
        if d.stretch_applied >= count {
            return d.stretch_apply_ms;
        }
        assert!(
            t0.elapsed() < timeout,
            "callback never picked up change #{count}"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
}

fn wait_engaged(player: &Player, want: bool, timeout: Duration) {
    let t0 = Instant::now();
    while player.diagnostics().stretch_engaged != want {
        assert!(
            t0.elapsed() < timeout,
            "stretch_engaged did not become {want} within {timeout:?}"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn clock_wall_ratio(player: &Player, wall: Duration) -> f64 {
    let clock = player.clock();
    let w0 = Instant::now();
    let p0 = clock.position_seconds();
    std::thread::sleep(wall);
    (clock.position_seconds() - p0) / w0.elapsed().as_secs_f64()
}

#[test]
#[ignore = "plays ~45 s of audio on the default output device"]
fn stretch_live_changes_are_gapless_and_clock_tracks_tempo() {
    let mut player = Player::new().expect("open default output device");
    let info = player.device_info().clone();
    println!(
        "device: {} | {} Hz | {} ch | {} | buffer {}",
        info.name, info.sample_rate, info.channels, info.sample_format, info.buffer
    );

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
            let inst = sine_decoded(220.0, 75.0, 0.15);
            let voc = sine_decoded(440.0, 75.0, 0.15);
            player.load_decoded(inst, Some(voc)).expect("load sines");
        }
    }
    let clock = player.clock();
    player.set_vocal_guide(0.25);
    player.play();
    assert_eq!(player.state(), TransportState::Playing);

    // Identity warmup: bypass, clock tracks wall 1:1.
    std::thread::sleep(Duration::from_secs(2));
    assert!(!player.diagnostics().stretch_engaged, "engaged at identity");
    let r = clock_wall_ratio(&player, Duration::from_secs(2));
    println!("identity clock/wall ratio: {r:.4}");
    assert!((r - 1.0).abs() < 0.02, "identity clock drift: {r:.4}");

    // ≥16 live changes incl. engage/disengage crossings (spike-style schedule
    // plus identity returns, which exercise the milestone-2 mode switches).
    let schedule: &[(f32, f64)] = &[
        (3.0, 1.0),
        (3.0, 0.9),
        (-6.0, 0.9),
        (-6.0, 1.2),
        (6.0, 1.2),
        (0.0, 1.0), // disengage
        (-3.0, 1.2),
        (0.0, 1.0), // disengage
        (2.0, 0.8),
        (2.0, 1.1),
        (-2.0, 1.1),
        (0.0, 0.9), // tempo-only
        (0.0, 1.15),
        (4.0, 1.0),
        (0.0, 1.0), // disengage
        (-5.0, 0.85),
        (0.0, 1.0), // final disengage
    ];
    let mut pickups_ms: Vec<f64> = Vec::new();
    let mut applied_before = player.diagnostics().stretch_applied;
    for (i, &(pitch, tempo)) in schedule.iter().enumerate() {
        player.set_pitch_semitones(pitch);
        player.set_tempo_rate(tempo);
        let ms = wait_pickup(&player, applied_before + 1, Duration::from_millis(500));
        applied_before = player.diagnostics().stretch_applied;
        pickups_ms.push(ms);
        println!("change {:2}: pitch {pitch:+.0} st, tempo {tempo:.2}x — pickup {ms:.2} ms", i + 1);
        std::thread::sleep(Duration::from_millis(1200));
    }
    assert!(schedule.len() >= 16, "need at least 16 live changes");
    wait_engaged(&player, false, Duration::from_secs(1));

    let max_pickup = pickups_ms.iter().cloned().fold(0.0, f64::max);
    let min_pickup = pickups_ms.iter().cloned().fold(f64::MAX, f64::min);
    let period_ms = 1000.0 * 480.0 / info.sample_rate as f64; // ~1 device period
    println!(
        "scheduling pickup latency: {min_pickup:.2}–{max_pickup:.2} ms over {} changes",
        pickups_ms.len()
    );
    println!(
        "end-to-end audible estimate (pickup + spike t90 + ~1 period): \
         preset_default ≈ {:.0}–{:.0} ms, lowlat 40/10 ≈ {:.0}–{:.0} ms",
        min_pickup + 69.0 + period_ms,
        max_pickup + 72.0 + period_ms,
        min_pickup + 29.0 + period_ms,
        max_pickup + 29.0 + period_ms,
    );
    assert!(
        max_pickup + 72.0 + period_ms < 100.0,
        "end-to-end estimate exceeds the 100 ms target (max pickup {max_pickup:.2} ms)"
    );

    // Clock-vs-wall under sustained tempo change.
    player.set_tempo_rate(0.9);
    wait_engaged(&player, true, Duration::from_secs(1));
    std::thread::sleep(Duration::from_millis(800)); // transition + settle
    let r09 = clock_wall_ratio(&player, Duration::from_secs(4));
    println!("0.9x clock/wall ratio: {r09:.4}");
    assert!((r09 - 0.9).abs() < 0.03, "0.9x clock ratio {r09:.4}");

    player.set_tempo_rate(1.2);
    std::thread::sleep(Duration::from_millis(800));
    let r12 = clock_wall_ratio(&player, Duration::from_secs(4));
    println!("1.2x clock/wall ratio: {r12:.4}");
    assert!((r12 - 1.2).abs() < 0.03, "1.2x clock ratio {r12:.4}");

    // Config switch mid-playback while active (ramped re-engage), then the
    // low-latency config keeps playing.
    player.set_stretch_config(StretchConfig::LowLatency40x10);
    std::thread::sleep(Duration::from_millis(600));
    wait_engaged(&player, true, Duration::from_secs(1));
    let r12b = clock_wall_ratio(&player, Duration::from_secs(2));
    println!("1.2x on lowlat config clock/wall ratio: {r12b:.4}");
    assert!((r12b - 1.2).abs() < 0.04, "lowlat clock ratio {r12b:.4}");

    // Back to identity: bypass again, 1:1 clock.
    player.set_tempo_rate(1.0);
    wait_engaged(&player, false, Duration::from_secs(1));
    let r1 = clock_wall_ratio(&player, Duration::from_secs(2));
    println!("post-stretch identity clock/wall ratio: {r1:.4}");
    assert!((r1 - 1.0).abs() < 0.02, "identity clock drift after stretch: {r1:.4}");

    // Position sanity: never negative, and within the song.
    let pos = clock.position_seconds();
    let dur = player.duration_seconds();
    assert!(pos >= 0.0 && pos <= dur, "position {pos:.2} outside [0, {dur:.2}]");

    // Gaplessness: our own stall counter across all changes + mode switches.
    let d = player.diagnostics();
    println!(
        "diagnostics: {} callbacks, {} stalls, max callback gap {:.2} ms, \
         {} cpal-reported errors, mmcss {:?}",
        d.callbacks, d.stalls, d.max_gap_ms, d.stream_errors, d.mmcss,
    );
    assert!(d.callbacks > 1000, "suspiciously few callbacks: {}", d.callbacks);
    assert_eq!(d.stalls, 0, "callback stalls during live changes (max gap {:.2} ms)", d.max_gap_ms);
    #[cfg(windows)]
    assert_eq!(d.mmcss, karaoke_core::player::MmcssStatus::Registered);

    player.stop();
}
