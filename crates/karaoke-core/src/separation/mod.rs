//! Separation stage: htdemucs (ONNX) → vocals + instrumental.
//!
//! Ported from spikes/separation with the REPORT.md hardening applied:
//! - Symphonia decode of the user's file (see [`crate::audio`])
//! - streamed overlap-add ([`ola`])
//! - EP selection with DirectML fusion disabled, CPU fallback ([`model`])
//! - per-EP golden-segment parity check, fail-closed to CPU ([`parity`])

mod model;
mod ola;
mod parity;

pub use model::{EpKind, OrtModel, SegmentInfer, SepModel};
pub use ola::{
    blend_weights, norm_stats, segment_count, separate_streamed, SeparateOptions,
    SeparateStats, MAX_SHIFT, STRIDE,
};
pub use parity::{golden_segment, rms, snr_db, ParityCache, ParityReport, GOLDEN_SNR_THRESHOLD_DB};

use std::path::{Path, PathBuf};

use crate::error::{Error, Result};

/// Fixed by the ONNX export: int(7.8 s * 44100).
pub const SEGMENT: usize = 343_980;
pub const SAMPLE_RATE: u32 = 44_100;
pub const NUM_SOURCES: usize = 4;
pub const SOURCES: [&str; NUM_SOURCES] = ["drums", "bass", "other", "vocals"];
pub const VOCALS_INDEX: usize = 3;
pub const MODEL_FILE_NAME: &str = "htdemucs.onnx";
/// htdemucs_ft bag files, in [`SOURCES`] order (each fine-tuned per source).
pub const FT_MODEL_FILE_NAMES: [&str; NUM_SOURCES] = [
    "htdemucs_ft_drums.onnx",
    "htdemucs_ft_bass.onnx",
    "htdemucs_ft_other.onnx",
    "htdemucs_ft_vocals.onnx",
];

/// Which separation model to run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ModelKind {
    /// Base htdemucs: one ONNX file, one inference sweep per segment.
    #[default]
    Htdemucs,
    /// htdemucs_ft: four fine-tuned ONNX files (one per source), four sweeps
    /// per segment — the "high quality" model.
    ///
    /// DirectML caveat (measured 2026-08-06, RTX 2080 Super 8 GB): four
    /// resident DML sessions exhaust VRAM once every arena has grown —
    /// golden parity passes (arenas peak one at a time) and then the first
    /// real segment hangs the device (DXGI_ERROR_DEVICE_HUNG → TDR driver
    /// reset). Until sessions share memory or run staged, use this kind on
    /// CPU only; nothing in the app auto-selects it.
    HtdemucsFt,
}

impl ModelKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            ModelKind::Htdemucs => "htdemucs",
            ModelKind::HtdemucsFt => "htdemucs_ft",
        }
    }

    /// The ONNX files this kind loads from `model_dir`, in load order.
    pub fn paths(&self, model_dir: &Path) -> Vec<PathBuf> {
        match self {
            ModelKind::Htdemucs => vec![model_dir.join(MODEL_FILE_NAME)],
            ModelKind::HtdemucsFt => FT_MODEL_FILE_NAMES
                .iter()
                .map(|n| model_dir.join(n))
                .collect(),
        }
    }

    /// True when every file this kind needs exists in `model_dir`.
    pub fn available(&self, model_dir: &Path) -> bool {
        self.paths(model_dir).iter().all(|p| p.is_file())
    }
}

/// User-facing EP request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EpChoice {
    /// Best available: GPU EPs in preference order, then CPU.
    Auto,
    DirectML,
    Cpu,
}

impl EpChoice {
    pub fn as_str(&self) -> &'static str {
        match self {
            EpChoice::Auto => "auto",
            EpChoice::DirectML => "directml",
            EpChoice::Cpu => "cpu",
        }
    }

    /// Candidate EPs in trial order. Every list ends in CPU: parity failure or
    /// session failure falls closed to the trusted baseline.
    fn candidates(&self) -> Vec<EpKind> {
        match self {
            EpChoice::Auto | EpChoice::DirectML => vec![EpKind::DirectML, EpKind::Cpu],
            EpChoice::Cpu => vec![EpKind::Cpu],
        }
    }
}

/// Progress/diagnostic events for a front end to render (CLI prints to stderr).
#[derive(Debug)]
pub enum Event {
    ModelInit { ep: EpKind },
    ModelReady { ep: EpKind, seconds: f64 },
    ParityCheck { ep: EpKind },
    Parity(ParityReport),
    Fallback { from: EpKind, reason: String },
    Note(String),
}

pub struct PreparedModel {
    pub model: SepModel,
    pub reports: Vec<ParityReport>,
    /// Session-build time for the EP actually used.
    pub init_seconds: f64,
    /// Time spent on golden-segment parity/sanity inference (0 when cached).
    pub parity_seconds: f64,
}

