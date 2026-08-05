//! Small measurement helpers: Goertzel tone power, onset envelope,
//! discontinuity / gap scanning.

pub fn goertzel_power(x: &[f32], sample_rate: f32, freq: f32) -> f64 {
    let w = 2.0 * std::f64::consts::PI * (freq as f64) / (sample_rate as f64);
    let c = 2.0 * w.cos();
    let (mut s1, mut s2) = (0.0f64, 0.0f64);
    for &v in x {
        let s0 = v as f64 + c * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    (s1 * s1 + s2 * s2 - c * s1 * s2).max(0.0)
}

/// Max |x[n] - x[n-1]| over [start, end).
pub fn max_delta(x: &[f32], start: usize, end: usize) -> f32 {
    let end = end.min(x.len());
    let start = start.min(end).max(1);
    let mut m = 0.0f32;
    for n in start..end {
        m = m.max((x[n] - x[n - 1]).abs());
    }
    m
}

/// Longest run of consecutive samples with |x| < eps in [start, end), in samples.
pub fn longest_silent_run(x: &[f32], start: usize, end: usize, eps: f32) -> usize {
    let end = end.min(x.len());
    let mut best = 0usize;
    let mut run = 0usize;
    for n in start.min(end)..end {
        if x[n].abs() < eps {
            run += 1;
            best = best.max(run);
        } else {
            run = 0;
        }
    }
    best
}

/// Short-time RMS envelope: window `win`, hop `hop`. Returns (hop-index, rms) pairs.
pub fn rms_envelope(x: &[f32], win: usize, hop: usize) -> Vec<f32> {
    let mut out = Vec::new();
    let mut i = 0;
    while i + win <= x.len() {
        let e: f64 = x[i..i + win].iter().map(|&v| (v as f64) * (v as f64)).sum();
        out.push((e / win as f64).sqrt() as f32);
        i += hop;
    }
    out
}

/// Simple onset picker on an RMS envelope: local maxima above `thresh_frac` of
/// the global max, separated by at least `min_sep` hops. Returns hop indices.
pub fn pick_onsets(env: &[f32], thresh_frac: f32, min_sep: usize) -> Vec<usize> {
    let max = env.iter().cloned().fold(0.0f32, f32::max);
    let thresh = max * thresh_frac;
    let mut onsets: Vec<usize> = Vec::new();
    for i in 1..env.len().saturating_sub(1) {
        if env[i] >= thresh && env[i] >= env[i - 1] && env[i] >= env[i + 1] {
            if let Some(&last) = onsets.last() {
                if i - last < min_sep {
                    // keep the larger peak
                    if env[i] > env[last] {
                        *onsets.last_mut().unwrap() = i;
                    }
                    continue;
                }
            }
            onsets.push(i);
        }
    }
    onsets
}

pub fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    let idx = ((sorted.len() - 1) as f64 * p / 100.0).round() as usize;
    sorted[idx]
}
