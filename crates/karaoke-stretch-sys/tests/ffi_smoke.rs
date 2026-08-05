//! FFI smoke tests: prove the vendored C++ builds, links, and behaves sanely
//! on known buffers. These are integration sanity checks, not DSP-quality
//! tests — quality was the stretch spike's listening criterion
//! (spikes/stretch/REPORT.md §2B).

use karaoke_stretch_sys::Stretch;

const RATE: u32 = 48_000;

fn sine_stereo(hz: f32, frames: usize, amp: f32) -> Vec<f32> {
    (0..frames)
        .flat_map(|i| {
            let s = amp * (2.0 * std::f32::consts::PI * hz * i as f32 / RATE as f32).sin();
            [s, s]
        })
        .collect()
}

fn rms(buf: &[f32]) -> f32 {
    (buf.iter().map(|&s| s * s).sum::<f32>() / buf.len().max(1) as f32).sqrt()
}

/// Goertzel power of `hz` over interleaved-stereo left channel of `buf`.
fn goertzel(buf: &[f32], hz: f32) -> f32 {
    let n = buf.len() / 2;
    let w = 2.0 * std::f64::consts::PI * hz as f64 / RATE as f64;
    let coeff = 2.0 * w.cos();
    let (mut s1, mut s2) = (0.0f64, 0.0f64);
    for i in 0..n {
        let x = buf[i * 2] as f64;
        let s0 = x + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    ((s1 * s1 + s2 * s2 - coeff * s1 * s2) / (n as f64 * n as f64)) as f32
}

#[test]
fn latencies_are_sane_for_both_configs() {
    let preset = Stretch::preset_default(2, RATE);
    // presetDefault = 120 ms block / 30 ms interval → input latency ≈ block/2.
    let li = preset.input_latency();
    let lo = preset.output_latency();
    println!("preset_default: input {li} frames, output {lo} frames");
    assert!(li > 0 && lo > 0);
    assert!(
        (li as i64 - (0.06 * RATE as f64) as i64).abs() < 500,
        "input latency {li} not ≈ half the 120 ms block"
    );
    assert!(lo < RATE as usize / 4, "output latency {lo} ≥ 250 ms is absurd");

    let lowlat = Stretch::new(2, (0.040 * RATE as f64) as usize, (0.010 * RATE as f64) as usize);
    let (li2, lo2) = (lowlat.input_latency(), lowlat.output_latency());
    println!("lowlat 40/10 ms: input {li2} frames, output {lo2} frames");
    assert!(li2 > 0 && lo2 > 0);
    assert!(li2 < li && lo2 < lo, "low-latency config must have less latency");
}

#[test]
fn identity_process_preserves_length_and_energy() {
    let mut st = Stretch::preset_default(2, RATE);
    st.set_transpose_semitones(0.0, 8000.0 / RATE as f32);
    let frames = 2 * RATE as usize; // 2 s
    let input = sine_stereo(440.0, frames, 0.5);
    let mut output = vec![0.0f32; input.len()];
    st.process(&input, &mut output);
    assert_eq!(output.len(), input.len());
    assert!(output.iter().all(|s| s.is_finite()), "non-finite output");
    // Skip the total-latency warmup region, then energy must be in the same
    // ballpark as the input (phase vocoder, not bit-exact).
    let skip_frames = 2 * (st.input_latency() + st.output_latency());
    let r = rms(&output[skip_frames * 2..]);
    println!("identity RMS after warmup: {r:.4} (input {:.4})", rms(&input));
    assert!(r > 0.2 && r < 0.6, "energy off: {r}");
}

#[test]
fn transpose_plus_12_doubles_the_dominant_frequency() {
    let mut st = Stretch::preset_default(2, RATE);
    st.set_transpose_semitones(12.0, 0.0);
    let frames = 2 * RATE as usize;
    let input = sine_stereo(440.0, frames, 0.5);
    let mut output = vec![0.0f32; input.len()];
    st.process(&input, &mut output);
    let skip_frames = 2 * (st.input_latency() + st.output_latency());
    let tail = &output[skip_frames * 2..];
    let p880 = goertzel(tail, 880.0);
    let p440 = goertzel(tail, 440.0);
    println!("+12 st: power@880 {p880:.6}, power@440 {p440:.6}");
    assert!(p880 > 10.0 * p440, "+12 st did not move 440 → 880");
}

/// Grounds the player-clock latency model (player/stretch.rs). Measured
/// behavior (this test, i7-9700K, preset_default @ 48 kHz): after priming
/// with `input_latency()` frames via `seek()`, output frame `k` corresponds
/// to stream position `(k - output_latency())·rate - input_latency()` —
/// i.e. content fed after the pre-roll becomes dominant at exactly
/// `input_latency() + output_latency()` (~120 ms), and the warmup region
/// before that plays the **primed history**, not silence. So: pre-roll does
/// NOT shorten the pipeline lag; it replaces the warmup silence with real
/// audio. The player's engage sequence and its D = Li + Lo·r clock offset
/// are built on exactly this measurement.
#[test]
fn preroll_fills_warmup_with_history_and_lag_is_li_plus_lo() {
    let mut st = Stretch::preset_default(2, RATE);
    st.set_transpose_semitones(0.0, 8000.0 / RATE as f32);
    let li = st.input_latency();
    let lo = st.output_latency();

    // Prime with 440 Hz "history", then stream 880 Hz.
    let preroll = sine_stereo(440.0, li, 0.5);
    st.seek(&preroll, 1.0);
    let frames = RATE as usize; // 1 s of new content
    let input = sine_stereo(880.0, frames, 0.5);
    let mut output = vec![0.0f32; input.len()];
    st.process(&input, &mut output);

    // Find the first 10 ms window where the new tone carries 90% of the
    // energy of the two probes.
    let win = (0.010 * RATE as f64) as usize;
    let mut t90_frames = None;
    let mut w = 0;
    while (w + 1) * win < frames {
        let seg = &output[w * win * 2..(w + 1) * win * 2];
        let p_new = goertzel(seg, 880.0);
        let p_old = goertzel(seg, 440.0);
        if p_new > 9.0 * p_old && p_new > 1e-6 {
            t90_frames = Some(w * win);
            break;
        }
        w += 1;
    }
    let t90 = t90_frames.expect("new tone never dominated — pre-roll broken");
    println!(
        "pre-roll alignment: new content dominant from ~{t90} frames \
         ({:.1} ms); output latency {lo} ({:.1} ms), input latency {li} ({:.1} ms)",
        t90 as f64 / RATE as f64 * 1000.0,
        lo as f64 / RATE as f64 * 1000.0,
        li as f64 / RATE as f64 * 1000.0,
    );
    // Measured model: switchover at Li + Lo (± one 30 ms analysis interval
    // of phase-vocoder smear).
    let interval = (0.030 * RATE as f64) as usize;
    assert!(
        t90 + interval >= li + lo && t90 <= li + lo + 2 * interval,
        "t90 {t90} not ≈ Li+Lo {} — the player clock's latency model is wrong",
        li + lo
    );
    // And the warmup region [Lo, Li+Lo) must contain the primed history
    // (old tone, real energy) — pre-roll's actual job is killing the
    // engage-time silence gap.
    let h0 = (lo + interval / 2) * 2;
    let h1 = (li + lo - interval / 2) * 2;
    let hist = &output[h0..h1];
    let (p_old, p_new) = (goertzel(hist, 440.0), goertzel(hist, 880.0));
    println!(
        "warmup region [{}..{}) frames: RMS {:.4}, power@440 {p_old:.6}, power@880 {p_new:.6}",
        h0 / 2,
        h1 / 2,
        rms(hist)
    );
    assert!(rms(hist) > 0.2, "warmup region is silent — pre-roll not applied");
    assert!(p_old > 4.0 * p_new, "warmup region is not the primed history");
}

#[test]
fn flush_drains_without_nans() {
    let mut st = Stretch::new(2, (0.040 * RATE as f64) as usize, (0.010 * RATE as f64) as usize);
    let input = sine_stereo(330.0, RATE as usize / 2, 0.4);
    let mut output = vec![0.0f32; input.len()];
    st.process(&input, &mut output);
    let mut tail = vec![0.0f32; st.output_latency() * 2];
    st.flush(&mut tail);
    assert!(tail.iter().all(|s| s.is_finite()));
}
