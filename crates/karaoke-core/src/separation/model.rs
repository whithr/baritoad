//! ONNX Runtime session wrapper for the htdemucs export.
//!
//! Execution-provider selection is deliberately a closed enum with room to
//! grow: CUDA (Win/Linux NVIDIA) and CoreML (macOS) slot in as new variants +
//! arms in [`OrtModel::load`] without touching callers (PLAN.md §5 GPU story).

use ndarray::{s, Array3, Array4, Ix4};
use std::fmt;
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};
use crate::separation::{NUM_SOURCES, SEGMENT, SOURCES};

/// A concrete execution provider we can build a session on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum EpKind {
    /// DirectML (Windows GPU). Graph fusion is force-disabled: the spike
    /// measured that DML fusion silently corrupts htdemucs output (stem RMS
    /// ~15,000 vs ~0.14 with no error raised) — spikes/separation/REPORT.md.
    DirectML,
    /// CPU — the trusted parity baseline, available everywhere.
    Cpu,
    // Future: Cuda, CoreMl — add a variant + a `load` arm + ort feature flag.
}

impl EpKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            EpKind::DirectML => "directml",
            EpKind::Cpu => "cpu",
        }
    }
}

impl fmt::Display for EpKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One-segment htdemucs inference: `(1, 2, SEGMENT)` mix in,
/// `(1, 4, 2, SEGMENT)` stems out. Mockable for overlap-add tests.
pub trait SegmentInfer {
    fn infer(&mut self, input: &Array3<f32>) -> Result<Array4<f32>>;
}

pub struct OrtModel {
    session: ort::session::Session,
    pub ep: EpKind,
}

impl OrtModel {
    pub fn load(model_path: &Path, ep: EpKind) -> Result<Self> {
        if !model_path.is_file() {
            return Err(Error::Model(format!(
                "model file not found: {}",
                model_path.display()
            )));
        }
        let mut builder = ort::session::Session::builder()?
            .with_optimization_level(ort::session::builder::GraphOptimizationLevel::Level3)?;
        match ep {
            EpKind::DirectML => {
                builder = builder
                    // Never remove: DML graph fusion silently corrupts output
                    // (spikes/separation/REPORT.md risk 1). Costs ~15% speed.
                    .with_config_entry("ep.dml.disable_graph_fusion", "1")?
                    .with_execution_providers([
                        ort::ep::DirectML::default().build().error_on_failure()
                    ])?;
            }
            EpKind::Cpu => {}
        }
        let session = builder
            .commit_from_file(model_path)
            .map_err(|e| Error::Model(format!("load {} ({ep}): {e}", model_path.display())))?;
        Ok(Self { session, ep })
    }
}

/// A separation model as prepared for inference: either the single htdemucs
/// session, or the htdemucs_ft bag — four sessions, each fine-tuned for one
/// source, combined one-hot (sub-model k contributes stem k, matching the
/// bag's `[[1,0,0,0], …]` weights, asserted at export time by
/// spikes/separation/export/export_htdemucs_ft.py).
pub struct SepModel {
    subs: Vec<OrtModel>,
    pub ep: EpKind,
}

impl SepModel {
    /// `paths` must have length 1 (htdemucs) or [`NUM_SOURCES`] in [`SOURCES`]
    /// order (htdemucs_ft).
    pub fn load(paths: &[PathBuf], ep: EpKind) -> Result<Self> {
        if paths.len() != 1 && paths.len() != NUM_SOURCES {
            return Err(Error::Model(format!(
                "expected 1 or {NUM_SOURCES} model files, got {}",
                paths.len()
            )));
        }
        let subs = paths
            .iter()
            .map(|p| OrtModel::load(p, ep))
            .collect::<Result<Vec<_>>>()?;
        Ok(Self { subs, ep })
    }

    /// Inference sweeps per segment (for cost/progress accounting).
    pub fn sub_models(&self) -> usize {
        self.subs.len()
    }
}

impl SegmentInfer for SepModel {
    fn infer(&mut self, input: &Array3<f32>) -> Result<Array4<f32>> {
        if self.subs.len() == 1 {
            return self.subs[0].infer(input);
        }
        let mut out = Array4::<f32>::zeros((1, NUM_SOURCES, 2, SEGMENT));
        for k in 0..NUM_SOURCES {
            let stems = self.subs[k].infer(input).map_err(|e| {
                Error::Inference(format!("{} sub-model: {e}", SOURCES[k]))
            })?;
            out.slice_mut(s![0, k, .., ..])
                .assign(&stems.slice(s![0, k, .., ..]));
        }
        Ok(out)
    }
}

impl SegmentInfer for OrtModel {
    fn infer(&mut self, input: &Array3<f32>) -> Result<Array4<f32>> {
        debug_assert_eq!(input.shape(), &[1, 2, SEGMENT]);
        let outputs = self.session.run(ort::inputs![
            "mix" => ort::value::TensorRef::from_array_view(input)?
        ])?;
        let view = outputs["stems"].try_extract_array::<f32>()?;
        let stems = view
            .to_owned()
            .into_dimensionality::<Ix4>()
            .map_err(|e| Error::Inference(format!("unexpected output rank: {e}")))?;
        if stems.shape() != [1, NUM_SOURCES, 2, SEGMENT] {
            return Err(Error::Inference(format!(
                "unexpected output shape {:?}",
                stems.shape()
            )));
        }
        Ok(stems)
    }
}
