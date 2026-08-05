//! Alignment stage: whisper-small rough pass + wav2vec2-base CTC forced
//! alignment over the **vocal stem**, with pasted-lyrics edit-distance
//! anchoring (PLAN.md §5).
//!
//! Ported from spikes/alignment with the production inputs the spike lacked
//! (vocal stems, pasted lyrics) and its hardening list applied:
//! - constant onset-bias correction ([`CTC_ONSET_BIAS_S`]), tunable via
//!   [`AlignConfig::onset_bias_s`]
//! - silence-aware whisper chunking ([`chunk`]) instead of fixed 30 s windows
//! - ort session reuse (sessions live in [`Aligner`], reused across songs) and
//!   KV-cache-by-view decode (see [`whisper`] module docs)
//!
//! The user's pasted lyrics are ground truth: whisper output is only matched
//! against them for rough time anchors ([`anchor`]); the CTC trellis aligns
//! the *user's* words. Lyric words the evidence cannot place are flagged
//! explicitly (unsung spans) instead of being silently stretched — the spike's
//! measured failure mode on instrumental-heavy songs.
//!
//! Output timing is **original-song time** (PLAN.md §5 hard rule): the vocal
//! stem is time-aligned 1:1 with the user's file, and nothing here knows about
//! tempo stretch.

pub mod anchor;
pub mod chunk;
pub mod ctc;
pub mod mel;
pub mod w2v;
pub mod whisper;

use std::path::Path;
use std::time::Instant;

use crate::error::{Error, Result};
use crate::timing::{LyricSource, UnsungSpan, WordTiming, WordTimingMap};

/// Constant onset-bias correction, seconds. The spike measured a consistent
/// +55 ms "late" bias in CTC word onsets against machine-exact TTS ground
/// truth (median +55 ms, p90 81 ms — spikes/alignment/REPORT.md): the CTC
/// emission peak sits mid-phoneme. Subtracting it roughly halves the median
/// onset error. Tune against hand-timed references when they exist.
pub const CTC_ONSET_BIAS_S: f64 = -0.055;

/// Model directory layout under the model root.
pub const WHISPER_DIR_NAME: &str = "whisper-small";
pub const WAV2VEC2_DIR_NAME: &str = "wav2vec2";

/// Alignment stage sample rate (whisper + wav2vec2 both consume 16 kHz mono).
pub const SAMPLE_RATE: u32 = 16_000;

#[derive(Debug, Clone)]
pub struct AlignConfig {
    /// Added to every word time at the end (negative shifts earlier).
    pub onset_bias_s: f64,
    /// Use the dynamic-quantized whisper decoder (−22% whisper time, word
    /// similarity 0.893 vs fp32 in the spike).
    pub whisper_int8: bool,
    /// Try DirectML for wav2vec2 emissions (13x on the spike GPU). Whisper
    /// always runs on CPU (DML measured 4x slower for its decoder).
    ///
    /// **Default false**: wav2vec2's 30 s-chunk dispatches can exceed the
    /// Windows TDR budget on mid-range GPUs, resetting the display driver and
    /// crashing unrelated GPU apps (observed on an RTX 2080 SUPER, System
    /// event 4101). Opt-in only until per-dispatch work is bounded — see the
    /// [`w2v`] module docs.
    pub w2v_try_dml: bool,
    /// Intra-op threads for the CPU sessions.
    pub threads: usize,
    /// A word stretched past this duration is treated as the aligner absorbing
    /// audio the word doesn't own (spike: stretched words > 2 s marked its
    /// under-transcription failure mode).
    pub max_word_stretch_s: f64,
    /// Below this CTC path confidence an unanchored word counts as suspect.
    pub min_word_confidence: f32,
    /// An anchored word whose CTC midpoint lands further than this outside
    /// whisper's chunk window loses its anchor (evidence disagrees).
    pub anchor_tolerance_s: f64,
}

impl Default for AlignConfig {
    fn default() -> Self {
        Self {
            onset_bias_s: CTC_ONSET_BIAS_S,
            whisper_int8: false,
            w2v_try_dml: false, // TDR risk — see field docs

            threads: std::thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(4),
            max_word_stretch_s: 2.0,
            min_word_confidence: 0.15,
            anchor_tolerance_s: 10.0,
        }
    }
}

