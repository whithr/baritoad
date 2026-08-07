//! Per-execution-provider golden-segment parity check — a shipped product
//! feature, not a dev test (GO-NO-GO.md Phase 1 hardening list).
//!
//! Rationale: the separation spike found DirectML graph fusion silently
//! producing garbage stems with no error raised. A driver or runtime update
//! could reintroduce that class of bug on a user's machine, so on first use of
//! a non-CPU EP we run one deterministic segment through both the candidate EP
//! and the CPU baseline and require SNR ≥ [`GOLDEN_SNR_THRESHOLD_DB`]. The
//! result is cached; failure falls back (closed) to CPU.
//!
//! Threshold context (spikes/separation/REPORT.md): healthy DML-vs-reference
//! parity measured ≥ 91.8 dB and CPU-vs-reference ≥ 67.5 dB, while the fusion
//! bug produced *negative* SNR. 40 dB separates those regimes with margin on
//! both sides.

use ndarray::Array3;
use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::separation::SEGMENT;

pub const GOLDEN_SNR_THRESHOLD_DB: f64 = 40.0;

/// Plausibility bounds for the CPU baseline's own golden output RMS: catches
/// a catastrophically broken baseline (the fusion bug produced RMS ~15,000;
/// healthy stems sit well under 1.0).
pub const SANITY_RMS_MAX: f64 = 100.0;
pub const SANITY_RMS_MIN: f64 = 1e-8;

#[derive(Debug, Clone, Serialize)]
pub struct ParityReport {
    pub ep: String,
    /// SNR of the candidate EP against the CPU baseline (None for the CPU
    /// sanity check, which has no baseline to compare against).
    pub snr_db: Option<f64>,
    pub passed: bool,
    /// True when the verdict came from the on-disk cache (no inference run).
    pub from_cache: bool,
}

/// Deterministic pseudo-musical golden segment: tones + noise, peak ≈ 0.15.
/// Determinism only needs to hold within one machine (the baseline is computed
/// on the same machine), so `f32::sin` is fine.
pub fn golden_segment() -> Array3<f32> {
    let mut state: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut noise = move || {
        // xorshift64* — deterministic, dependency-free
        state ^= state >> 12;
        state ^= state << 25;
        state ^= state >> 27;
        let r = state.wrapping_mul(0x2545_F491_4F6C_DD1D);
        (r >> 40) as f32 / (1u64 << 24) as f32 - 0.5
    };
    let mut input = Array3::<f32>::zeros((1, 2, SEGMENT));
    for ch in 0..2 {
        let detune = 1.0 + 0.01 * ch as f32;
        for i in 0..SEGMENT {
            let t = i as f32 / 44_100.0;
            let env = (0.5 * t).sin().abs(); // slow amplitude movement
            let tones = 0.05 * (2.0 * std::f32::consts::PI * 220.0 * detune * t).sin()
                + 0.03 * (2.0 * std::f32::consts::PI * 440.0 * detune * t).sin()
                + 0.02 * (2.0 * std::f32::consts::PI * 880.0 * detune * t).sin();
            input[[0, ch, i]] = env * tones + 0.02 * noise();
        }
    }
    input
}

/// SNR of `test` against `reference`, in dB (f64 accumulation).
pub fn snr_db(reference: &[f32], test: &[f32]) -> f64 {
    assert_eq!(reference.len(), test.len());
    let mut num = 0.0f64;
    let mut den = 0.0f64;
    for (r, t) in reference.iter().zip(test) {
        num += (*r as f64) * (*r as f64);
        den += (*r as f64 - *t as f64) * (*r as f64 - *t as f64);
    }
    if den <= 0.0 {
        return f64::INFINITY;
    }
    10.0 * (num / den).log10()
}

pub fn rms(x: &[f32]) -> f64 {
    if x.is_empty() {
        return 0.0;
    }
    (x.iter().map(|v| (*v as f64) * (*v as f64)).sum::<f64>() / x.len() as f64).sqrt()
}

