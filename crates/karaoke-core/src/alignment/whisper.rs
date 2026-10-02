//! whisper-small greedy transcription via ONNX Runtime (encoder + merged
//! KV-cache decoder, optimum export layout).
//!
//! Ported from spikes/alignment with its ort sharp-edge fixes kept intact:
//! - KV cache entries are **moved** out of the outputs and fed back **by
//!   view** — a naive copy-per-step loop measured 2x slower whisper decode
//!   (99.7 s → 46.1 s, spikes/alignment/REPORT.md risk 3). Do not "simplify"
//!   this into copies.
//! - zero-length KV tensors (first decode step) must be created through the
//!   allocator API; raw-data creation rejects a 0 dimension.
//! - The merged KV-cache decoder runs on **CPU always**: on the RTX 2080
//!   SUPER DirectML measured ~4x slower than 8-core CPU for it (dynamic
//!   shapes). The encoder may run on DirectML ([`Whisper::load`] `try_dml`):
//!   82 ms vs 797 ms per 30 s chunk on 6 CPU threads, 104.7 dB parity
//!   (2026-09-30), gated by a golden check against a CPU baseline and
//!   cached in the shared ep-parity cache.
//!
//! Sessions are built once in [`Whisper::load`] and reused for every chunk and
//! every subsequent song (session reuse per the Phase 1 hardening list).

use std::collections::HashMap;
use std::path::Path;

use ort::session::Session;
use ort::value::Tensor;

use crate::alignment::chunk::Chunk;
use crate::alignment::mel;
use crate::error::{Error, Result};
use crate::separation::{snr_db, ParityCache, GOLDEN_SNR_THRESHOLD_DB};

pub const SOT: i64 = 50258;
pub const LANG_EN: i64 = 50259;
pub const TRANSCRIBE: i64 = 50359;
pub const NO_TIMESTAMPS: i64 = 50363;
pub const EOT: i64 = 50257;
pub const TIMESTAMP_BEGIN: i64 = 50364;
pub const MAX_NEW_TOKENS: usize = 224;

pub struct WhisperTokenizer {
    id_to_token: HashMap<i64, String>,
    byte_map: HashMap<char, u8>, // inverse of GPT-2 byte-level unicode mapping
}

impl WhisperTokenizer {
    pub fn load(tokenizer_json: &Path) -> Result<Self> {
        let text = std::fs::read_to_string(tokenizer_json)?;
        let v: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| Error::Model(format!("tokenizer.json: {e}")))?;
        let vocab = v["model"]["vocab"]
            .as_object()
            .ok_or_else(|| Error::Model("no model.vocab in tokenizer.json".into()))?;
        let mut id_to_token = HashMap::with_capacity(vocab.len() + 1600);
        for (tok, id) in vocab {
            let id = id
                .as_i64()
                .ok_or_else(|| Error::Model("non-integer token id".into()))?;
            id_to_token.insert(id, tok.clone());
        }
        if let Some(added) = v["added_tokens"].as_array() {
            for a in added {
                if let (Some(id), Some(content)) = (a["id"].as_i64(), a["content"].as_str()) {
                    id_to_token.insert(id, content.to_string());
                }
            }
        }
        // GPT-2 byte-level encoding: printable bytes map to themselves; the
        // rest map to U+0100.. in order.
        let mut byte_map = HashMap::new();
        let mut printable: Vec<u8> = (b'!'..=b'~').collect();
        printable.extend(0xA1u8..=0xAC);
        printable.extend(0xAEu8..=0xFF);
        let mut n = 0u32;
        for b in 0u16..256 {
            let b = b as u8;
            if printable.contains(&b) {
                byte_map.insert(char::from_u32(b as u32).unwrap(), b);
            } else {
                byte_map.insert(char::from_u32(256 + n).unwrap(), b);
                n += 1;
            }
        }
        Ok(Self { id_to_token, byte_map })
    }

    pub fn decode(&self, ids: &[i64]) -> String {
        let mut bytes: Vec<u8> = Vec::new();
        for id in ids {
            if *id >= 50257 {
                continue; // special / timestamp
            }
            if let Some(tok) = self.id_to_token.get(id) {
                for ch in tok.chars() {
                    if let Some(b) = self.byte_map.get(&ch) {
                        bytes.push(*b);
                    }
                }
            }
        }
        String::from_utf8_lossy(&bytes).into_owned()
    }
}

