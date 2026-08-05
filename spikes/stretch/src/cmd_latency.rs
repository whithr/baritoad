//! Measure how long a pitch (transpose) or tempo (rate) change takes to become
//! audible in the output stream, and whether the transition is gapless.
//!
//! Pitch: stream a 440 Hz sine, flip transpose mid-stream, then track the
//! energy ratio between the old and new tone frequencies (Goertzel) to find the
//! 10%/50%/90% crossover times relative to the moment the setting was applied.
//!
//! Tempo: stream a slow linear chirp, halve the rate mid-stream. A time-stretch
//! preserves pitch, so the output's instantaneous frequency reveals which
//! *input time* is playing at each output time; fitting a piecewise-linear
//! input-time trajectory recovers exactly when the new rate became audible.
//! (A click-train variant was tried first but is confounded by phase-vocoder
//! transient smearing.)
//!
//! Gaplessness: max sample-to-sample delta and longest near-silent run around
//! the change, compared against the pre-change baseline.

use crate::analysis::*;
use crate::engine::Feeder;
use crate::ffi::Stretch;

const BLOCK_FRAMES: usize = 512;

pub fn run() {
    println!("== configured stretcher latencies ==");
    for (name, s) in [
        ("preset_default@48k", Stretch::preset_default(2, 48000)),
        ("preset_cheaper@48k", Stretch::preset_cheaper(2, 48000)),
        ("preset_default@44.1k", Stretch::preset_default(2, 44100)),
        ("custom_40ms/10ms@48k", Stretch::new(2, 1920, 480)),
    ] {
        let sr = if name.contains("44.1") { 44100.0 } else { 48000.0 };
        let (il, ol) = (s.input_latency(), s.output_latency());
        println!(
            "{name}: input {il} frames ({:.1} ms), output {ol} frames ({:.1} ms), total {:.1} ms",
            il as f64 / sr * 1000.0,
            ol as f64 / sr * 1000.0,
            (il + ol) as f64 / sr * 1000.0
        );
    }

    println!("\n== pitch apply latency (440 Hz sine, change at t=2.0s) ==");
    println!("config, semitones, t10_ms, t50_ms, t90_ms, delta_baseline, delta_around_change, longest_silence_ms");
    let configs: [(&str, fn() -> Stretch); 3] = [
        ("preset_default@48k", || Stretch::preset_default(2, 48000)),
        ("preset_cheaper@48k", || Stretch::preset_cheaper(2, 48000)),
        ("custom_40ms/10ms@48k", || Stretch::new(2, 1920, 480)),
    ];
    for (cfg_name, make) in configs {
        for semis in [6.0f32, -6.0, 3.0] {
            pitch_latency(cfg_name, make(), 48000, semis);
        }
    }

    println!("\n== tempo apply latency (linear chirp, rate 1.0 -> 0.5 at t=2.0s) ==");
    tempo_latency("preset_default@48k", Stretch::preset_default(2, 48000), 48000);
    tempo_latency("custom_40ms/10ms@48k", Stretch::new(2, 1920, 480), 48000);
}

