//! wav2vec2-base-960h CTC emissions via ONNX Runtime, chunked with overlap
//! stitching, log-softmax normalized.
//!
//! Execution provider: DirectML measured **13x faster** than 8-core CPU for
//! these emissions (28.3 s → 2.1 s on she-said — spikes/alignment/REPORT.md),
//! but it is **not safe to enable by default**. Each 30 s chunk is a single
//! large dispatch, and on an RTX 2080 SUPER these dispatches can exceed
//! Windows' ~2 s TDR budget: the OS resets the display driver (System event
//! 4101 / nvlddmkm), which crashes unrelated GPU-accelerated apps on the
//! user's desktop even when our own run happens to succeed. Product fix
//! direction before DML becomes the alignment default: bound per-dispatch
//! work (smaller model input chunks / smaller command lists), not raising
//! TdrDelay — that is a dev-only workaround. Until then DML here is opt-in
//! ([`crate::alignment::AlignConfig::w2v_try_dml`]), and failures still fall
//! closed: a session-build failure or non-finite emissions on a GPU EP fall
//! back to CPU.

use std::collections::HashMap;
use std::path::Path;

use ort::session::Session;
use ort::value::Tensor;

use crate::error::{Error, Result};

/// wav2vec2 emission frame duration: 320 input samples at 16 kHz = 20 ms.
pub const FRAME_SEC: f64 = 320.0 / 16000.0;
const CHUNK_SEC: usize = 30;
const OVERLAP_SEC: usize = 4; // 2 s discarded on each side of interior joins
pub const MODEL_FILE: &str = "wav2vec2-base-960h.onnx";

/// EP actually used by the wav2vec2 session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum W2vEp {
    DirectML,
    Cpu,
}

impl W2vEp {
    pub fn as_str(&self) -> &'static str {
        match self {
            W2vEp::DirectML => "directml",
            W2vEp::Cpu => "cpu",
        }
    }
}

pub struct W2v {
    session: Session,
    pub ep: W2vEp,
    pub vocab: HashMap<String, usize>, // char -> id
    pub blank: usize,
    pub word_delim: usize,
    do_normalize: bool,
    dir: std::path::PathBuf,
    threads: usize,
}

pub struct Emissions {
    pub logprobs: Vec<f32>, // [T][C] row-major
    pub n_frames: usize,
    pub n_vocab: usize,
}

fn build_session(dir: &Path, threads: usize, ep: W2vEp) -> Result<Session> {
    let path = dir.join(MODEL_FILE);
    let mut b = Session::builder()?.with_intra_threads(threads)?;
    if ep == W2vEp::DirectML {
        b = b.with_execution_providers([ort::ep::DirectML::default().build().error_on_failure()])?;
    }
    b.commit_from_file(&path)
        .map_err(|e| Error::Model(format!("load {} ({}): {e}", path.display(), ep.as_str())))
}