/// Transcript of one silence-aware chunk with its time window in song seconds.
#[derive(Debug, Clone)]
pub struct ChunkTranscript {
    pub start_s: f64,
    pub end_s: f64,
    pub text: String,
}

pub struct Whisper {
    encoder: Session,
    /// Set when the encoder was meant for DirectML but runs on CPU.
    pub note: Option<String>,
    decoder: Session,
    tokenizer: WhisperTokenizer,
    suppress: Vec<i64>,
    n_layers: usize,
    n_heads: usize,
    head_dim: usize,
    has_cache_position: bool,
    fb: Vec<Vec<f32>>,
}

pub fn cpu_session(path: &Path, threads: usize) -> Result<Session> {
    crate::compute::session_builder(threads)?
        .commit_from_file(path)
        .map_err(|e| Error::Model(format!("load {}: {e}", path.display())))
}

/// EP key in the shared parity cache (the model identity disambiguates it
/// from separation's and wav2vec2's "directml" entries).
const ENCODER_PARITY_EP: &str = "directml";

/// Deterministic log-mel-shaped golden input: smooth bands in the encoder's
/// usual [-1, 1.5] range, so DML and CPU see identical, realistic values.
fn golden_mel() -> Vec<f32> {
    let mut v = Vec::with_capacity(mel::N_MELS * mel::N_FRAMES);
    for m in 0..mel::N_MELS {
        for t in 0..mel::N_FRAMES {
            let x = (t as f32 * 0.013 + m as f32 * 0.37).sin() * 0.8
                + (t as f32 * 0.071).cos() * 0.3 * (m as f32 / mel::N_MELS as f32);
            v.push(x.clamp(-1.0, 1.5));
        }
    }
    v
}

fn encode(session: &mut Session, mel: &[f32]) -> Result<Vec<f32>> {
    let feats = Tensor::from_array((vec![1usize, mel::N_MELS, mel::N_FRAMES], mel.to_vec()))?;
    let out = session.run(ort::inputs!["input_features" => feats])?;
    let (_, data) = out["last_hidden_state"].try_extract_tensor::<f32>()?;
    Ok(data.to_vec())
}

/// The encoder session: DirectML when `try_dml` and it matches the CPU on
/// the golden input (cached per model file), otherwise CPU. Returns a note
/// when DirectML was tried and not used.
fn encoder_session(path: &Path, threads: usize, try_dml: bool) -> Result<(Session, Option<String>)> {
    if !try_dml {
        return Ok((cpu_session(path, threads)?, None));
    }
    let dml = crate::compute::session_builder(threads)
        .and_then(|b| {
            Ok(b.with_config_entry("ep.dml.disable_graph_fusion", "1")?
                .with_memory_pattern(false)?
                .with_parallel_execution(false)?
                .with_execution_providers([crate::compute::directml()?])?)
        })
        .and_then(|mut b| b.commit_from_file(path).map_err(|e| Error::Model(format!("load {}: {e}", path.display()))));
    let mut dml = match dml {
        Ok(s) => s,
        Err(e) => return Ok((cpu_session(path, threads)?, Some(format!("whisper encoder DirectML unavailable, using CPU: {e}")))),
    };
    let cache_path = crate::separation::default_parity_cache_path();
    let mut cache = ParityCache::load(&cache_path, path);
    if cache.cached_pass(ENCODER_PARITY_EP).is_some() {
        return Ok((dml, None));
    }
    let golden = golden_mel();
    let candidate = encode(&mut dml, &golden);
    let mut cpu = cpu_session(path, threads)?;
    let baseline = encode(&mut cpu, &golden)?;
    match candidate {
        Ok(c) => {
            let snr = snr_db(&baseline, &c);
            let passed = snr >= GOLDEN_SNR_THRESHOLD_DB;
            cache.record(ENCODER_PARITY_EP, Some(snr), passed);
            if passed {
                Ok((dml, None))
            } else {
                Ok((cpu, Some(format!("whisper encoder DirectML parity FAIL ({snr:.1} dB) — using CPU"))))
            }
        }
        Err(e) => Ok((cpu, Some(format!("whisper encoder DirectML failed ({e}) — using CPU")))),
    }
}

