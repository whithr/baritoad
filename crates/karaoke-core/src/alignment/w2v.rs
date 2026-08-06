//! wav2vec2-base-960h CTC emissions via ONNX Runtime, chunked with overlap
//! stitching, log-softmax normalized.
//!
//! Execution provider: DirectML measured **13x faster** than 8-core CPU for
//! these emissions (28.3 s → 2.1 s on she-said — spikes/alignment/REPORT.md).
//! Two hazards are mitigated before it may be trusted:
//!
//! 1. **TDR resets.** A 30 s chunk is one large dispatch; on an RTX 2080
//!    SUPER those exceeded Windows' ~2 s TDR budget under load, resetting the
//!    display driver (System event 4101 / nvlddmkm) and crashing unrelated
//!    GPU apps. DML therefore runs [`CHUNK_SEC_DML`]-second chunks: attention
//!    cost scales quadratically with chunk length, so 10 s dispatches carry
//!    ≤ 1/9 the attention work and stay far inside the watchdog budget. (The
//!    dev-only alternative — raising TdrDelay — is deliberately not used.)
//! 2. **Silent garbage.** The separation spike caught DirectML producing
//!    *finite* wrong numbers with no error (graph fusion bug); the non-finite
//!    check below cannot see that failure mode. So a DML session must pass a
//!    golden-signal parity check against a CPU baseline at load (SNR ≥ the
//!    separation stage's threshold, cached per model+EP in the shared
//!    ep-parity cache) before it is used.
//!
//! Failures still fall closed at every layer: session build → CPU, parity
//! fail → CPU, non-finite emissions mid-song → CPU rebuild + retry.

use std::collections::HashMap;
use std::path::Path;

use ort::session::Session;
use ort::value::Tensor;

use crate::error::{Error, Result};
use crate::separation::{snr_db, ParityCache, GOLDEN_SNR_THRESHOLD_DB};

/// wav2vec2 emission frame duration: 320 input samples at 16 kHz = 20 ms.
pub const FRAME_SEC: f64 = 320.0 / 16000.0;
/// CPU chunk length: large chunks minimize overlap waste; latency per chunk
/// is irrelevant on CPU.
const CHUNK_SEC_CPU: usize = 30;
/// DirectML chunk length: bounds per-dispatch GPU work under the Windows TDR
/// watchdog (module docs, hazard 1).
const CHUNK_SEC_DML: usize = 10;
const OVERLAP_SEC: usize = 4; // 2 s discarded on each side of interior joins
pub const MODEL_FILE: &str = "wav2vec2-base-960h.onnx";
/// EP name key for the shared parity cache (distinct from separation's
/// "directml" only via the model identity the cache also records).
const PARITY_EP_KEY: &str = "directml";
/// Golden parity signal length (seconds). Small enough to be a trivially
/// TDR-safe dispatch, long enough to exercise the conv frontend + attention.
const GOLDEN_SEC: usize = 5;

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

/// Deterministic speech-shaped golden signal: syllabic-rate (~3 Hz) amplitude
/// envelope over harmonics in the vocal band, plus low-level noise.
/// Determinism only needs to hold within one machine (the CPU baseline is
/// computed on the same machine).
fn golden_signal() -> Vec<f32> {
    let sr = 16_000usize;
    let mut state: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut noise = move || {
        // xorshift64* — deterministic, dependency-free
        state ^= state >> 12;
        state ^= state << 25;
        state ^= state >> 27;
        let r = state.wrapping_mul(0x2545_F491_4F6C_DD1D);
        (r >> 40) as f32 / (1u64 << 24) as f32 - 0.5
    };
    let tau = 2.0 * std::f32::consts::PI;
    (0..GOLDEN_SEC * sr)
        .map(|i| {
            let t = i as f32 / sr as f32;
            let syllable = (tau * 3.0 * t).sin().abs();
            let tones = 0.08 * (tau * 180.0 * t).sin()
                + 0.05 * (tau * 360.0 * t).sin()
                + 0.03 * (tau * 720.0 * t).sin()
                + 0.02 * (tau * 1440.0 * t).sin();
            syllable * tones + 0.01 * noise()
        })
        .collect()
}

/// One whole-signal inference pass → per-frame log-softmax rows (the same
/// math as `emissions_inner` without chunking/trimming — the golden signal
/// fits in a single chunk on every EP).
fn run_logprobs(session: &mut Session, audio: &[f32], do_normalize: bool) -> Result<Vec<f32>> {
    let mut seg = audio.to_vec();
    if do_normalize {
        let mean = seg.iter().sum::<f32>() / seg.len() as f32;
        let var = seg.iter().map(|v| (v - mean) * (v - mean)).sum::<f32>() / seg.len() as f32;
        let denom = (var + 1e-7).sqrt();
        for v in seg.iter_mut() {
            *v = (*v - mean) / denom;
        }
    }
    let n = seg.len();
    let input = Tensor::from_array((vec![1usize, n], seg))?;
    let out = session.run(ort::inputs!["input_values" => input])?;
    let (shape, data) = out["logits"].try_extract_tensor::<f32>()?;
    let t = shape[1] as usize;
    let c = shape[2] as usize;
    let mut all = Vec::with_capacity(t * c);
    for f in 0..t {
        let row = &data[f * c..(f + 1) * c];
        let m = row.iter().cloned().fold(f32::MIN, f32::max);
        let lse = m + row.iter().map(|v| (v - m).exp()).sum::<f32>().ln();
        all.extend(row.iter().map(|v| v - lse));
    }
    Ok(all)
}

