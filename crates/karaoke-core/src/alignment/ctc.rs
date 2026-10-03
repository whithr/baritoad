//! CTC forced alignment (Viterbi over the standard CTC state graph),
//! reimplementing `torchaudio.functional.forced_align` in Rust.
//!
//! Ported from spikes/alignment, where it was validated **frame-exact** against
//! torchaudio on all five test songs (5,080/5,080 token spans identical —
//! spikes/alignment/REPORT.md).
//!
//! States: 2N+1 where N = targets.len(); even states are blanks, odd state
//! 2i+1 is target token i. Allowed transitions per frame: stay, from s-1,
//! and from s-2 when the current state is a token that differs from the
//! token two states back.

use crate::error::{Error, Result};

pub struct TokenSpan {
    pub token_index: usize, // index into targets
    pub token_id: usize,
    pub start_frame: usize,
    pub end_frame: usize, // exclusive
    pub score: f32,       // mean frame log-prob over the span
}

pub fn forced_align(
    logprobs: &[f32], // [T][C] row-major
    n_frames: usize,
    n_vocab: usize,
    targets: &[usize],
    blank: usize,
) -> Result<Vec<TokenSpan>> {
    forced_align_constrained(logprobs, n_frames, n_vocab, targets, blank, None)
}

/// Frames inside long silences of the vocal stem (the aligner's silent
/// stretches): the path may spend them only in a blank state *between*
/// words, so no token lands in a silence and no word spans one.
pub struct Silence<'a> {
    /// `frames[t]`: frame `t` lies inside a silence (frames past the end
    /// don't).
    pub frames: &'a [bool],
    /// The word-boundary token (`|`): the blanks on either side of it — and
    /// before the first and after the last token — are between words.
    pub word_delim: usize,
}