/// Build a session on the best EP that passes its golden-segment check.
///
/// Order of events per candidate EP: cached pass → use it; otherwise run the
/// golden segment on the candidate and on a CPU baseline, require
/// SNR ≥ [`GOLDEN_SNR_THRESHOLD_DB`]. Any failure (session build, inference,
/// parity) falls through to the next candidate; the list always ends in CPU.
/// CPU itself gets a cheap RMS sanity check on the golden output.
pub fn prepare_model(
    model_paths: &[PathBuf],
    choice: EpChoice,
    parity_cache_path: Option<&Path>,
    on_event: &mut dyn FnMut(&Event),
) -> Result<PreparedModel> {
    let missing: Vec<String> = model_paths
        .iter()
        .filter(|p| !p.is_file())
        .map(|p| p.display().to_string())
        .collect();
    if !missing.is_empty() {
        return Err(Error::Model(format!(
            "model file(s) not found: {} — pass --model-dir or place them there",
            missing.join(", ")
        )));
    }
    let mut cache = parity_cache_path.map(|p| ParityCache::load_paths(p, model_paths));
    let mut reports: Vec<ParityReport> = Vec::new();
    // CPU baseline (session + golden output), built lazily, reused if we fall
    // back to CPU so the 310 MB-per-file model set is not loaded twice.
    let mut cpu_baseline: Option<(SepModel, Vec<f32>, f64, f64)> = None; // (model, golden_out, init_s, infer_s)
    let mut parity_seconds = 0.0f64;

    let build_cpu_baseline =
        |parity_seconds: &mut f64| -> Result<(SepModel, Vec<f32>, f64, f64)> {
            let t0 = std::time::Instant::now();
            let mut m = SepModel::load(model_paths, EpKind::Cpu)?;
            let init_s = t0.elapsed().as_secs_f64();
            let golden = golden_segment();
            let t1 = std::time::Instant::now();
            let out = m.infer(&golden)?;
            let infer_s = t1.elapsed().as_secs_f64();
            *parity_seconds += infer_s;
            let flat: Vec<f32> = out.iter().copied().collect();
            Ok((m, flat, init_s, infer_s))
        };

    let candidates = choice.candidates();
    let last = candidates.len() - 1;
    for (idx, ep) in candidates.into_iter().enumerate() {
        let is_last = idx == last;

        // Cached pass → skip golden inference entirely.
        if let Some(snr) = cache.as_ref().and_then(|c| c.cached_pass(ep.as_str())) {
            on_event(&Event::ModelInit { ep });
            let t0 = std::time::Instant::now();
            match reuse_or_load(ep, &mut cpu_baseline, model_paths) {
                Ok((m, init_s_override)) => {
                    let init_s = init_s_override.unwrap_or_else(|| t0.elapsed().as_secs_f64());
                    on_event(&Event::ModelReady { ep, seconds: init_s });
                    let report = ParityReport {
                        ep: ep.as_str().into(),
                        snr_db: if snr.is_nan() { None } else { Some(snr) },
                        passed: true,
                        from_cache: true,
                    };
                    on_event(&Event::Parity(report.clone()));
                    reports.push(report);
                    return Ok(PreparedModel {
                        model: m,
                        reports,
                        init_seconds: init_s,
                        parity_seconds,
                    });
                }
                Err(e) => {
                    on_event(&Event::Fallback {
                        from: ep,
                        reason: format!("session build failed: {e}"),
                    });
                    continue;
                }
            }
        }

        on_event(&Event::ModelInit { ep });
        match ep {
            EpKind::Cpu => {
                // Baseline sanity: golden output finite and plausibly scaled.
                on_event(&Event::ParityCheck { ep });
                let (m, flat, init_s, _infer_s) = match cpu_baseline.take() {
                    Some(b) => b,
                    None => build_cpu_baseline(&mut parity_seconds)?,
                };
                on_event(&Event::ModelReady { ep, seconds: init_s });
                let r = rms(&flat);
                let finite = flat.iter().all(|v| v.is_finite());
                let passed =
                    finite && r > parity::SANITY_RMS_MIN && r < parity::SANITY_RMS_MAX;
                let report = ParityReport {
                    ep: ep.as_str().into(),
                    snr_db: None,
                    passed,
                    from_cache: false,
                };
                on_event(&Event::Parity(report.clone()));
                if let Some(c) = cache.as_mut() {
                    c.record(ep.as_str(), None, passed);
                }
                reports.push(report);
                if !passed {
                    return Err(Error::Inference(format!(
                        "CPU golden-segment sanity check failed (rms={r:.3e}, finite={finite}) — \
                         model file may be corrupt"
                    )));
                }
                return Ok(PreparedModel {
                    model: m,
                    reports,
                    init_seconds: init_s,
                    parity_seconds,
                });
            }
            _ => {
                let t0 = std::time::Instant::now();
                let mut m = match SepModel::load(model_paths, ep) {
                    Ok(m) => m,
                    Err(e) => {
                        on_event(&Event::Fallback {
                            from: ep,
                            reason: format!("session build failed: {e}"),
                        });
                        debug_assert!(!is_last, "non-CPU EP must not be last candidate");
                        continue;
                    }
                };
                let init_s = t0.elapsed().as_secs_f64();
                on_event(&Event::ModelReady { ep, seconds: init_s });

                on_event(&Event::ParityCheck { ep });
                let golden = golden_segment();
                let t1 = std::time::Instant::now();
                let candidate_out = match m.infer(&golden) {
                    Ok(o) => o,
                    Err(e) => {
                        on_event(&Event::Fallback {
                            from: ep,
                            reason: format!("golden-segment inference failed: {e}"),
                        });
                        continue;
                    }
                };
                parity_seconds += t1.elapsed().as_secs_f64();
                if cpu_baseline.is_none() {
                    match build_cpu_baseline(&mut parity_seconds) {
                        Ok(b) => cpu_baseline = Some(b),
                        Err(e) => {
                            return Err(Error::Inference(format!(
                                "cannot build CPU parity baseline: {e}"
                            )))
                        }
                    }
                }
                let baseline = &cpu_baseline.as_ref().unwrap().1;
                let cand_flat: Vec<f32> = candidate_out.iter().copied().collect();
                let snr = snr_db(baseline, &cand_flat);
                let passed = snr.is_finite() && snr >= GOLDEN_SNR_THRESHOLD_DB
                    || snr.is_infinite() && snr > 0.0;
                let report = ParityReport {
                    ep: ep.as_str().into(),
                    snr_db: Some(snr),
                    passed,
                    from_cache: false,
                };
                on_event(&Event::Parity(report.clone()));
                if let Some(c) = cache.as_mut() {
                    c.record(ep.as_str(), Some(snr), passed);
                }
                reports.push(report);
                if passed {
                    return Ok(PreparedModel {
                        model: m,
                        reports,
                        init_seconds: init_s,
                        parity_seconds,
                    });
                }
                on_event(&Event::Fallback {
                    from: ep,
                    reason: format!(
                        "golden-segment parity {snr:.1} dB < {GOLDEN_SNR_THRESHOLD_DB:.0} dB — \
                         falling back (output would be unreliable)"
                    ),
                });
            }
        }
    }
    Err(Error::Model("no usable execution provider".into()))
}

