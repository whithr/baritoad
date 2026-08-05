//! whisper-small greedy transcription via ONNX Runtime (encoder + merged
//! KV-cache decoder from onnx-community/whisper-small, optimum export layout).

use crate::mel;
use anyhow::{anyhow, Context, Result};
use ort::session::Session;
use ort::value::Tensor;
use std::collections::HashMap;
use std::path::Path;

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
        let v: serde_json::Value = serde_json::from_str(&text)?;
        let vocab = v["model"]["vocab"]
            .as_object()
            .ok_or_else(|| anyhow!("no model.vocab in tokenizer.json"))?;
        let mut id_to_token = HashMap::with_capacity(vocab.len() + 1600);
        for (tok, id) in vocab {
            id_to_token.insert(id.as_i64().unwrap(), tok.clone());
        }
        if let Some(added) = v["added_tokens"].as_array() {
            for a in added {
                id_to_token.insert(a["id"].as_i64().unwrap(), a["content"].as_str().unwrap().to_string());
            }
        }
        // GPT-2 byte-level encoding: printable bytes map to themselves; the rest
        // map to U+0100.. in order.
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

pub struct Whisper {
    encoder: Session,
    decoder: Session,
    tokenizer: WhisperTokenizer,
    suppress: Vec<i64>,
    n_layers: usize,
    n_heads: usize,
    head_dim: usize,
    has_cache_position: bool,
    fb: Vec<Vec<f32>>,
}

pub fn session_builder(threads: usize, dml: bool) -> Result<ort::session::builder::SessionBuilder> {
    let mut b = Session::builder()?.with_intra_threads(threads)?;
    if dml {
        use ort::execution_providers::DirectMLExecutionProvider;
        b = b.with_execution_providers([DirectMLExecutionProvider::default().build().error_on_failure()])?;
    }
    Ok(b)
}

impl Whisper {
    pub fn load(dir: &Path, int8: bool, threads: usize, dml: bool) -> Result<Self> {
        // int8 applies to the decoder only: the int8 encoder uses ConvInteger,
        // which the ort 2.0-rc.10 bundled ONNX Runtime CPU build does not implement.
        let suffix = if int8 { "_int8" } else { "" };
        let enc_path = dir.join("onnx/encoder_model.onnx");
        let dec_path = dir.join(format!("onnx/decoder_model_merged{suffix}.onnx"));
        // Whisper stays on CPU regardless of --dml: measured on RTX 2080 SUPER,
        // DirectML is ~4x slower than CPU for the merged KV-cache decoder
        // (dynamic shapes) and slower even for the encoder (see REPORT.md).
        let _ = dml;
        let encoder = session_builder(threads, false)?
            .commit_from_file(&enc_path)
            .with_context(|| format!("load {}", enc_path.display()))?;
        let decoder = session_builder(threads, false)?
            .commit_from_file(&dec_path)?;
        let has_cache_position = decoder.inputs.iter().any(|i| i.name == "cache_position");
        let tokenizer = WhisperTokenizer::load(&dir.join("tokenizer.json"))?;
        let cfg: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("config.json"))?)?;
        let mut suppress: Vec<i64> = cfg["suppress_tokens"]
            .as_array()
            .map(|a| a.iter().map(|x| x.as_i64().unwrap()).collect())
            .unwrap_or_default();
        // no-timestamps decode: suppress all timestamp tokens + notimestamps itself
        suppress.push(NO_TIMESTAMPS);
        Ok(Self {
            encoder,
            decoder,
            tokenizer,
            suppress,
            n_layers: cfg["decoder_layers"].as_u64().unwrap() as usize,
            n_heads: cfg["decoder_attention_heads"].as_u64().unwrap() as usize,
            head_dim: (cfg["d_model"].as_u64().unwrap() as usize)
                / cfg["decoder_attention_heads"].as_u64().unwrap() as usize,
            has_cache_position,
            fb: mel::mel_filterbank(),
        })
    }

    /// Transcribe full song audio (16 kHz mono). Returns (text, mel_of_first_chunk).
    pub fn transcribe(&mut self, audio16k: &[f32]) -> Result<(String, Vec<f32>)> {
        let mut text = String::new();
        let mut first_mel: Vec<f32> = Vec::new();
        let n_chunks = audio16k.len().div_ceil(mel::CHUNK_SAMPLES);
        for c in 0..n_chunks {
            let start = c * mel::CHUNK_SAMPLES;
            let end = (start + mel::CHUNK_SAMPLES).min(audio16k.len());
            let mut chunk = vec![0.0f32; mel::CHUNK_SAMPLES];
            chunk[..end - start].copy_from_slice(&audio16k[start..end]);
            let logmel = mel::log_mel_chunk(&chunk, &self.fb);
            if c == 0 {
                first_mel = logmel.clone();
            }
            let ids = self.decode_chunk(&logmel)?;
            let t = self.tokenizer.decode(&ids);
            if !t.trim().is_empty() {
                if !text.is_empty() {
                    text.push(' ');
                }
                text.push_str(t.trim());
            }
        }
        Ok((text, first_mel))
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
            .ok_or_else(|| anyhow!("encoder output missing"))?;
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
                feed.push(("cache_position".into(), Tensor::from_array((vec![seq], pos))?.into()));
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
                                // zero-length past (first pass only)
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