fn pitch_latency(cfg_name: &str, mut stretch: Stretch, sr: u32, semitones: f32) {
    let srf = sr as f64;
    let f1 = 440.0f64;
    let f2 = f1 * 2f64.powf(semitones as f64 / 12.0);
    let total_s = 4.0;
    let total_frames = (total_s * srf) as usize;

    // Interleaved stereo sine.
    let input: Vec<f32> = (0..total_frames)
        .flat_map(|n| {
            let v = (2.0 * std::f64::consts::PI * f1 * n as f64 / srf).sin() as f32 * 0.5;
            [v, v]
        })
        .collect();

    let change_block = (2.0 * srf / BLOCK_FRAMES as f64) as usize;
    let change_frame = change_block * BLOCK_FRAMES; // output frame where new setting first *could* appear

    stretch.set_transpose_semitones(0.0, 8000.0 / srf as f32);
    let mut feeder = Feeder::new(&input);
    let mut out_mono: Vec<f32> = Vec::with_capacity(total_frames);
    let mut block = vec![0.0f32; BLOCK_FRAMES * 2];
    let mut block_idx = 0usize;
    while !feeder.done() {
        if block_idx == change_block {
            stretch.set_transpose_semitones(semitones, 8000.0 / srf as f32);
        }
        let inp = feeder.take(BLOCK_FRAMES, 1.0);
        stretch.process(inp, &mut block);
        out_mono.extend(block.chunks(2).map(|c| c[0]));
        block_idx += 1;
    }

    // Track energy ratio in windows after the change.
    let win = 1024usize;
    let hop = 128usize;
    let scan_start = change_frame.saturating_sub((0.2 * srf) as usize);
    let scan_end = (change_frame + (1.2 * srf) as usize).min(out_mono.len() - win);
    let (mut t10, mut t50, mut t90) = (f64::NAN, f64::NAN, f64::NAN);
    let mut i = scan_start;
    while i < scan_end {
        let w = &out_mono[i..i + win];
        let e1 = goertzel_power(w, srf as f32, f1 as f32);
        let e2 = goertzel_power(w, srf as f32, f2 as f32);
        let r = e2 / (e1 + e2 + 1e-12);
        let t_ms = (i + win / 2) as f64 / srf * 1000.0 - change_frame as f64 / srf * 1000.0;
        if t_ms >= 0.0 {
            if t10.is_nan() && r > 0.1 {
                t10 = t_ms;
            }
            if t50.is_nan() && r > 0.5 {
                t50 = t_ms;
            }
            if t90.is_nan() && r > 0.9 {
                t90 = t_ms;
                break;
            }
        }
        i += hop;
    }

    // Gaplessness around the change.
    let baseline = max_delta(&out_mono, (1.0 * srf) as usize, (1.9 * srf) as usize);
    let around = max_delta(
        &out_mono,
        change_frame.saturating_sub((0.05 * srf) as usize),
        change_frame + (0.5 * srf) as usize,
    );
    // Theoretical max per-sample delta of the *new* higher tone is ~2*pi*f2/sr*amp;
    // a hard discontinuity would exceed that severalfold.
    let silent_run = longest_silent_run(
        &out_mono,
        change_frame.saturating_sub((0.05 * srf) as usize),
        change_frame + (0.5 * srf) as usize,
        1e-4,
    );
    println!(
        "{cfg_name}, {semitones:+.0}, {t10:.1}, {t50:.1}, {t90:.1}, {baseline:.4}, {around:.4}, {:.2}",
        silent_run as f64 / srf * 1000.0
    );
}