impl Whisper {
    /// Load encoder/decoder sessions (CPU) and tokenizer from a
    /// `whisper-small` model directory (optimum export layout).
    /// `int8` selects the dynamic-quantized decoder (the int8 *encoder* uses
    /// ConvInteger, unimplemented in ort's bundled CPU build).
    pub fn load(dir: &Path, int8: bool, threads: usize, try_dml: bool) -> Result<Self> {
        let suffix = if int8 { "_int8" } else { "" };
        let enc_path = dir.join("onnx/encoder_model.onnx");
        let dec_path = dir.join(format!("onnx/decoder_model_merged{suffix}.onnx"));
        let (encoder, note) = encoder_session(&enc_path, threads, try_dml)?;
        let decoder = cpu_session(&dec_path, threads)?;
        let has_cache_position = decoder
            .inputs()
            .iter()
            .any(|i| i.name() == "cache_position");
        let tokenizer = WhisperTokenizer::load(&dir.join("tokenizer.json"))?;
        let cfg: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("config.json"))?)
                .map_err(|e| Error::Model(format!("whisper config.json: {e}")))?;
        let mut suppress: Vec<i64> = cfg["suppress_tokens"]
            .as_array()
            .map(|a| a.iter().filter_map(|x| x.as_i64()).collect())
            .unwrap_or_default();
        // no-timestamps decode: suppress all timestamp tokens + notimestamps itself
        suppress.push(NO_TIMESTAMPS);
        let heads = cfg["decoder_attention_heads"]
            .as_u64()
            .ok_or_else(|| Error::Model("config missing decoder_attention_heads".into()))?
            as usize;
        Ok(Self {
            encoder,
            note,
            decoder,
            tokenizer,
            suppress,
            n_layers: cfg["decoder_layers"]
                .as_u64()
                .ok_or_else(|| Error::Model("config missing decoder_layers".into()))?
                as usize,
            n_heads: heads,
            head_dim: cfg["d_model"]
                .as_u64()
                .ok_or_else(|| Error::Model("config missing d_model".into()))?
                as usize
                / heads,
            has_cache_position,
            fb: mel::mel_filterbank(),
        })
    }

    /// Transcribe pre-planned silence-aware chunks of 16 kHz mono audio.
    /// Each chunk is padded to whisper's 30 s window; the returned transcripts
    /// carry each chunk's time window in song seconds. `on_chunk(done, total)`
    /// fires after each chunk (whisper dominates align wall time on CPU).
    pub fn transcribe_chunks(
        &mut self,
        audio16k: &[f32],
        chunks: &[Chunk],
        on_chunk: &mut dyn FnMut(usize, usize),
    ) -> Result<Vec<ChunkTranscript>> {
        let mut out = Vec::with_capacity(chunks.len());
        for (ci, c) in chunks.iter().enumerate() {
            debug_assert!(c.len <= mel::CHUNK_SAMPLES);
            let mut padded = vec![0.0f32; mel::CHUNK_SAMPLES];
            let n = c.len.min(mel::CHUNK_SAMPLES);
            padded[..n].copy_from_slice(&audio16k[c.start..c.start + n]);
            let logmel = mel::log_mel_chunk(&padded, &self.fb);
            let ids = self.decode_chunk(&logmel)?;
            let text = self.tokenizer.decode(&ids).trim().to_string();
            out.push(ChunkTranscript {
                start_s: c.start_s(mel::SAMPLE_RATE),
                end_s: c.end_s(mel::SAMPLE_RATE),
                text,
            });
            on_chunk(ci + 1, chunks.len());
        }
        Ok(out)
    }

    fn decode_chunk(&mut self, logmel: &[f32]) -> Result<Vec<i64>> {
        use ort::value::DynValue;
        // encoder
        let feats = Tensor::from_array((
            vec![1usize, mel::N_MELS, mel::N_FRAMES],
            logmel.to_vec(),
        ))?;
        let mut enc_out = self.encoder.run(ort::inputs!["input_features" => feats])?;
        let enc_hidden: DynValue = enc_out
            .remove("last_hidden_state")
            .ok_or_else(|| Error::Inference("encoder output missing".into()))?;
        drop(enc_out);

        // KV cache state as owned ort values — fed by view, never copied.
        let n_l = self.n_layers;
        let mut dec_kv: Vec<Option<DynValue>> = (0..n_l * 2).map(|_| None).collect();
        let mut enc_kv: Vec<Option<DynValue>> = (0..n_l * 2).map(|_| None).collect();

        let prompt = [SOT, LANG_EN, TRANSCRIBE, NO_TIMESTAMPS];
        let mut tokens: Vec<i64> = prompt.to_vec();
        let mut new_tokens: Vec<i64> = Vec::new();
        let mut step = 0usize;
        loop {
            let (input_ids, past_len): (Vec<i64>, usize) = if step == 0 {
                (tokens.clone(), 0)
            } else {
                (vec![*tokens.last().unwrap()], tokens.len() - 1)
            };
            let seq = input_ids.len();
            let use_cache = step > 0;

            let mut feed: Vec<(std::borrow::Cow<'_, str>, ort::session::SessionInputValue<'_>)> =
                Vec::with_capacity(4 + n_l * 4);
            feed.push((
                "input_ids".into(),
                Tensor::from_array((vec![1usize, seq], input_ids.clone()))?.into(),
            ));
            feed.push(("encoder_hidden_states".into(), (&enc_hidden).into()));
            feed.push((
                "use_cache_branch".into(),
                Tensor::from_array((vec![1usize], vec![use_cache]))?.into(),
            ));
            if self.has_cache_position {
                let pos: Vec<i64> = (past_len as i64..(past_len + seq) as i64).collect();
                feed.push((
                    "cache_position".into(),
                    Tensor::from_array((vec![seq], pos))?.into(),
                ));
            }
            for l in 0..n_l {
                for (kind, store) in [("decoder", &dec_kv), ("encoder", &enc_kv)] {
                    for (j, kv) in ["key", "value"].iter().enumerate() {
                        match &store[l * 2 + j] {
                            Some(v) => feed.push((
                                format!("past_key_values.{l}.{kind}.{kv}").into(),
                                v.into(),
                            )),
                            None => {
                                // zero-length past (first pass only) — must go
                                // through the allocator API (dim 0)
                                let t: Tensor<f32> = Tensor::new(
                                    &ort::memory::Allocator::default(),
                                    vec![1i64, self.n_heads as i64, 0, self.head_dim as i64],
                                )?;
                                feed.push((
                                    format!("past_key_values.{l}.{kind}.{kv}").into(),
                                    t.into(),
                                ));
                            }
                        }
                    }
                }
            }
            let mut outputs = self.decoder.run(feed)?;

            // logits: [1, seq, vocab] — take last position
            let (lshape, ldata) = outputs["logits"].try_extract_tensor::<f32>()?;
            let vocab = lshape[lshape.len() - 1] as usize;
            let last = &ldata[(seq - 1) * vocab..seq * vocab];
            let mut best_id = 0i64;
            let mut best = f32::MIN;
            'outer: for (i, &v) in last.iter().enumerate() {
                let id = i as i64;
                if id >= TIMESTAMP_BEGIN {
                    continue;
                }
                for &s in &self.suppress {
                    if id == s {
                        continue 'outer;
                    }
                }
                if step == 0 && (id == 220 || id == EOT) {
                    continue; // begin_suppress_tokens
                }
                if v > best {
                    best = v;
                    best_id = id;
                }
            }
            // move presents into the cache without copying
            for l in 0..n_l {
                for (j, kv) in ["key", "value"].iter().enumerate() {
                    if let Some(v) = outputs.remove(&format!("present.{l}.decoder.{kv}")) {
                        dec_kv[l * 2 + j] = Some(v);
                    }
                    if step == 0 {
                        if let Some(v) = outputs.remove(&format!("present.{l}.encoder.{kv}")) {
                            enc_kv[l * 2 + j] = Some(v);
                        }
                    }
                }
            }
            if best_id == EOT || new_tokens.len() >= MAX_NEW_TOKENS {
                break;
            }
            tokens.push(best_id);
            new_tokens.push(best_id);
            step += 1;
        }
        Ok(new_tokens)
    }
}