// ---- on-disk cache ----------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
struct CacheEntry {
    ep: String,
    model_size: u64,
    model_mtime_unix: i64,
    core_version: String,
    snr_db: Option<f64>,
    passed: bool,
    checked_at_unix: i64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct CacheFile {
    entries: Vec<CacheEntry>,
}

pub struct ParityCache {
    path: std::path::PathBuf,
    file: CacheFile,
    model_size: u64,
    model_mtime_unix: i64,
}

fn model_identity(model_path: &Path) -> (u64, i64) {
    let meta = std::fs::metadata(model_path).ok();
    let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    let mtime = meta
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    (size, mtime)
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

impl ParityCache {
    /// Load (or start) the cache at `path`, keyed to `model_path`'s identity
    /// (size + mtime + crate version — cheap and invalidates on model swap).
    pub fn load(path: &Path, model_path: &Path) -> Self {
        Self::load_paths(path, std::slice::from_ref(&model_path.to_path_buf()))
    }

    /// Multi-file variant for bagged models (htdemucs_ft is four ONNX files):
    /// identity = sum of sizes + newest mtime, so swapping any sub-model
    /// invalidates, and a single-file set is identical to [`Self::load`].
    pub fn load_paths(path: &Path, model_paths: &[std::path::PathBuf]) -> Self {
        let file = std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let mut model_size = 0u64;
        let mut model_mtime_unix = 0i64;
        for p in model_paths {
            let (size, mtime) = model_identity(p);
            model_size += size;
            model_mtime_unix = model_mtime_unix.max(mtime);
        }
        Self {
            path: path.to_path_buf(),
            file,
            model_size,
            model_mtime_unix,
        }
    }

    /// A cached *pass* for this EP+model. Failures are never trusted from
    /// cache — they trigger a re-check (the environment may have been fixed).
    /// `ep` is the EP's string name — the cache is shared between models
    /// (separation htdemucs, alignment wav2vec2), disambiguated by the model
    /// identity captured at [`Self::load`].
    pub fn cached_pass(&self, ep: &str) -> Option<f64> {
        self.file
            .entries
            .iter()
            .find(|e| {
                e.passed
                    && e.ep == ep
                    && e.model_size == self.model_size
                    && e.model_mtime_unix == self.model_mtime_unix
                    && e.core_version == env!("CARGO_PKG_VERSION")
            })
            .and_then(|e| e.snr_db)
            .or_else(|| {
                // CPU sanity entries carry no SNR; still report the hit.
                self.file
                    .entries
                    .iter()
                    .find(|e| {
                        e.passed
                            && e.ep == ep
                            && e.model_size == self.model_size
                            && e.model_mtime_unix == self.model_mtime_unix
                            && e.core_version == env!("CARGO_PKG_VERSION")
                    })
                    .map(|_| f64::NAN)
            })
    }

    pub fn record(&mut self, ep: &str, snr_db: Option<f64>, passed: bool) {
        self.file.entries.retain(|e| {
            !(e.ep == ep
                && e.model_size == self.model_size
                && e.model_mtime_unix == self.model_mtime_unix)
        });
        self.file.entries.push(CacheEntry {
            ep: ep.into(),
            model_size: self.model_size,
            model_mtime_unix: self.model_mtime_unix,
            core_version: env!("CARGO_PKG_VERSION").into(),
            snr_db,
            passed,
            checked_at_unix: now_unix(),
        });
        // Best-effort persistence; a failed write only costs a re-check later.
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(s) = serde_json::to_string_pretty(&self.file) {
            let _ = std::fs::write(&self.path, s);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snr_of_identical_signals_is_infinite() {
        let a = vec![0.5f32, -0.25, 0.125];
        assert!(snr_db(&a, &a).is_infinite());
    }

    #[test]
    fn snr_known_value() {
        // reference = 1.0 everywhere, test off by 0.01 -> SNR = 40 dB
        let r = vec![1.0f32; 1000];
        let t = vec![1.01f32; 1000];
        let s = snr_db(&r, &t);
        assert!((s - 40.0).abs() < 1e-3, "snr={s}"); // f32 0.01 is inexact
    }

    #[test]
    fn golden_segment_is_deterministic_and_bounded() {
        let a = golden_segment();
        let b = golden_segment();
        assert_eq!(a, b);
        let peak = a.iter().fold(0.0f32, |m, v| m.max(v.abs()));
        assert!(peak > 0.01 && peak < 0.5, "peak={peak}");
    }

    #[test]
    fn cache_roundtrip_and_failure_not_trusted() {
        let dir = std::env::temp_dir().join("karaoke-core-test-parity");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let model = dir.join("model.onnx.fake");
        std::fs::write(&model, b"weights").unwrap();
        let cache_path = dir.join("parity.json");

        let mut c = ParityCache::load(&cache_path, &model);
        assert!(c.cached_pass("directml").is_none());
        c.record("directml", Some(12.0), false);
        // failures are re-checked, not trusted
        let c2 = ParityCache::load(&cache_path, &model);
        assert!(c2.cached_pass("directml").is_none());

        let mut c3 = ParityCache::load(&cache_path, &model);
        c3.record("directml", Some(80.0), true);
        let c4 = ParityCache::load(&cache_path, &model);
        assert_eq!(c4.cached_pass("directml"), Some(80.0));
    }
}