/// Stage timings and counters for reporting.
#[derive(Debug, Clone, serde::Serialize)]
pub struct AlignStats {
    pub audio_duration_s: f64,
    pub n_chunks: usize,
    pub whisper_s: f64,
    pub w2v_s: f64,
    pub trellis_s: f64,
    /// whisper + w2v + trellis (the PLAN §5 "alignment stage").
    pub total_s: f64,
    pub realtime_factor: f64,
    pub w2v_ep: String,
    pub n_lyric_words: usize,
    pub n_transcript_words: usize,
    pub n_anchored: usize,
    pub n_unsung: usize,
    /// Lyric words with no alignable characters (e.g. "42", pure punctuation);
    /// they get zero-length placeholder timings.
    pub n_unalignable: usize,
}

pub struct AlignOutput {
    pub map: WordTimingMap,
    /// Whisper's raw transcript (diagnostic only — never trusted as text).
    pub transcript: String,
    pub stats: AlignStats,
}

/// The alignment stage. Loads its ONNX sessions once; `align` may be called
/// repeatedly (batch jobs reuse sessions — Phase 1 hardening list).
pub struct Aligner {
    whisper: whisper::Whisper,
    w2v: w2v::W2v,
    pub cfg: AlignConfig,
}

impl Aligner {
    /// `model_root` contains `whisper-small/` and `wav2vec2/` directories.
    /// Returns the aligner plus any non-fatal notes (e.g. DML fallback).
    pub fn load(model_root: &Path, cfg: AlignConfig) -> Result<(Self, Vec<String>)> {
        let whisper_dir = model_root.join(WHISPER_DIR_NAME);
        let w2v_dir = model_root.join(WAV2VEC2_DIR_NAME);
        for d in [&whisper_dir, &w2v_dir] {
            if !d.is_dir() {
                return Err(Error::Model(format!(
                    "alignment model directory not found: {}",
                    d.display()
                )));
            }
        }
        let mut notes = Vec::new();
        let whisper = whisper::Whisper::load(&whisper_dir, cfg.whisper_int8, cfg.threads)?;
        let (w2v, note) = w2v::W2v::load(&w2v_dir, cfg.threads, cfg.w2v_try_dml)?;
        if let Some(n) = note {
            notes.push(n);
        }
        Ok((Self { whisper, w2v, cfg }, notes))
    }

    /// Align pasted lyrics (raw text) to a 16 kHz mono vocal stem.
    /// Convenience wrapper over [`Self::align_words`] — callers that ran the
    /// lyric cleanup pass ([`crate::lyrics`]) should pass its
    /// `lyric_words()` to `align_words` instead so display text and ad-lib
    /// structure survive.
    pub fn align(
        &mut self,
        vocals16k: &[f32],
        lyrics_text: &str,
        progress: &mut dyn FnMut(&str),
    ) -> Result<AlignOutput> {
        let words = anchor::parse_lyrics(lyrics_text);
        self.align_words(vocals16k, &words, progress)
    }

    /// Align pre-parsed lyric words (the cleanup pass's output) to a 16 kHz
    /// mono vocal stem. The output map's words are 1:1 with `lyric_words`.
    pub fn align_words(
        &mut self,
        vocals16k: &[f32],
        lyric_words: &[anchor::LyricWord],
        progress: &mut dyn FnMut(&str),
    ) -> Result<AlignOutput> {
        if lyric_words.is_empty() {
            return Err(Error::InvalidInput("lyrics contain no words".into()));
        }
        self.align_core(vocals16k, Some(lyric_words), progress)
    }

    /// Auto-transcribe fallback (PLAN.md §3): no pasted lyrics — the whisper
    /// transcript becomes the lyric source, and the map is marked
    /// [`LyricSource::Transcribed`]. Each whisper chunk becomes one lyric
    /// line (words carry line/word indices).
    pub fn align_transcribe(
        &mut self,
        vocals16k: &[f32],
        progress: &mut dyn FnMut(&str),
    ) -> Result<AlignOutput> {
        self.align_core(vocals16k, None, progress)
    }