/// Outcome of the DML golden-parity gate (module docs, hazard 2).
struct ParityOutcome {
    passed: bool,
    snr_db: Option<f64>,
    from_cache: bool,
    /// The CPU baseline session, when one was built — reused as the fallback
    /// session on parity failure so the 360 MB model is not loaded twice.
    cpu_session: Option<Session>,
}

/// Gate a freshly built DirectML session behind a golden-signal parity check
/// against a CPU baseline (cached per model+EP in the shared ep-parity file).
fn dml_parity_gate(
    dir: &Path,
    threads: usize,
    dml: &mut Session,
    do_normalize: bool,
) -> Result<ParityOutcome> {
    let model_path = dir.join(MODEL_FILE);
    let cache_path = crate::separation::default_parity_cache_path();
    let mut cache = ParityCache::load(&cache_path, &model_path);
    if let Some(snr) = cache.cached_pass(PARITY_EP_KEY) {
        return Ok(ParityOutcome {
            passed: true,
            snr_db: (!snr.is_nan()).then_some(snr),
            from_cache: true,
            cpu_session: None,
        });
    }
    let golden = golden_signal();
    let candidate = run_logprobs(dml, &golden, do_normalize)?;
    let mut cpu = build_session(dir, threads, W2vEp::Cpu)?;
    let baseline = run_logprobs(&mut cpu, &golden, do_normalize)?;
    let snr = snr_db(&baseline, &candidate);
    let passed =
        snr.is_finite() && snr >= GOLDEN_SNR_THRESHOLD_DB || snr.is_infinite() && snr > 0.0;
    cache.record(PARITY_EP_KEY, Some(snr), passed);
    Ok(ParityOutcome {
        passed,
        snr_db: Some(snr),
        from_cache: false,
        cpu_session: Some(cpu),
    })
}

impl W2v {
    /// Load the wav2vec2 session from a model directory. When `try_dml` is
    /// set, DirectML is attempted first — gated behind the golden-signal
    /// parity check (module docs, hazard 2) — and CPU is the fallback at
    /// every layer.
    pub fn load(dir: &Path, threads: usize, try_dml: bool) -> Result<(Self, Option<String>)> {
        // do_normalize is needed before any parity inference can run.
        let pre: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("preprocessor_config.json"))?)
                .map_err(|e| Error::Model(format!("wav2vec2 preprocessor_config.json: {e}")))?;
        let do_normalize = pre["do_normalize"].as_bool().unwrap_or(false);

        let mut note = None;
        let (session, ep) = if try_dml {
            match build_session(dir, threads, W2vEp::DirectML) {
                Ok(mut dml) => match dml_parity_gate(dir, threads, &mut dml, do_normalize) {
                    Ok(o) if o.passed => {
                        note = Some(match (o.from_cache, o.snr_db) {
                            (true, _) => "wav2vec2 DirectML parity: pass (cached)".to_string(),
                            (false, Some(s)) => {
                                format!("wav2vec2 DirectML parity: pass ({s:.1} dB)")
                            }
                            (false, None) => "wav2vec2 DirectML parity: pass".to_string(),
                        });
                        (dml, W2vEp::DirectML)
                    }
                    Ok(o) => {
                        note = Some(format!(
                            "wav2vec2 DirectML parity FAIL ({}) — using CPU",
                            o.snr_db.map(|s| format!("{s:.1} dB")).unwrap_or_default()
                        ));
                        let cpu = match o.cpu_session {
                            Some(s) => s,
                            None => build_session(dir, threads, W2vEp::Cpu)?,
                        };
                        (cpu, W2vEp::Cpu)
                    }
                    Err(e) => {
                        note = Some(format!(
                            "wav2vec2 DirectML parity check failed to run ({e}) — using CPU"
                        ));
                        (build_session(dir, threads, W2vEp::Cpu)?, W2vEp::Cpu)
                    }
                },
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

    /// Full-song emissions. EP-sized chunks ([`CHUNK_SEC_CPU`] /
    /// [`CHUNK_SEC_DML`]) with `OVERLAP_SEC` overlap;
    /// interior chunk edges are discarded (half the overlap each side) before
    /// concatenation. Fails closed: non-finite emissions on a GPU EP trigger
    /// one CPU rebuild + retry. `on_chunk(done, total)` fires after each
    /// chunk's inference (restarts from 1 on the CPU retry).
    pub fn emissions(
        &mut self,
        audio16k: &[f32],
        on_chunk: &mut dyn FnMut(usize, usize),
    ) -> Result<Emissions> {
        let em = self.emissions_inner(audio16k, on_chunk)?;
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
        let em = self.emissions_inner(audio16k, on_chunk)?;
        if em.logprobs.iter().all(|v| v.is_finite()) {
            Ok(em)
        } else {
            Err(Error::Inference(
                "wav2vec2 emissions contain non-finite values on CPU".into(),
            ))
        }
    }

    fn emissions_inner(
        &mut self,
        audio16k: &[f32],
        on_chunk: &mut dyn FnMut(usize, usize),
    ) -> Result<Emissions> {
        let sr = 16000usize;
        // Read the chunk length from the current EP each call: after a
        // mid-song CPU fallback the retry automatically widens to CPU chunks.
        let chunk_sec = match self.ep {
            W2vEp::DirectML => CHUNK_SEC_DML,
            W2vEp::Cpu => CHUNK_SEC_CPU,
        };
        let chunk = chunk_sec * sr;
        let overlap = OVERLAP_SEC * sr;
        let hop = chunk - overlap;
        let trim_frames = (OVERLAP_SEC as f64 / 2.0 / FRAME_SEC) as usize; // frames cut per interior edge

        let n_chunks = if audio16k.len() <= chunk {
            1
        } else {
            1 + (audio16k.len() - chunk).div_ceil(hop)
        };
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
            on_chunk(chunk_idx + 1, n_chunks);
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