/// [`forced_align`] constrained by [`Silence`]. When the constraint leaves no
/// valid path this returns the same error as an over-long target sequence;
/// the caller decides whether to retry unconstrained.
pub fn forced_align_constrained(
    logprobs: &[f32], // [T][C] row-major
    n_frames: usize,
    n_vocab: usize,
    targets: &[usize],
    blank: usize,
    silence: Option<&Silence>,
) -> Result<Vec<TokenSpan>> {
    let n = targets.len();
    let s_count = 2 * n + 1;
    if n == 0 {
        return Err(Error::InvalidInput("empty alignment targets".into()));
    }
    if n_frames < n {
        return Err(Error::InvalidInput(format!(
            "audio too short for target sequence: {n_frames} frames < {n} tokens"
        )));
    }
    let sym = |s: usize| -> usize {
        if s % 2 == 0 {
            blank
        } else {
            targets[(s - 1) / 2]
        }
    };
    let silent = |t: usize| silence.is_some_and(|m| m.frames.get(t).copied().unwrap_or(false));
    // states a silent frame may be spent in
    let between_words: Vec<bool> = (0..s_count)
        .map(|s| {
            s % 2 == 0
                && (s == 0
                    || s == s_count - 1
                    || silence
                        .is_some_and(|m| sym(s - 1) == m.word_delim || sym(s + 1) == m.word_delim))
        })
        .collect();

    const NEG_INF: f32 = f32::NEG_INFINITY;
    let mut prev = vec![NEG_INF; s_count];
    let mut cur = vec![NEG_INF; s_count];
    // backpointers: 0 = stay, 1 = from s-1, 2 = from s-2
    let mut bp = vec![0u8; n_frames * s_count];

    let lp = |t: usize, c: usize| logprobs[t * n_vocab + c];

    prev[0] = lp(0, blank);
    if s_count > 1 && !silent(0) {
        prev[1] = lp(0, sym(1));
    }

    for t in 1..n_frames {
        let row_bp = &mut bp[t * s_count..(t + 1) * s_count];
        let silent_frame = silent(t);
        for s in 0..s_count {
            if silent_frame && !between_words[s] {
                cur[s] = NEG_INF;
                row_bp[s] = 0;
                continue;
            }
            let mut best = prev[s];
            let mut which = 0u8;
            if s >= 1 && prev[s - 1] > best {
                best = prev[s - 1];
                which = 1;
            }
            if s >= 2 && s % 2 == 1 {
                let cur_tok = sym(s);
                let two_back = sym(s - 2);
                if cur_tok != two_back && prev[s - 2] > best {
                    best = prev[s - 2];
                    which = 2;
                }
            }
            if best == NEG_INF {
                cur[s] = NEG_INF;
                row_bp[s] = 0;
            } else {
                cur[s] = best + lp(t, sym(s));
                row_bp[s] = which;
            }
        }
        std::mem::swap(&mut prev, &mut cur);
    }

    // end in last blank or last token
    let mut s = s_count - 1;
    if s_count >= 2 && prev[s_count - 2] > prev[s_count - 1] {
        s = s_count - 2;
    }
    if prev[s] == NEG_INF {
        return Err(Error::Inference(
            "no valid CTC alignment path (targets longer than emissions allow)".into(),
        ));
    }

    // backtrack: state per frame
    let mut path = vec![0usize; n_frames];
    path[n_frames - 1] = s;
    for t in (1..n_frames).rev() {
        let step = bp[t * s_count + s];
        s -= step as usize;
        path[t - 1] = s;
    }

    // collapse to token spans (odd states only)
    let mut spans: Vec<TokenSpan> = Vec::new();
    let mut t = 0usize;
    while t < n_frames {
        let st = path[t];
        if st % 2 == 1 {
            let start = t;
            let mut score_sum = 0.0f32;
            while t < n_frames && path[t] == st {
                score_sum += lp(t, sym(st));
                t += 1;
            }
            spans.push(TokenSpan {
                token_index: (st - 1) / 2,
                token_id: sym(st),
                start_frame: start,
                end_frame: t,
                score: score_sum / (t - start) as f32,
            });
        } else {
            t += 1;
        }
    }
    Ok(spans)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build emissions where at each frame exactly one symbol is near-certain.
    /// `frames[t]` is the dominant symbol id at frame t.
    fn emissions(frames: &[usize], n_vocab: usize) -> Vec<f32> {
        let hot = (0.9f32).ln();
        let cold = (0.1 / (n_vocab - 1) as f32).ln();
        let mut e = vec![cold; frames.len() * n_vocab];
        for (t, &c) in frames.iter().enumerate() {
            e[t * n_vocab + c] = hot;
        }
        e
    }

    #[test]
    fn aligns_obvious_sequence() {
        // blank=0, tokens 1,2. audio: _ 1 1 _ 2 2 _
        let frames = [0, 1, 1, 0, 2, 2, 0];
        let e = emissions(&frames, 3);
        let spans = forced_align(&e, frames.len(), 3, &[1, 2], 0).unwrap();
        assert_eq!(spans.len(), 2);
        assert_eq!((spans[0].token_index, spans[0].token_id), (0, 1));
        assert_eq!((spans[0].start_frame, spans[0].end_frame), (1, 3));
        assert_eq!((spans[1].token_index, spans[1].token_id), (1, 2));
        assert_eq!((spans[1].start_frame, spans[1].end_frame), (4, 6));
        // near-certain frames -> high mean log-prob
        assert!(spans[0].score > (0.8f32).ln());
    }

    #[test]
    fn repeated_token_needs_blank_between() {
        // targets [1, 1]: CTC requires a blank between repeats, so the path
        // must produce two separate spans.
        let frames = [1, 1, 0, 1, 1];
        let e = emissions(&frames, 2);
        let spans = forced_align(&e, frames.len(), 2, &[1, 1], 0).unwrap();
        assert_eq!(spans.len(), 2);
        assert!(spans[0].end_frame <= 2);
        assert!(spans[1].start_frame >= 3);
    }

    #[test]
    fn empty_targets_rejected() {
        let e = emissions(&[0, 0], 2);
        assert!(forced_align(&e, 2, 2, &[], 0).is_err());
    }

    #[test]
    fn too_short_audio_rejected() {
        let e = emissions(&[1], 3);
        assert!(forced_align(&e, 1, 3, &[1, 2], 0).is_err());
    }

    #[test]
    fn silence_moves_a_token_to_its_weaker_evidence() {
        // blank 0, '|' 1, token 2 (targets "|x|"): x is near-certain at
        // frame 1, inside a silence, and only plausible at frame 5
        let frames = [0, 2, 0, 0, 0, 0, 0];
        let mut e = emissions(&frames, 3);
        e[5 * 3 + 2] = (0.4f32).ln();
        e[5 * 3] = (0.6f32).ln();
        let free = forced_align(&e, frames.len(), 3, &[1, 2, 1], 0).unwrap();
        assert_eq!(free[1].start_frame, 1);
        let silent = [true, true, true, false, false, false, false];
        let silence = Silence {
            frames: &silent,
            word_delim: 1,
        };
        let held =
            forced_align_constrained(&e, frames.len(), 3, &[1, 2, 1], 0, Some(&silence)).unwrap();
        let x = held.iter().find(|s| s.token_index == 1).unwrap();
        assert_eq!((x.start_frame, x.end_frame), (5, 6));
        assert!(
            held.iter().all(|s| s.start_frame >= 3),
            "no token in the silence"
        );
    }

    #[test]
    fn a_word_never_spans_a_silence() {
        // blank 0, '|' 1, A 2, B 3; targets "|AB|". A is certain before the
        // silence (frames 3..=6) and B after it: the plain trellis splits the
        // word across the silence, the constrained one keeps it on one side.
        let frames = [0, 2, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0];
        let e = emissions(&frames, 4);
        let targets = [1, 2, 3, 1];
        let free = forced_align(&e, frames.len(), 4, &targets, 0).unwrap();
        assert_eq!((free[1].start_frame, free[2].start_frame), (1, 9));
        let silent = [false, false, false, true, true, true, true];
        let silence = Silence {
            frames: &silent,
            word_delim: 1,
        };
        let held =
            forced_align_constrained(&e, frames.len(), 4, &targets, 0, Some(&silence)).unwrap();
        let (a, b) = (&held[1], &held[2]);
        assert!(
            b.end_frame <= 3 || a.start_frame >= 7,
            "word split across the silence: A {}..{}, B {}..{}",
            a.start_frame,
            a.end_frame,
            b.start_frame,
            b.end_frame
        );
    }

    #[test]
    fn silence_leaving_too_few_frames_has_no_path() {
        // two distinct tokens, only one frame outside the silence
        let frames = [0, 1, 2, 0];
        let e = emissions(&frames, 3);
        let silent = [true, false, true, true];
        let silence = Silence {
            frames: &silent,
            word_delim: 9,
        };
        let r = forced_align_constrained(&e, frames.len(), 3, &[1, 2], 0, Some(&silence));
        assert!(matches!(r, Err(Error::Inference(_))));
        // frames past the end of the silence mask are unconstrained
        let short = Silence {
            frames: &[true],
            word_delim: 9,
        };
        let spans =
            forced_align_constrained(&e, frames.len(), 3, &[1, 2], 0, Some(&short)).unwrap();
        assert_eq!(spans.len(), 2);
    }

    #[test]
    fn spans_are_monotonic_and_ordered() {
        let frames = [0, 1, 0, 2, 0, 3, 0, 1, 0];
        let e = emissions(&frames, 4);
        let spans = forced_align(&e, frames.len(), 4, &[1, 2, 3, 1], 0).unwrap();
        assert_eq!(spans.len(), 4);
        for w in spans.windows(2) {
            assert!(w[0].end_frame <= w[1].start_frame);
            assert!(w[0].token_index < w[1].token_index);
        }
    }
}