    fn align_core(
        &mut self,
        vocals16k: &[f32],
        pasted: Option<&[anchor::LyricWord]>,
        progress: &mut dyn FnMut(&str),
    ) -> Result<AlignOutput> {
        if vocals16k.is_empty() {
            return Err(Error::InvalidInput("empty audio".into()));
        }
        let duration_s = vocals16k.len() as f64 / SAMPLE_RATE as f64;

        // ---- stage 1: whisper rough pass over silence-aware chunks ----
        let chunks = chunk::plan_chunks(vocals16k, SAMPLE_RATE as usize);
        progress(&format!(
            "whisper: transcribing {} chunk(s) (silence-aware boundaries)",
            chunks.len()
        ));
        let t0 = Instant::now();
        let chunk_transcripts = self.whisper.transcribe_chunks(vocals16k, &chunks)?;
        let whisper_s = t0.elapsed().as_secs_f64();
        let transcript = chunk_transcripts
            .iter()
            .map(|c| c.text.as_str())
            .filter(|t| !t.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        let mut transcript_words: Vec<anchor::TranscriptWord> = Vec::new();
        // per transcript word: (chunk index, display text) — used when the
        // transcript is the lyric source
        let mut transcript_meta: Vec<(usize, String)> = Vec::new();
        for (ci, c) in chunk_transcripts.iter().enumerate() {
            for w in c.text.split_whitespace() {
                let norm = anchor::normalize_word(w);
                if norm.is_empty() {
                    continue;
                }
                transcript_words.push(anchor::TranscriptWord {
                    norm,
                    window_start_s: c.start_s,
                    window_end_s: c.end_s,
                });
                transcript_meta.push((ci, w.to_string()));
            }
        }
        progress(&format!(
            "whisper: {} words in {whisper_s:.1}s",
            transcript_words.len()
        ));

        // ---- resolve the lyric source ----
        // Pasted lyrics are ground truth: whisper output is only matched
        // against them for rough anchors. Without pasted lyrics the
        // transcript itself is the lyric source (each word trivially
        // anchored to its chunk window; each chunk becomes a line).
        let lyric_source;
        let lyric_words: Vec<anchor::LyricWord>;
        let anchors: Vec<Option<anchor::Anchor>>;
        // per lyric word: (line index, word-in-line index), auto mode only
        let mut auto_lines: Option<Vec<(usize, usize)>> = None;
        match pasted {
            Some(words) => {
                lyric_source = LyricSource::Pasted;
                lyric_words = words.to_vec();
                anchors = anchor::anchor_lyrics(&lyric_words, &transcript_words);
            }
            None => {
                lyric_source = LyricSource::Transcribed;
                if transcript_words.is_empty() {
                    return Err(Error::InvalidInput(
                        "auto-transcription heard no words — paste lyrics to align this song"
                            .into(),
                    ));
                }
                progress("no pasted lyrics: using the whisper transcript as the lyric source");
                lyric_words = transcript_words
                    .iter()
                    .zip(&transcript_meta)
                    .map(|(t, (_, display))| anchor::LyricWord {
                        display: display.clone(),
                        norm: t.norm.clone(),
                    })
                    .collect();
                anchors = transcript_words
                    .iter()
                    .map(|t| {
                        Some(anchor::Anchor {
                            window_start_s: t.window_start_s,
                            window_end_s: t.window_end_s,
                        })
                    })
                    .collect();
                // dense line numbering over chunks that produced words
                let mut lines = Vec::with_capacity(lyric_words.len());
                let mut line = 0usize;
                let mut word_in_line = 0usize;
                let mut prev_chunk: Option<usize> = None;
                for (ci, _) in &transcript_meta {
                    if prev_chunk.is_some() && prev_chunk != Some(*ci) {
                        line += 1;
                        word_in_line = 0;
                    }
                    prev_chunk = Some(*ci);
                    lines.push((line, word_in_line));
                    word_in_line += 1;
                }
                auto_lines = Some(lines);
            }
        }

        // ---- stage 2: wav2vec2 emissions + CTC trellis over the user's words ----
        progress(&format!("wav2vec2 emissions ({})", self.w2v.ep.as_str()));
        let t1 = Instant::now();
        let em = self.w2v.emissions(vocals16k)?;
        let w2v_s = t1.elapsed().as_secs_f64();
        progress(&format!(
            "wav2vec2: {} frames in {w2v_s:.1}s ({})",
            em.n_frames,
            self.w2v.ep.as_str()
        ));

        let norm_refs: Vec<&str> = lyric_words.iter().map(|w| w.norm.as_str()).collect();
        let (targets, ranges) = w2v::words_to_targets(&norm_refs, &self.w2v.vocab, self.w2v.word_delim);
        let t2 = Instant::now();
        let spans = ctc::forced_align(&em.logprobs, em.n_frames, em.n_vocab, &targets, self.w2v.blank)?;
        let trellis_s = t2.elapsed().as_secs_f64();

        // token spans -> per-word raw timings
        let mut span_by_token: Vec<Option<&ctc::TokenSpan>> = vec![None; targets.len()];
        for s in &spans {
            span_by_token[s.token_index] = Some(s);
        }
        struct Raw {
            start: f64,
            end: f64,
            confidence: f32,
            aligned: bool,
        }
        let mut raw: Vec<Raw> = Vec::with_capacity(lyric_words.len());
        let mut last_end = 0.0f64;
        for (s_idx, e_idx) in &ranges {
            let mut start_f: Option<usize> = None;
            let mut end_f: Option<usize> = None;
            let mut score_acc = 0.0f32;
            let mut score_n = 0u32;
            for ti in *s_idx..*e_idx {
                if let Some(sp) = span_by_token[ti] {
                    if start_f.is_none() {
                        start_f = Some(sp.start_frame);
                    }
                    end_f = Some(sp.end_frame);
                    score_acc += sp.score;
                    score_n += 1;
                }
            }
            match (start_f, end_f) {
                (Some(sf), Some(ef)) => {
                    let start = sf as f64 * w2v::FRAME_SEC;
                    let end = ef as f64 * w2v::FRAME_SEC;
                    last_end = end;
                    raw.push(Raw {
                        start,
                        end,
                        confidence: (score_acc / score_n.max(1) as f32).exp().clamp(0.0, 1.0),
                        aligned: true,
                    });
                }
                _ => {
                    // unalignable word (no in-vocab characters): zero-length
                    // placeholder at the current position, flagged below
                    raw.push(Raw {
                        start: last_end,
                        end: last_end,
                        confidence: 0.0,
                        aligned: false,
                    });
                }
            }
        }

        // ---- flags: anchors, suspects, unsung spans ----
        let mut words: Vec<WordTiming> = Vec::with_capacity(raw.len());
        let mut suspect: Vec<bool> = Vec::with_capacity(raw.len());
        let mut n_anchored = 0usize;
        let mut n_unalignable = 0usize;
        for (i, r) in raw.iter().enumerate() {
            let mut anchored = false;
            if let Some(a) = &anchors[i] {
                // whisper heard this word — but only keep the anchor when the
                // CTC placement agrees with whisper's rough window
                let mid = (r.start + r.end) / 2.0;
                anchored = r.aligned
                    && mid >= a.window_start_s - self.cfg.anchor_tolerance_s
                    && mid <= a.window_end_s + self.cfg.anchor_tolerance_s;
            }
            if anchored {
                n_anchored += 1;
            }
            if !r.aligned {
                n_unalignable += 1;
            }
            let stretched = r.end - r.start > self.cfg.max_word_stretch_s;
            let sus = !r.aligned
                || stretched
                || (!anchored && r.confidence < self.cfg.min_word_confidence);
            suspect.push(sus);
            let (line, word_in_line) = match &auto_lines {
                Some(l) => (Some(l[i].0), Some(l[i].1)),
                None => (None, None), // pasted path: cleanup annotates (lyrics::annotate_map)
            };
            words.push(WordTiming {
                word: lyric_words[i].display.clone(),
                start: r.start,
                end: r.end,
                confidence: r.confidence,
                anchored,
                unsung: false, // set below
                line,
                word_in_line,
                ad_lib: false, // pasted path: cleanup annotates
            });
        }

        // maximal runs of suspect words become unsung spans when the run is
        // more than a lone low-confidence word (>= 2 words) or contains a
        // clearly broken member (stretched or unalignable)
        let mut unsung_spans: Vec<UnsungSpan> = Vec::new();
        let mut i = 0usize;
        while i < words.len() {
            if !suspect[i] {
                i += 1;
                continue;
            }
            let first = i;
            while i < words.len() && suspect[i] {
                i += 1;
            }
            let last = i - 1;
            let broken = (first..=last).any(|k| {
                !raw[k].aligned || words[k].end - words[k].start > self.cfg.max_word_stretch_s
            });
            if last > first || broken {
                for w in &mut words[first..=last] {
                    w.unsung = true;
                }
                unsung_spans.push(UnsungSpan {
                    first_word: first,
                    last_word: last,
                    start: words[first].start,
                    end: words[last].end,
                });
            }
        }
        let n_unsung = words.iter().filter(|w| w.unsung).count();

        // ---- assemble map in original-song time, apply onset-bias correction ----
        let mut map = WordTimingMap::new(duration_s, words, unsung_spans);
        map.lyric_source = Some(lyric_source);
        map.shift(self.cfg.onset_bias_s);

        let total_s = whisper_s + w2v_s + trellis_s;
        let stats = AlignStats {
            audio_duration_s: duration_s,
            n_chunks: chunks.len(),
            whisper_s,
            w2v_s,
            trellis_s,
            total_s,
            realtime_factor: total_s / duration_s,
            w2v_ep: self.w2v.ep.as_str().to_string(),
            n_lyric_words: lyric_words.len(),
            n_transcript_words: transcript_words.len(),
            n_anchored,
            n_unsung,
            n_unalignable,
        };
        progress(&format!(
            "aligned {} words (anchored {}, unsung {}) in {total_s:.1}s (rtf {:.2})",
            stats.n_lyric_words, stats.n_anchored, stats.n_unsung, stats.realtime_factor
        ));
        Ok(AlignOutput {
            map,
            transcript,
            stats,
        })
    }
}

#[cfg(test)]
mod smoke {
    //! Golden-file smoke test (ML inference gets smoke tests, not unit-test
    //! theater — CLAUDE.md). Needs real model weights and the spike's TTS
    //! reference with machine-exact word onsets:
    //! ```text
    //! KARAOKE_TEST_ALIGN_MODELS=path\to\models ^
    //! KARAOKE_TEST_TTS_WAV=spikes\alignment\out\tts-reference.wav ^
    //! KARAOKE_TEST_TTS_TRUTH=spikes\alignment\out\tts-reference.truth.json ^
    //! cargo test -p karaoke-core --release -- --ignored tts_reference
    //! ```
    use super::*;

