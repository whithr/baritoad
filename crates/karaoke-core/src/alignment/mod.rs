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
//! the *user's* words. Every lyric word is placed and shown; the aligner does
//! not mark words unsung (its low-confidence heuristic flagged plainly sung
//! words), so a word the recording skips is the user's to delete.
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

use std::path::{Path, PathBuf};
use std::time::Instant;

use crate::error::{Error, Result};
use crate::timing::{LyricSource, WordTiming, WordTimingMap};

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
    /// Use the dynamic-quantized whisper decoder. Measured 2026-08-06
    /// (release build, 3-song pasted-lyrics A/B): **no speed win** (whisper
    /// wall time within noise of fp32) and strictly worse anchors (she-said
    /// 366→344 anchored, false unsung spans 1→9). Keep false; the flag stays
    /// for experimentation only.
    pub whisper_int8: bool,
    /// Try DirectML for wav2vec2 emissions (13x on the spike GPU). Whisper
    /// always runs on CPU (DML measured 4x slower for its decoder).
    ///
    /// The two DML hazards are mitigated in [`w2v`] — 10 s dispatches bound
    /// per-dispatch GPU work under the TDR watchdog (an RTX 2080 SUPER reset
    /// its driver on the old 30 s chunks, System event 4101), and a cached
    /// golden-signal parity gate catches silent-garbage EPs. Soak-tested on
    /// that GPU 2026-09-30: 15 full-song runs (5 songs, 3-6.4 min), 1.4-3.0 s
    /// each vs 13-30 s on CPU, no driver resets; a 10 s chunk is 45 ms and
    /// +684 MB VRAM. The generate pipeline turns it on unless the request
    /// pins the CPU; this struct's default (and `karaoke align` without
    /// `--ep dml`) stays CPU.
    ///
    /// Also moves the whisper *encoder* to DirectML (same parity gating;
    /// the decoder stays on CPU) — whisper only runs without pasted lyrics.
    pub w2v_try_dml: bool,
    /// Intra-op threads for the CPU sessions (default leaves cores free for
    /// the UI and player — [`crate::compute::inference_threads`]).
    pub threads: usize,
    /// Also run whisper over pasted lyrics to compute each word's `anchored`
    /// flag. Diagnostic only: the CTC trellis never reads anchors, and
    /// nothing downstream reads the flag, so the default skips whisper —
    /// on a pasted-lyrics song it was ~70% of align wall time (White
    /// America: 73.9 s of 107.9 s). Auto-transcription always runs whisper.
    pub whisper_anchors: bool,
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

            threads: crate::compute::inference_threads(),
            whisper_anchors: false,
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
    /// Loaded on first use: the pasted-lyrics path never needs it.
    whisper: Option<whisper::Whisper>,
    whisper_dir: PathBuf,
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
        let (w2v, note) = w2v::W2v::load(&w2v_dir, cfg.threads, cfg.w2v_try_dml)?;
        if let Some(n) = note {
            notes.push(n);
        }
        Ok((
            Self {
                whisper: None,
                whisper_dir,
                w2v,
                cfg,
            },
            notes,
        ))
    }

    fn whisper(&mut self) -> Result<&mut whisper::Whisper> {
        if self.whisper.is_none() {
            self.whisper = Some(whisper::Whisper::load(
                &self.whisper_dir,
                self.cfg.whisper_int8,
                self.cfg.threads,
                self.cfg.w2v_try_dml,
            )?);
        }
        Ok(self.whisper.as_mut().expect("just loaded"))
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
        progress: &mut dyn FnMut(Option<f64>, &str),
    ) -> Result<AlignOutput> {
        let words = anchor::parse_lyrics(lyrics_text);
        self.align_words(vocals16k, &words, progress)
    }

    /// Align pre-parsed lyric words (the cleanup pass's output) to a 16 kHz
    /// mono vocal stem. The output map's words are 1:1 with `lyric_words`.
    /// `progress(fraction, message)`: fraction is the estimated share of the
    /// whole align stage completed, in [0, 1], when quantifiable.
    pub fn align_words(
        &mut self,
        vocals16k: &[f32],
        lyric_words: &[anchor::LyricWord],
        progress: &mut dyn FnMut(Option<f64>, &str),
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
        progress: &mut dyn FnMut(Option<f64>, &str),
    ) -> Result<AlignOutput> {
        self.align_core(vocals16k, None, progress)
    }

    fn align_core(
        &mut self,
        vocals16k: &[f32],
        pasted: Option<&[anchor::LyricWord]>,
        progress: &mut dyn FnMut(Option<f64>, &str),
    ) -> Result<AlignOutput> {
        if vocals16k.is_empty() {
            return Err(Error::InvalidInput("empty audio".into()));
        }
        let duration_s = vocals16k.len() as f64 / SAMPLE_RATE as f64;

        // ---- stage 1: whisper rough pass over silence-aware chunks ----
        // Only auto-transcription needs it; pasted lyrics skip it unless the
        // diagnostic anchors were asked for (AlignConfig::whisper_anchors).
        let run_whisper = pasted.is_none() || self.cfg.whisper_anchors;
        // Whisper vs wav2vec2 share of align wall time on CPU (measured:
        // whisper 14.4-19.4 s vs w2v 15.1-15.5 s per 3-3.6 min song). Only
        // shapes the progress fraction — never affects results.
        let whisper_weight: f64 = if run_whisper { 0.55 } else { 0.0 };
        let chunks = if run_whisper {
            chunk::plan_chunks(vocals16k, SAMPLE_RATE as usize)
        } else {
            Vec::new()
        };
        // Chunks with next to no singing are skipped (chunk::is_silent).
        let level_db = chunk::voice_level_db(vocals16k, SAMPLE_RATE as usize);
        let voiced: Vec<chunk::Chunk> = chunks
            .iter()
            .copied()
            .filter(|c| !chunk::is_silent(vocals16k, c, SAMPLE_RATE as usize, level_db))
            .collect();
        let t0 = Instant::now();
        let chunk_transcripts = if run_whisper {
            progress(
                Some(0.0),
                &format!(
                    "whisper: transcribing {} of {} chunk(s) ({} without singing skipped)",
                    voiced.len(),
                    chunks.len(),
                    chunks.len() - voiced.len()
                ),
            );
            let w = self.whisper()?;
            if let Some(n) = w.note.take() {
                progress(None, &n);
            }
            w.transcribe_chunks(vocals16k, &voiced, &mut |done, total| {
                progress(
                    Some(whisper_weight * done as f64 / total.max(1) as f64),
                    &format!("whisper: chunk {done}/{total}"),
                );
            })?
        } else {
            Vec::new()
        };
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
        if run_whisper {
            progress(
                None,
                &format!("whisper: {} words in {whisper_s:.1}s", transcript_words.len()),
            );
        }

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
                anchors = if run_whisper {
                    anchor::anchor_lyrics(&lyric_words, &transcript_words)
                } else {
                    vec![None; lyric_words.len()]
                };
            }
            None => {
                lyric_source = LyricSource::Transcribed;
                if transcript_words.is_empty() {
                    return Err(Error::InvalidInput(
                        "auto-transcription heard no words — paste lyrics to align this song"
                            .into(),
                    ));
                }
                progress(
                    None,
                    "no pasted lyrics: using the whisper transcript as the lyric source",
                );
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
        let w2v_ep = self.w2v.ep.as_str();
        progress(None, &format!("wav2vec2 emissions ({w2v_ep})"));
        let t1 = Instant::now();
        let em = self.w2v.emissions(vocals16k, &mut |done, total| {
            let frac = whisper_weight + (1.0 - whisper_weight) * done as f64 / total.max(1) as f64;
            progress(Some(frac), &format!("wav2vec2: chunk {done}/{total} ({w2v_ep})"));
        })?;
        let w2v_s = t1.elapsed().as_secs_f64();
        progress(
            None,
            &format!(
                "wav2vec2: {} frames in {w2v_s:.1}s ({})",
                em.n_frames,
                self.w2v.ep.as_str()
            ),
        );

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
                    // placeholder at the current position (counted as unalignable)
                    raw.push(Raw {
                        start: last_end,
                        end: last_end,
                        confidence: 0.0,
                        aligned: false,
                    });
                }
            }
        }

        // ---- flags: anchors ----
        // No word is auto-marked unsung: the suspect heuristic (low CTC
        // confidence / long unanchored stretch) flagged words that were
        // plainly sung — 47 of 923 on a pasted-lyrics rap track — and the
        // user can delete a word the recording really skips.
        let mut words: Vec<WordTiming> = Vec::with_capacity(raw.len());
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
                unsung: false,
                line,
                word_in_line,
                ad_lib: false, // pasted path: cleanup annotates
            });
        }

        // ---- assemble map in original-song time, apply onset-bias correction ----
        let mut map = WordTimingMap::new(duration_s, words, Vec::new());
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
            n_unalignable,
        };
        progress(
            Some(1.0),
            &format!(
                "aligned {} words (anchored {}) in {total_s:.1}s (rtf {:.2})",
                stats.n_lyric_words, stats.n_anchored, stats.realtime_factor
            ),
        );
        Ok(AlignOutput {
            map,
            transcript,
            stats,
        })
    }
}