impl W2v {
    /// Load the wav2vec2 session from a model directory. When `try_dml` is
    /// set, DirectML is attempted first and CPU is the fallback.
    pub fn load(dir: &Path, threads: usize, try_dml: bool) -> Result<(Self, Option<String>)> {
        let mut note = None;
        let (session, ep) = if try_dml {
            match build_session(dir, threads, W2vEp::DirectML) {
                Ok(s) => (s, W2vEp::DirectML),
                Err(e) => {
                    note = Some(format!("wav2vec2 DirectML unavailable, using CPU: {e}"));
                    (build_session(dir, threads, W2vEp::Cpu)?, W2vEp::Cpu)
                }
            }
        } else {
            (build_session(dir, threads, W2vEp::Cpu)?, W2vEp::Cpu)
        };
        let vocab_json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("vocab.json"))?)
                .map_err(|e| Error::Model(format!("wav2vec2 vocab.json: {e}")))?;
        let mut vocab = HashMap::new();
        for (k, v) in vocab_json
            .as_object()
            .ok_or_else(|| Error::Model("wav2vec2 vocab.json is not an object".into()))?
        {
            vocab.insert(
                k.clone(),
                v.as_u64()
                    .ok_or_else(|| Error::Model("non-integer vocab id".into()))?
                    as usize,
            );
        }
        let blank = *vocab
            .get("<pad>")
            .ok_or_else(|| Error::Model("wav2vec2 vocab missing <pad>".into()))?;
        let word_delim = *vocab
            .get("|")
            .ok_or_else(|| Error::Model("wav2vec2 vocab missing '|'".into()))?;
        let pre: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("preprocessor_config.json"))?)
                .map_err(|e| Error::Model(format!("wav2vec2 preprocessor_config.json: {e}")))?;
        let do_normalize = pre["do_normalize"].as_bool().unwrap_or(false);
        Ok((
            Self {
                session,
                ep,
                vocab,
                blank,
                word_delim,
                do_normalize,
                dir: dir.to_path_buf(),
                threads,
            },
            note,
        ))
    }

    /// Full-song emissions. Chunks of `CHUNK_SEC` with `OVERLAP_SEC` overlap;
    /// interior chunk edges are discarded (half the overlap each side) before
    /// concatenation. Fails closed: non-finite emissions on a GPU EP trigger
    /// one CPU rebuild + retry.
    pub fn emissions(&mut self, audio16k: &[f32]) -> Result<Emissions> {
        let em = self.emissions_inner(audio16k)?;
        if em.logprobs.iter().all(|v| v.is_finite()) {
            return Ok(em);
        }
        if self.ep == W2vEp::Cpu {
            return Err(Error::Inference(
                "wav2vec2 emissions contain non-finite values on CPU".into(),
            ));
        }
        // GPU EP produced garbage — fall closed to CPU (same policy as the
        // separation stage's parity check).
        self.session = build_session(&self.dir, self.threads, W2vEp::Cpu)?;
        self.ep = W2vEp::Cpu;
        let em = self.emissions_inner(audio16k)?;
        if em.logprobs.iter().all(|v| v.is_finite()) {
            Ok(em)
        } else {
            Err(Error::Inference(
                "wav2vec2 emissions contain non-finite values on CPU".into(),
            ))
        }
    }

    fn emissions_inner(&mut self, audio16k: &[f32]) -> Result<Emissions> {
        let sr = 16000usize;
        let chunk = CHUNK_SEC * sr;
        let overlap = OVERLAP_SEC * sr;
        let hop = chunk - overlap;
        let trim_frames = (OVERLAP_SEC as f64 / 2.0 / FRAME_SEC) as usize; // frames cut per interior edge

        let mut all: Vec<f32> = Vec::new();
        let mut n_frames_total = 0usize;
        let mut n_vocab: Option<usize> = None;
        let mut start = 0usize;
        let mut chunk_idx = 0usize;
        loop {
            let end = (start + chunk).min(audio16k.len());
            let mut seg = audio16k[start..end].to_vec();
            let is_first = chunk_idx == 0;
            let is_last = end == audio16k.len();
            if self.do_normalize {
                let mean = seg.iter().sum::<f32>() / seg.len() as f32;
                let var =
                    seg.iter().map(|v| (v - mean) * (v - mean)).sum::<f32>() / seg.len() as f32;
                let denom = (var + 1e-7).sqrt();
                for v in seg.iter_mut() {
                    *v = (*v - mean) / denom;
                }
            }
            let n = seg.len();
            let input = Tensor::from_array((vec![1usize, n], seg))?;
            let out = self.session.run(ort::inputs!["input_values" => input])?;
            let (shape, data) = out["logits"].try_extract_tensor::<f32>()?;
            let t = shape[1] as usize;
            let c = shape[2] as usize;
            if n_vocab.is_none() {
                n_vocab = Some(c);
            }
            // log-softmax per frame, trimming interior edges
            let f_lo = if is_first { 0 } else { trim_frames };
            let f_hi = if is_last { t } else { t - trim_frames };
            for f in f_lo..f_hi {
                let row = &data[f * c..(f + 1) * c];
                let m = row.iter().cloned().fold(f32::MIN, f32::max);
                let lse = m + row.iter().map(|v| (v - m).exp()).sum::<f32>().ln();
                all.extend(row.iter().map(|v| v - lse));
            }
            n_frames_total += f_hi - f_lo;
            if is_last {
                break;
            }
            start += hop;
            chunk_idx += 1;
        }
        Ok(Emissions {
            logprobs: all,
            n_frames: n_frames_total,
            n_vocab: n_vocab
                .ok_or_else(|| Error::Inference("wav2vec2 produced no emissions".into()))?,
        })
    }
}

/// Map normalized words to CTC target token ids with '|' separators:
/// `|WORD|WORD|...|`. Returns `(ids, word_token_ranges)` where each range
/// indexes into `ids` (start..end of that word's letter tokens). Words whose
/// characters are all outside the vocab produce empty ranges.
pub fn words_to_targets(
    norm_words: &[&str],
    vocab: &HashMap<String, usize>,
    word_delim: usize,
) -> (Vec<usize>, Vec<(usize, usize)>) {
    let mut ids = vec![word_delim];
    let mut ranges = Vec::with_capacity(norm_words.len());
    for w in norm_words {
        let s = ids.len();
        for ch in w.chars() {
            if let Some(&id) = vocab.get(&ch.to_string()) {
                ids.push(id);
            }
        }
        let e = ids.len();
        if e > s {
            ids.push(word_delim);
        }
        ranges.push((s, e));
    }
    (ids, ranges)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vocab() -> HashMap<String, usize> {
        let mut v = HashMap::new();
        v.insert("<pad>".into(), 0);
        v.insert("|".into(), 4);
        v.insert("A".into(), 7);
        v.insert("B".into(), 8);
        v.insert("'".into(), 27);
        v
    }

    #[test]
    fn targets_have_delimiters_and_ranges() {
        let v = vocab();
        let (ids, ranges) = words_to_targets(&["AB", "BA"], &v, 4);
        assert_eq!(ids, vec![4, 7, 8, 4, 8, 7, 4]);
        assert_eq!(ranges, vec![(1, 3), (4, 6)]);
    }

    #[test]
    fn out_of_vocab_chars_are_dropped() {
        let v = vocab();
        // 'Z' not in the toy vocab
        let (ids, ranges) = words_to_targets(&["AZB"], &v, 4);
        assert_eq!(ids, vec![4, 7, 8, 4]);
        assert_eq!(ranges, vec![(1, 3)]);
    }

    #[test]
    fn fully_out_of_vocab_word_yields_empty_range() {
        let v = vocab();
        let (ids, ranges) = words_to_targets(&["ZZ", "A"], &v, 4);
        assert_eq!(ids, vec![4, 7, 4]);
        assert_eq!(ranges[0].0, ranges[0].1, "empty range for unalignable word");
        assert_eq!(ranges[1], (1, 2));
    }
}
