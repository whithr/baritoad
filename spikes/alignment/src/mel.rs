//! Whisper log-mel spectrogram (80 mels, n_fft 400, hop 160, slaney mel filters),
//! matching openai/whisper `log_mel_spectrogram` / HF WhisperFeatureExtractor.

use rustfft::{num_complex::Complex32, FftPlanner};

pub const N_FFT: usize = 400;
pub const HOP: usize = 160;
pub const N_MELS: usize = 80;
pub const SAMPLE_RATE: usize = 16000;
pub const CHUNK_SAMPLES: usize = 30 * SAMPLE_RATE; // 480_000
pub const N_FRAMES: usize = CHUNK_SAMPLES / HOP; // 3000

/// librosa slaney hz->mel
fn hz_to_mel(f: f64) -> f64 {
    let f_sp = 200.0 / 3.0;
    let min_log_hz = 1000.0;
    let min_log_mel = min_log_hz / f_sp;
    let logstep = (6.4f64).ln() / 27.0;
    if f >= min_log_hz {
        min_log_mel + (f / min_log_hz).ln() / logstep
    } else {
        f / f_sp
    }
}

fn mel_to_hz(m: f64) -> f64 {
    let f_sp = 200.0 / 3.0;
    let min_log_hz = 1000.0;
    let min_log_mel = min_log_hz / f_sp;
    let logstep = (6.4f64).ln() / 27.0;
    if m >= min_log_mel {
        min_log_hz * (logstep * (m - min_log_mel)).exp()
    } else {
        f_sp * m
    }
}

/// Slaney-normalized triangular mel filterbank, shape [N_MELS][N_FFT/2+1].
pub fn mel_filterbank() -> Vec<Vec<f32>> {
    let n_bins = N_FFT / 2 + 1;
    let fmax = SAMPLE_RATE as f64 / 2.0;
    let mel_min = hz_to_mel(0.0);
    let mel_max = hz_to_mel(fmax);
    // n_mels + 2 points
    let mel_pts: Vec<f64> = (0..N_MELS + 2)
        .map(|i| mel_min + (mel_max - mel_min) * i as f64 / (N_MELS + 1) as f64)
        .collect();
    let hz_pts: Vec<f64> = mel_pts.iter().map(|&m| mel_to_hz(m)).collect();
    let fft_freqs: Vec<f64> = (0..n_bins)
        .map(|i| i as f64 * SAMPLE_RATE as f64 / N_FFT as f64)
        .collect();
    let mut fb = vec![vec![0.0f32; n_bins]; N_MELS];
    for m in 0..N_MELS {
        let (f_lo, f_mid, f_hi) = (hz_pts[m], hz_pts[m + 1], hz_pts[m + 2]);
        let norm = 2.0 / (f_hi - f_lo); // slaney norm
        for (k, &f) in fft_freqs.iter().enumerate() {
            let lower = (f - f_lo) / (f_mid - f_lo);
            let upper = (f_hi - f) / (f_hi - f_mid);
            let w = lower.min(upper).max(0.0);
            fb[m][k] = (w * norm) as f32;
        }
    }
    fb
}

/// Compute whisper log-mel for exactly one 30 s chunk (input padded/truncated to
/// CHUNK_SAMPLES). Returns [N_MELS * N_FRAMES] row-major (mel, frame).
pub fn log_mel_chunk(chunk: &[f32], fb: &[Vec<f32>]) -> Vec<f32> {
    assert_eq!(chunk.len(), CHUNK_SAMPLES);
    let n_bins = N_FFT / 2 + 1;
    // hann window, periodic
    let window: Vec<f32> = (0..N_FFT)
        .map(|i| {
            let x = std::f32::consts::PI * 2.0 * i as f32 / N_FFT as f32;
            0.5 * (1.0 - x.cos())
        })
        .collect();
    // reflect-pad by N_FFT/2
    let half = N_FFT / 2;
    let padded_len = CHUNK_SAMPLES + N_FFT;
    let mut padded = vec![0.0f32; padded_len];
    for i in 0..half {
        padded[i] = chunk[half - i]; // reflect
    }
    padded[half..half + CHUNK_SAMPLES].copy_from_slice(chunk);
    for i in 0..half {
        padded[half + CHUNK_SAMPLES + i] = chunk[CHUNK_SAMPLES - 2 - i];
    }

    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(N_FFT);
    let mut power = vec![0.0f32; N_FRAMES * n_bins]; // [frame][bin]
    let mut buf = vec![Complex32::new(0.0, 0.0); N_FFT];
    // whisper computes 3001 frames then drops the last; keep frames 0..3000
    for t in 0..N_FRAMES {
        let start = t * HOP;
        for i in 0..N_FFT {
            buf[i] = Complex32::new(padded[start + i] * window[i], 0.0);
        }
        fft.process(&mut buf);
        let row = &mut power[t * n_bins..(t + 1) * n_bins];
        for k in 0..n_bins {
            row[k] = buf[k].norm_sqr();
        }
    }
    // mel = fb @ power^T  -> [mel][frame]
    let mut logmel = vec![0.0f32; N_MELS * N_FRAMES];
    let mut maxval = f32::MIN;
    for m in 0..N_MELS {
        let f_row = &fb[m];
        for t in 0..N_FRAMES {
            let p = &power[t * n_bins..(t + 1) * n_bins];
            let mut acc = 0.0f32;
            for k in 0..n_bins {
                acc += f_row[k] * p[k];
            }
            let v = acc.max(1e-10).log10();
            logmel[m * N_FRAMES + t] = v;
            if v > maxval {
                maxval = v;
            }
        }
    }
    for v in logmel.iter_mut() {
        *v = (v.max(maxval - 8.0) + 4.0) / 4.0;
    }
    logmel
}