// ---------------------------------------------------------------------------
// windowed re-alignment (fix editor's "Re-align selection" — PLAN.md §3)
// ---------------------------------------------------------------------------

/// Lightweight aligner for re-running the CTC pass over a short window of the
/// vocal stem with a user-selected run of lyric words (the review screen's
/// "Re-align selection", PLAN.md §3).
///
/// Deliberately whisper-free: the selection *is* ground truth about what is
/// sung in the window, so the rough-anchor pass has nothing to add — only the
/// wav2vec2 session loads (~360 MB model, one session, reusable across
/// calls). **CPU EP only**: windows are seconds long (interactive CPU latency
/// is fine) and the DirectML TDR hazard documented on [`w2v`] stays out of
/// the interactive path.
pub struct WindowAligner {
    w2v: w2v::W2v,
    /// Added to every word time at the end (negative shifts earlier); same
    /// bias correction as the full pass ([`CTC_ONSET_BIAS_S`]).
    pub onset_bias_s: f64,
}

impl WindowAligner {
    /// `model_root` is the same directory [`Aligner::load`] takes (contains
    /// `wav2vec2/`); whisper weights are not required or touched.
    pub fn load(model_root: &Path, threads: usize) -> Result<Self> {
        let w2v_dir = model_root.join(WAV2VEC2_DIR_NAME);
        if !w2v_dir.is_dir() {
            return Err(Error::Model(format!(
                "alignment model directory not found: {}",
                w2v_dir.display()
            )));
        }
        let (w2v, _note) = w2v::W2v::load(&w2v_dir, threads, /* try_dml = */ false)?;
        Ok(Self {
            w2v,
            onset_bias_s: CTC_ONSET_BIAS_S,
        })
    }