    #[test]
    #[ignore = "needs whisper/wav2vec2 weights + TTS reference (set KARAOKE_TEST_ALIGN_MODELS, KARAOKE_TEST_TTS_WAV, KARAOKE_TEST_TTS_TRUTH)"]
    fn tts_reference_onsets_within_100ms() {
        let models = std::env::var("KARAOKE_TEST_ALIGN_MODELS").expect("KARAOKE_TEST_ALIGN_MODELS");
        let wav = std::env::var("KARAOKE_TEST_TTS_WAV").expect("KARAOKE_TEST_TTS_WAV");
        let truth_path = std::env::var("KARAOKE_TEST_TTS_TRUTH").expect("KARAOKE_TEST_TTS_TRUTH");

        // truth: [{word, onset_s}] in arbitrary order; sort by onset = spoken order
        let truth: Vec<(String, f64)> = {
            let text = std::fs::read_to_string(&truth_path).unwrap();
            let v: serde_json::Value =
                serde_json::from_str(text.trim_start_matches('\u{feff}')).unwrap();
            let mut t: Vec<(String, f64)> = v
                .as_array()
                .unwrap()
                .iter()
                .map(|e| {
                    (
                        e["word"].as_str().unwrap().to_string(),
                        e["onset_s"].as_f64().unwrap(),
                    )
                })
                .collect();
            t.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
            t
        };
        let lyrics: String = truth
            .iter()
            .map(|(w, _)| w.as_str())
            .collect::<Vec<_>>()
            .join(" ");

        let decoded = crate::audio::decode_to_mono_16k(Path::new(&wav)).unwrap();
        let (mut aligner, _notes) =
            Aligner::load(Path::new(&models), AlignConfig::default()).unwrap();
        let out = aligner
            .align(&decoded.samples, &lyrics, &mut |m| eprintln!("[smoke] {m}"))
            .unwrap();

        assert!(out.map.validate().is_empty(), "{:?}", out.map.validate());
        assert_eq!(out.map.words.len(), truth.len());
        let mut errs: Vec<f64> = out
            .map
            .words
            .iter()
            .zip(&truth)
            .filter(|(w, _)| w.end > w.start) // skip unalignable placeholders
            .map(|(w, (_, onset))| (w.start - onset).abs())
            .collect();
        errs.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let median = errs[errs.len() / 2];
        eprintln!(
            "[smoke] onset error: median {:.0} ms, max {:.0} ms over {} words",
            median * 1000.0,
            errs.last().unwrap() * 1000.0,
            errs.len()
        );
        // spike measured 55 ms median *before* bias correction; with the
        // correction the median should sit well under 100 ms
        assert!(median < 0.1, "median onset error {median:.3}s");
    }
}
