//! wav2vec2-base-960h CTC emissions via ONNX Runtime, chunked with overlap
//! stitching, log-softmax normalized.

use anyhow::{Context, Result};
use ort::session::Session;
use ort::value::Tensor;
use std::collections::HashMap;
use std::path::Path;

pub const FRAME_SEC: f64 = 320.0 / 16000.0; // 20 ms per emission frame
const CHUNK_SEC: usize = 30;
const OVERLAP_SEC: usize = 4; // 2 s discarded on each side of interior joins

pub struct W2v {
    session: Session,
    pub vocab: HashMap<String, usize>, // char -> id
    pub blank: usize,
    pub word_delim: usize,
    do_normalize: bool,
}

pub struct Emissions {
    pub logprobs: Vec<f32>, // [T][C] row-major
    pub n_frames: usize,
    pub n_vocab: usize,
}

impl W2v {
    pub fn load(dir: &Path, threads: usize, dml: bool) -> Result<Self> {
        let session = crate::whisper::session_builder(threads, dml)?
            .commit_from_file(dir.join("wav2vec2-base-960h.onnx"))
            .with_context(|| "load wav2vec2 onnx")?;
        let vocab_json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("vocab.json"))?)?;
        let mut vocab = HashMap::new();
        for (k, v) in vocab_json.as_object().unwrap() {
            vocab.insert(k.clone(), v.as_u64().unwrap() as usize);
        }
        let blank = vocab["<pad>"];
        let word_delim = vocab["|"];
        let pre: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("preprocessor_config.json"))?)?;
        let do_normalize = pre["do_normalize"].as_bool().unwrap_or(false);
        Ok(Self { session, vocab, blank, word_delim, do_normalize })
    }

    /// Full-song emissions. Chunks of CHUNK_SEC with OVERLAP_SEC overlap; interior
    /// chunk edges are discarded (half the overlap each side) before concatenation.
    pub fn emissions(&mut self, audio16k: &[f32]) -> Result<Emissions> {
        let sr = 16000usize;
        let chunk = CHUNK_SEC * sr;
        let overlap = OVERLAP_SEC * sr;
        let hop = chunk - overlap;
        let trim_frames = (OVERLAP_SEC as f64 / 2.0 / FRAME_SEC) as usize; // frames cut per interior edge

        let mut all: Vec<f32> = Vec::new();
        let mut n_frames_total = 0usize;
        let mut n_vocab = 0usize;
        let mut start = 0usize;
        let mut chunk_idx = 0usize;
        loop {
            let end = (start + chunk).min(audio16k.len());
            let mut seg = audio16k[start..end].to_vec();
            let is_first = chunk_idx == 0;
            let is_last = end == audio16k.len();
            if self.do_normalize {
                let mean = seg.iter().sum::<f32>() / seg.len() as f32;
                let var = seg.iter().map(|v| (v - mean) * (v - mean)).sum::<f32>() / seg.len() as f32;
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
            n_vocab = c;
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
        Ok(Emissions { logprobs: all, n_frames: n_frames_total, n_vocab })
    }
}

/// Map a normalized transcript (uppercase words) to CTC target token ids with
/// '|' separators: |WORD|WORD|...|  Returns (ids, word_char_ranges) where each
/// word range indexes into `ids` (start..end of its letter tokens).
pub fn transcript_to_targets(
    words: &[String],
    vocab: &HashMap<String, usize>,
    word_delim: usize,
) -> (Vec<usize>, Vec<(usize, usize)>) {
    let mut ids = vec![word_delim];
    let mut ranges = Vec::with_capacity(words.len());
    for w in words {
        let s = ids.len();
        for ch in w.chars() {
            if let Some(&id) = vocab.get(&ch.to_string()) {
                ids.push(id);
            }
        }
        let e = ids.len();
        ids.push(word_delim);
        ranges.push((s, e));
    }
    (ids, ranges)
}