    /// Align `lyric_words` to `window16k` — a slice of the 16 kHz mono vocal
    /// stem that starts at `window_start_s` in **original-song time**
    /// (PLAN.md §5: the map's only time base). Output timings are 1:1 with
    /// `lyric_words`, in original-song time, monotonic by construction (the
    /// CTC trellis path is ordered). The caller splices them into the
    /// existing map, respecting neighbor words.
    pub fn align_window(
        &mut self,
        window16k: &[f32],
        window_start_s: f64,
        lyric_words: &[anchor::LyricWord],
    ) -> Result<Vec<WordTiming>> {
        if lyric_words.is_empty() {
            return Err(Error::InvalidInput("selection contains no words".into()));
        }
        if window16k.is_empty() {
            return Err(Error::InvalidInput("empty audio window".into()));
        }
        let em = self.w2v.emissions(window16k, &mut |_, _| {})?;
        window_words_from_emissions(
            &em,
            &self.w2v.vocab,
            self.w2v.blank,
            self.w2v.word_delim,
            lyric_words,
            window_start_s,
            self.onset_bias_s,
        )
    }
}

/// Deterministic core of [`WindowAligner::align_window`]: CTC trellis over an
/// emission matrix → per-word timings. Split out (and public) so the timing
/// math is unit-testable with a synthetic emission matrix — the ML part gets
/// golden smoke tests, this part is exact (CLAUDE.md test policy).
///
/// Returned words: `anchored = false` (no whisper evidence in this pass),
/// `unsung = false` (the user asserted the selection is sung here), lyric
/// links unset (the caller preserves the map's existing links). Unalignable
/// words (no in-vocab characters) get a zero-length placeholder at the
/// previous word's end, confidence 0.
pub fn window_words_from_emissions(
    em: &w2v::Emissions,
    vocab: &std::collections::HashMap<String, usize>,
    blank: usize,
    word_delim: usize,
    lyric_words: &[anchor::LyricWord],
    window_start_s: f64,
    onset_bias_s: f64,
) -> Result<Vec<WordTiming>> {
    if lyric_words.is_empty() {
        return Err(Error::InvalidInput("selection contains no words".into()));
    }
    let norm_refs: Vec<&str> = lyric_words.iter().map(|w| w.norm.as_str()).collect();
    let (targets, ranges) = w2v::words_to_targets(&norm_refs, vocab, word_delim);
    let spans = ctc::forced_align(&em.logprobs, em.n_frames, em.n_vocab, &targets, blank)?;
    let mut span_by_token: Vec<Option<&ctc::TokenSpan>> = vec![None; targets.len()];
    for s in &spans {
        span_by_token[s.token_index] = Some(s);
    }

    let mut out: Vec<WordTiming> = Vec::with_capacity(lyric_words.len());
    let mut last_end = 0.0f64; // window-relative
    for (i, (s_idx, e_idx)) in ranges.iter().enumerate() {
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
        let (start, end, confidence) = match (start_f, end_f) {
            (Some(sf), Some(ef)) => {
                let start = sf as f64 * w2v::FRAME_SEC;
                let end = ef as f64 * w2v::FRAME_SEC;
                last_end = end;
                (
                    start,
                    end,
                    (score_acc / score_n.max(1) as f32).exp().clamp(0.0, 1.0),
                )
            }
            _ => (last_end, last_end, 0.0),
        };
        // window-relative → original-song time, bias-corrected, clamped so
        // the correction can't produce negative song time
        let start = (window_start_s + start + onset_bias_s).max(0.0);
        let end = (window_start_s + end + onset_bias_s).max(start);
        out.push(WordTiming {
            word: lyric_words[i].display.clone(),
            start,
            end,
            confidence,
            anchored: false,
            unsung: false,
            line: None,
            word_in_line: None,
            ad_lib: false,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod window_tests {
    //! The trellis→timings math with a synthetic emission matrix (the model
    //! itself is covered by the env-gated smoke tests below).
    use super::*;
    use std::collections::HashMap;

    fn toy_vocab() -> (HashMap<String, usize>, usize, usize) {
        let mut v = HashMap::new();
        v.insert("<pad>".to_string(), 0usize);
        v.insert("|".to_string(), 1);
        v.insert("A".to_string(), 2);
        v.insert("B".to_string(), 3);
        (v, 0, 1) // (vocab, blank, word_delim)
    }

    /// Emissions where frame t is near-certain symbol `frames[t]`.
    fn synth(frames: &[usize], n_vocab: usize) -> w2v::Emissions {
        let hot = (0.9f32).ln();
        let cold = (0.1 / (n_vocab - 1) as f32).ln();
        let mut logprobs = vec![cold; frames.len() * n_vocab];
        for (t, &c) in frames.iter().enumerate() {
            logprobs[t * n_vocab + c] = hot;
        }
        w2v::Emissions {
            logprobs,
            n_frames: frames.len(),
            n_vocab,
        }
    }

    fn lw(s: &str) -> anchor::LyricWord {
        anchor::LyricWord {
            display: s.to_string(),
            norm: s.to_uppercase(),
        }
    }

    #[test]
    fn window_words_land_on_their_frames_offset_by_window_start() {
        let (vocab, blank, delim) = toy_vocab();
        // | A A A | B B | : word "a" at frames 1..4, "b" at frames 5..7
        let frames = [1, 2, 2, 2, 1, 3, 3, 1];
        let em = synth(&frames, 4);
        let words = [lw("a"), lw("b")];
        let out =
            window_words_from_emissions(&em, &vocab, blank, delim, &words, 30.0, 0.0).unwrap();
        assert_eq!(out.len(), 2);
        // frame 1 * 20 ms = 0.02 s into the window, window starts at 30 s
        assert!((out[0].start - 30.02).abs() < 1e-9, "start {}", out[0].start);
        assert!((out[0].end - (30.0 + 4.0 * w2v::FRAME_SEC)).abs() < 1e-9);
        assert!((out[1].start - (30.0 + 5.0 * w2v::FRAME_SEC)).abs() < 1e-9);
        assert!(out[0].confidence > 0.8);
        assert!(!out[0].anchored && !out[0].unsung);
        // monotonic + display text preserved
        assert!(out[0].start <= out[1].start && out[0].end <= out[1].start);
        assert_eq!(out[0].word, "a");
    }

    #[test]
    fn onset_bias_shifts_but_never_escapes_the_window_start_at_zero() {
        let (vocab, blank, delim) = toy_vocab();
        let frames = [2, 2, 1, 3, 3];
        let em = synth(&frames, 4);
        let words = [lw("a"), lw("b")];
        // window at t=0: bias would push word 'a' (frame 0) negative — clamp
        let out =
            window_words_from_emissions(&em, &vocab, blank, delim, &words, 0.0, -0.055).unwrap();
        assert!(out[0].start >= 0.0);
        assert!(out[0].end >= out[0].start);
        // interior word still shifted by the bias
        let unbiased_b = 3.0 * w2v::FRAME_SEC;
        assert!((out[1].start - (unbiased_b - 0.055)).abs() < 1e-9);
    }

    #[test]
    fn unalignable_word_gets_zero_length_placeholder() {
        let (vocab, blank, delim) = toy_vocab();
        let frames = [1, 2, 2, 1];
        let em = synth(&frames, 4);
        // "42" normalizes to characters outside the toy vocab
        let words = [lw("a"), anchor::LyricWord { display: "42".into(), norm: "42".into() }];
        let out =
            window_words_from_emissions(&em, &vocab, blank, delim, &words, 10.0, 0.0).unwrap();
        assert_eq!(out[1].start, out[1].end, "zero-length placeholder");
        assert_eq!(out[1].confidence, 0.0);
        assert!(out[1].start >= out[0].end - 1e-9, "placeholder sits at last end");
    }

    #[test]
    fn empty_selection_rejected() {
        let (vocab, blank, delim) = toy_vocab();
        let em = synth(&[1, 2, 1], 4);
        assert!(window_words_from_emissions(&em, &vocab, blank, delim, &[], 0.0, 0.0).is_err());
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
            .align(&decoded.samples, &lyrics, &mut |_f, m| eprintln!("[smoke] {m}"))
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

    /// Windowed re-align smoke: cut a mid-file window out of the TTS
    /// reference, re-align just the words whose truth onsets fall inside it,
    /// and check the windowed pass lands them where the truth says (CPU EP —
    /// the WindowAligner never uses a GPU).
    #[test]
    #[ignore = "needs wav2vec2 weights + TTS reference (set KARAOKE_TEST_ALIGN_MODELS, KARAOKE_TEST_TTS_WAV, KARAOKE_TEST_TTS_TRUTH)"]
    fn windowed_realign_matches_truth_onsets() {
        let models = std::env::var("KARAOKE_TEST_ALIGN_MODELS").expect("KARAOKE_TEST_ALIGN_MODELS");
        let wav = std::env::var("KARAOKE_TEST_TTS_WAV").expect("KARAOKE_TEST_TTS_WAV");
        let truth_path = std::env::var("KARAOKE_TEST_TTS_TRUTH").expect("KARAOKE_TEST_TTS_TRUTH");

        let mut truth: Vec<(String, f64)> = {
            let text = std::fs::read_to_string(&truth_path).unwrap();
            let v: serde_json::Value =
                serde_json::from_str(text.trim_start_matches('\u{feff}')).unwrap();
            v.as_array()
                .unwrap()
                .iter()
                .map(|e| {
                    (
                        e["word"].as_str().unwrap().to_string(),
                        e["onset_s"].as_f64().unwrap(),
                    )
                })
                .collect()
        };
        truth.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());

        let decoded = crate::audio::decode_to_mono_16k(Path::new(&wav)).unwrap();
        let total_s = decoded.samples.len() as f64 / SAMPLE_RATE as f64;
        // a ~10 s window from the middle of the file
        let win_start = (total_s / 2.0 - 5.0).max(0.0);
        let win_end = (win_start + 10.0).min(total_s);
        // words fully inside the window, with 1 s margin so none straddle it
        let selection: Vec<&(String, f64)> = truth
            .iter()
            .filter(|(_, t)| *t >= win_start + 1.0 && *t <= win_end - 1.0)
            .collect();
        assert!(selection.len() >= 3, "window too sparse for a meaningful test");
        let words: Vec<anchor::LyricWord> = selection
            .iter()
            .flat_map(|(w, _)| anchor::parse_lyrics(w))
            .collect();

        let s0 = (win_start * SAMPLE_RATE as f64) as usize;
        let s1 = (win_end * SAMPLE_RATE as f64) as usize;
        let mut wa =
            WindowAligner::load(Path::new(&models), 8).expect("load wav2vec2 (CPU)");
        let t0 = Instant::now();
        let out = wa
            .align_window(&decoded.samples[s0..s1], win_start, &words)
            .unwrap();
        let wall = t0.elapsed().as_secs_f64();

        assert_eq!(out.len(), selection.len());
        let mut errs: Vec<f64> = out
            .iter()
            .zip(&selection)
            .filter(|(w, _)| w.end > w.start)
            .map(|(w, (_, onset))| (w.start - onset).abs())
            .collect();
        errs.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let median = errs[errs.len() / 2];
        eprintln!(
            "[smoke] windowed re-align: {} words over {:.1}s window in {wall:.2}s wall (CPU); onset error median {:.0} ms, max {:.0} ms",
            out.len(),
            win_end - win_start,
            median * 1000.0,
            errs.last().unwrap() * 1000.0,
        );
        assert!(median < 0.1, "median onset error {median:.3}s");
        // monotonic by construction
        for pair in out.windows(2) {
            assert!(pair[0].start <= pair[1].start);
        }
    }
}