/// For a cached-pass EP: reuse the already-built CPU baseline session when the
/// EP is CPU, otherwise build the EP session. Returns optional init-time
/// override when reusing.
fn reuse_or_load(
    ep: EpKind,
    cpu_baseline: &mut Option<(SepModel, Vec<f32>, f64, f64)>,
    model_paths: &[PathBuf],
) -> Result<(SepModel, Option<f64>)> {
    if ep == EpKind::Cpu {
        if let Some((m, _, init_s, _)) = cpu_baseline.take() {
            return Ok((m, Some(init_s)));
        }
    }
    Ok((SepModel::load(model_paths, ep)?, None))
}

/// Default per-user model directory: `%LOCALAPPDATA%/karaoke/models` on
/// Windows, `~/.local/share/karaoke/models` elsewhere.
pub fn default_model_dir() -> PathBuf {
    if let Ok(lad) = std::env::var("LOCALAPPDATA") {
        return PathBuf::from(lad).join("karaoke").join("models");
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home)
            .join(".local")
            .join("share")
            .join("karaoke")
            .join("models");
    }
    PathBuf::from(".")
}

/// Default parity-cache path, next to the models.
pub fn default_parity_cache_path() -> PathBuf {
    default_model_dir()
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
        .join("ep-parity.json")
}

#[cfg(test)]
mod smoke {
    //! Golden-file smoke test (ML inference gets smoke tests, not unit-test
    //! theater — CLAUDE.md). Needs the real model; run with:
    //! `KARAOKE_TEST_MODEL=path\to\htdemucs.onnx cargo test -- --ignored`
    use super::*;

    #[test]
    #[ignore = "needs htdemucs.onnx (set KARAOKE_TEST_MODEL)"]
    fn cpu_golden_segment_smoke() {
        let model_path = std::env::var("KARAOKE_TEST_MODEL")
            .expect("set KARAOKE_TEST_MODEL to the htdemucs.onnx path");
        let mut events = Vec::new();
        let prepared = prepare_model(
            &[PathBuf::from(&model_path)],
            EpChoice::Cpu,
            None,
            &mut |e| events.push(format!("{e:?}")),
        )
        .unwrap();
        assert_eq!(prepared.model.ep, EpKind::Cpu);
        assert!(prepared.reports.iter().all(|r| r.passed), "{events:?}");
    }
}