fn tempo_latency(cfg_name: &str, mut stretch: Stretch, sr: u32) {
    let srf = sr as f64;
    let input_s = 6.0;
    let total_frames = (input_s * srf) as usize;

    // Linear chirp 300 -> 660 Hz over 6 s: f(t_in) = 300 + 60 * t_in.
    // Instantaneous phase = 2*pi*(300*t + 30*t^2).
    let f_of = |t_in: f64| 300.0 + 60.0 * t_in;
    let t_of = |f: f64| (f - 300.0) / 60.0;
    let input: Vec<f32> = (0..total_frames)
        .flat_map(|n| {
            let t = n as f64 / srf;
            let v = ((2.0 * std::f64::consts::PI * (300.0 * t + 30.0 * t * t)).sin() * 0.5) as f32;
            [v, v]
        })
        .collect();

    stretch.set_transpose_semitones(0.0, 0.0);
    let change_block = (2.0 * srf / BLOCK_FRAMES as f64) as usize;
    let change_out_s = change_block as f64 * BLOCK_FRAMES as f64 / srf;

    let mut feeder = Feeder::new(&input);
    let mut out_mono: Vec<f32> = Vec::new();
    let mut block = vec![0.0f32; BLOCK_FRAMES * 2];
    let mut block_idx = 0usize;
    while !feeder.done() {
        let rate = if block_idx >= change_block { 0.5 } else { 1.0 };
        let inp = feeder.take(BLOCK_FRAMES, rate);
        stretch.process(inp, &mut block);
        out_mono.extend(block.chunks(2).map(|c| c[0]));
        block_idx += 1;
    }

    // Instantaneous frequency per window via averaged zero-crossing period,
    // -> recovered input time per output time.
    let win = 2048usize;
    let hop = 256usize;
    let scan0 = ((change_out_s - 0.6) * srf) as usize;
    let scan1 = (((change_out_s + 1.2) * srf) as usize).min(out_mono.len() - win);
    let mut traj: Vec<(f64, f64)> = Vec::new(); // (t_out, t_in recovered)
    let mut i = scan0;
    while i < scan1 {
        if let Some(f) = zc_freq(&out_mono[i..i + win], srf) {
            let t_out = (i + win / 2) as f64 / srf;
            traj.push((t_out, t_of(f)));
        }
        i += hop;
    }

    // Fit: t_in(t_out) = (t_out - d)               for t_out <= tb
    //                  = (tb - d) + 0.5*(t_out-tb) for t_out >  tb
    // d from pre-change points:
    let pre: Vec<f64> = traj
        .iter()
        .filter(|(to, _)| *to < change_out_s - 0.1)
        .map(|(to, ti)| to - ti)
        .collect();
    let d = pre.iter().sum::<f64>() / pre.len() as f64;

    let mut best = (f64::NAN, f64::MAX);
    let mut tb = change_out_s - 0.05;
    while tb <= change_out_s + 0.5 {
        let err: f64 = traj
            .iter()
            .map(|&(to, ti)| {
                let pred = if to <= tb { to - d } else { (tb - d) + 0.5 * (to - tb) };
                (pred - ti) * (pred - ti)
            })
            .sum::<f64>();
        if err < best.1 {
            best = (tb, err);
        }
        tb += 0.002;
    }
    let rms_ms = (best.1 / traj.len() as f64).sqrt() * 1000.0;

    println!(
        "{cfg_name}: pipeline delay D = {:.1} ms; tempo change audible at {:.1} ms after the setting call (fit rms {:.2} ms over {} windows)",
        d * 1000.0,
        (best.0 - change_out_s) * 1000.0,
        rms_ms,
        traj.len()
    );

    // Gaplessness around the tempo change.
    let cf = (change_out_s * srf) as usize;
    let baseline = max_delta(&out_mono, (1.0 * srf) as usize, (1.9 * srf) as usize);
    let around = max_delta(&out_mono, cf - (0.05 * srf) as usize, cf + (0.5 * srf) as usize);
    let silent = longest_silent_run(&out_mono, cf - (0.05 * srf) as usize, cf + (0.5 * srf) as usize, 1e-4);
    println!(
        "  gapless check: max delta baseline {:.4}, around change {:.4}; longest near-silent run {:.2} ms",
        baseline,
        around,
        silent as f64 / srf * 1000.0
    );
}

/// Frequency from averaged positive-going zero-crossing spacing; None if too
/// few crossings.
fn zc_freq(x: &[f32], sr: f64) -> Option<f64> {
    let mut crossings: Vec<f64> = Vec::new();
    for n in 1..x.len() {
        if x[n - 1] < 0.0 && x[n] >= 0.0 {
            let frac = x[n - 1] as f64 / (x[n - 1] as f64 - x[n] as f64);
            crossings.push((n - 1) as f64 + frac);
        }
    }
    if crossings.len() < 4 {
        return None;
    }
    let span = crossings.last().unwrap() - crossings.first().unwrap();
    Some((crossings.len() - 1) as f64 * sr / span)
}
