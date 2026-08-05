//! CTC forced alignment (Viterbi over the standard CTC state graph),
//! reimplementing torchaudio.functional.forced_align in Rust.
//!
//! States: 2N+1 where N = targets.len(); even states are blanks, odd state
//! 2i+1 is target token i. Allowed transitions per frame: stay, from s-1,
//! and from s-2 when the current state is a token that differs from the
//! token two states back.

use anyhow::{anyhow, Result};

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
    let n = targets.len();
    let s_count = 2 * n + 1;
    if n == 0 {
        return Err(anyhow!("empty targets"));
    }
    if n_frames < n {
        return Err(anyhow!("audio too short for target sequence: {n_frames} frames < {n} tokens"));
    }
    let sym = |s: usize| -> usize {
        if s % 2 == 0 {
            blank
        } else {
            targets[(s - 1) / 2]
        }
    };

    const NEG_INF: f32 = f32::NEG_INFINITY;
    let mut prev = vec![NEG_INF; s_count];
    let mut cur = vec![NEG_INF; s_count];
    // backpointers: 0 = stay, 1 = from s-1, 2 = from s-2
    let mut bp = vec![0u8; n_frames * s_count];

    let lp = |t: usize, c: usize| logprobs[t * n_vocab + c];

    prev[0] = lp(0, blank);
    if s_count > 1 {
        prev[1] = lp(0, sym(1));
    }

    for t in 1..n_frames {
        let row_bp = &mut bp[t * s_count..(t + 1) * s_count];
        for s in 0..s_count {
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
        return Err(anyhow!("no valid alignment path"));
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
