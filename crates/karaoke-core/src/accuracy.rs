//! Accuracy harness: word-timing error of a pipeline
//! timing map against a hand-made UltraStar reference file.
//!
//! Hypothesis words (the map) are matched to reference words (imported
//! UltraStar notes, syllables merged) by **normalized text** — the same
//! folding the aligner matches with ([`anchor::normalize_word`]) and the same
//! fuzzy-match rule ([`anchor::MATCH_MAX_RATIO`] over char edit distance),
//! via a monotonic Needleman–Wunsch alignment. Timing never participates in
//! matching: the whole point is to measure timing, so matching on it would
//! beg the question.
//!
//! Reported: the onset-error distribution (median/p90/p95/max, % ≤ 50 ms,
//! % ≤ 100 ms, signed mean for bias) plus **explicit** unmatched words on
//! both sides — reference words the pipeline missed and hypothesis words with
//! no reference. Silent drops would flatter the numbers.
//!
//! [`self_check`] closes the loop without any hand-made file: export a map as
//! UltraStar, re-import, grade against the same map. Errors must then equal
//! beat quantization only (≤ one beat = 50 ms at the fixed export BPM) — a
//! zero-cost regression net over exporter, importer, and grader at once.

use serde::Serialize;

use crate::alignment::anchor::{self, MATCH_MAX_RATIO};
use crate::error::Result;
use crate::formats::{self, ultrastar, ExportMeta, Format};
use crate::timing::WordTimingMap;

/// One reference word (from the hand-made UltraStar file).
#[derive(Debug, Clone, Serialize)]
pub struct RefWord {
    pub text: String,
    /// [`anchor::normalize_word`] form used for matching.
    pub norm: String,
    pub start: f64,
    pub end: f64,
    /// Freestyle notes: shown, never timing-scored by UltraStar players.
    /// They still participate in matching (so they don't surface as spurious
    /// unmatched words) and are counted separately in the report.
    pub freestyle: bool,
}

/// Build reference words from a parsed UltraStar song.
pub fn ref_words(song: &ultrastar::UltraStarSong) -> Vec<RefWord> {
    song.words()
        .into_iter()
        .map(|w| RefWord {
            norm: anchor::normalize_word(&w.text),
            text: w.text,
            start: w.start,
            end: w.end,
            freestyle: w.freestyle,
        })
        .collect()
}

/// A matched hypothesis/reference word pair with its signed onset error
/// (hypothesis − reference; positive = pipeline late).
#[derive(Debug, Clone, Serialize)]
pub struct MatchedPair {
    pub hyp_index: usize,
    pub ref_index: usize,
    pub word: String,
    pub error_s: f64,
    pub freestyle: bool,
}

/// An unmatched word, reported explicitly (module docs).
#[derive(Debug, Clone, Serialize)]
pub struct UnmatchedWord {
    pub index: usize,
    pub word: String,
    pub start: f64,
}

/// Onset-error distribution over a set of matched pairs.
#[derive(Debug, Clone, Serialize)]
pub struct ErrorStats {
    pub n: usize,
    pub median_ms: f64,
    pub p90_ms: f64,
    pub p95_ms: f64,
    pub max_ms: f64,
    /// Signed mean (bias): positive = pipeline late vs reference.
    pub mean_signed_ms: f64,
    pub pct_within_50ms: f64,
    pub pct_within_100ms: f64,
}

impl ErrorStats {
    /// Nearest-rank percentiles over the |error| distribution.
    pub fn from_signed_errors(errors_s: &[f64]) -> Self {
        let n = errors_s.len();
        if n == 0 {
            return Self {
                n: 0,
                median_ms: f64::NAN,
                p90_ms: f64::NAN,
                p95_ms: f64::NAN,
                max_ms: f64::NAN,
                mean_signed_ms: f64::NAN,
                pct_within_50ms: f64::NAN,
                pct_within_100ms: f64::NAN,
            };
        }
        let mut abs: Vec<f64> = errors_s.iter().map(|e| e.abs() * 1000.0).collect();
        abs.sort_by(|a, b| a.partial_cmp(b).expect("finite errors"));
        let pct = |p: f64| -> f64 {
            let rank = ((p / 100.0) * n as f64).ceil().max(1.0) as usize;
            abs[rank - 1]
        };
        Self {
            n,
            median_ms: pct(50.0),
            p90_ms: pct(90.0),
            p95_ms: pct(95.0),
            max_ms: *abs.last().expect("non-empty"),
            mean_signed_ms: errors_s.iter().sum::<f64>() / n as f64 * 1000.0,
            pct_within_50ms: 100.0 * abs.iter().filter(|&&e| e <= 50.0).count() as f64 / n as f64,
            pct_within_100ms: 100.0 * abs.iter().filter(|&&e| e <= 100.0).count() as f64
                / n as f64,
        }
    }
}

/// Full grading result for one song.
#[derive(Debug, Clone, Serialize)]
pub struct AccuracyReport {
    pub n_ref: usize,
    pub n_hyp: usize,
    pub n_matched: usize,
    pub n_freestyle_matched: usize,
    pub stats: ErrorStats,
    /// Reference words the pipeline missed.
    pub unmatched_ref: Vec<UnmatchedWord>,
    /// Hypothesis words with no reference.
    pub unmatched_hyp: Vec<UnmatchedWord>,
    pub matched: Vec<MatchedPair>,
}

/// Grade a pipeline timing map against reference words (module docs).
pub fn grade(hyp: &WordTimingMap, refs: &[RefWord]) -> AccuracyReport {
    let hyp_norms: Vec<String> = hyp
        .words
        .iter()
        .map(|w| anchor::normalize_word(&w.word))
        .collect();

    // Needleman–Wunsch over words: substitution = char edit ratio when the
    // words plausibly match, else a mismatch cost worse than one gap but
    // better than two (same shape as anchor::anchor_lyrics; a pairing only
    // becomes a *match* when the ratio clears MATCH_MAX_RATIO).
    const GAP: f64 = 1.0;
    const MISMATCH: f64 = 1.5;
    let n = hyp_norms.len();
    let m = refs.len();
    let sub = |i: usize, j: usize| -> f64 {
        if hyp_norms[i].is_empty() || refs[j].norm.is_empty() {
            return MISMATCH; // unalignable tokens never match anything
        }
        let r = anchor::edit_ratio(&hyp_norms[i], &refs[j].norm);
        if r <= MATCH_MAX_RATIO {
            r
        } else {
            MISMATCH
        }
    };
    let w = m + 1;
    let mut dp = vec![0.0f64; (n + 1) * w];
    let mut bp = vec![0u8; (n + 1) * w]; // 0=diag 1=skip-hyp 2=skip-ref
    for j in 0..=m {
        dp[j] = j as f64 * GAP;
        bp[j] = 2;
    }
    for i in 1..=n {
        dp[i * w] = i as f64 * GAP;
        bp[i * w] = 1;
        for j in 1..=m {
            let diag = dp[(i - 1) * w + (j - 1)] + sub(i - 1, j - 1);
            let up = dp[(i - 1) * w + j] + GAP;
            let left = dp[i * w + (j - 1)] + GAP;
            let (best, which) = if diag <= up && diag <= left {
                (diag, 0u8)
            } else if up <= left {
                (up, 1u8)
            } else {
                (left, 2u8)
            };
            dp[i * w + j] = best;
            bp[i * w + j] = which;
        }
    }

    let mut matched: Vec<MatchedPair> = Vec::new();
    let mut hyp_matched = vec![false; n];
    let mut ref_matched = vec![false; m];
    let (mut i, mut j) = (n, m);
    while i > 0 || j > 0 {
        match bp[i * w + j] {
            0 => {
                i -= 1;
                j -= 1;
                let plausible = !hyp_norms[i].is_empty()
                    && !refs[j].norm.is_empty()
                    && anchor::edit_ratio(&hyp_norms[i], &refs[j].norm) <= MATCH_MAX_RATIO;
                if plausible {
                    hyp_matched[i] = true;
                    ref_matched[j] = true;
                    matched.push(MatchedPair {
                        hyp_index: i,
                        ref_index: j,
                        word: refs[j].text.clone(),
                        error_s: hyp.words[i].start - refs[j].start,
                        freestyle: refs[j].freestyle,
                    });
                }
            }
            1 => i -= 1,
            _ => j -= 1,
        }
    }
    matched.reverse();

    let errors: Vec<f64> = matched.iter().map(|p| p.error_s).collect();
    AccuracyReport {
        n_ref: m,
        n_hyp: n,
        n_matched: matched.len(),
        n_freestyle_matched: matched.iter().filter(|p| p.freestyle).count(),
        stats: ErrorStats::from_signed_errors(&errors),
        unmatched_ref: refs
            .iter()
            .enumerate()
            .filter(|(j, _)| !ref_matched[*j])
            .map(|(j, r)| UnmatchedWord {
                index: j,
                word: r.text.clone(),
                start: r.start,
            })
            .collect(),
        unmatched_hyp: hyp
            .words
            .iter()
            .enumerate()
            .filter(|(i, _)| !hyp_matched[*i])
            .map(|(i, w)| UnmatchedWord {
                index: i,
                word: w.word.clone(),
                start: w.start,
            })
            .collect(),
        matched,
    }
}

/// Synthetic self-check (module docs): export → re-import → grade against the
/// same map. With no pipeline or reference file involved, any error beyond
/// beat quantization (± clamping of colliding sub-beat notes) is a bug in the
/// exporter, the importer, or the grader.
pub fn self_check(map: &WordTimingMap, meta: &ExportMeta) -> Result<AccuracyReport> {
    let txt = formats::export(map, meta, Format::UltraStar);
    let song = ultrastar::import(&txt)?;
    Ok(grade(map, &ref_words(&song)))
}

/// The self-check pass bound: one UltraStar beat at the fixed export BPM.
pub const SELF_CHECK_BOUND_MS: f64 = ultrastar::BEAT_MS as f64;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::timing::{WordTiming, WordTimingMap};

    fn word(w: &str, start: f64, end: f64) -> WordTiming {
        WordTiming {
            word: w.into(),
            start,
            end,
            confidence: 0.9,
            anchored: true,
            unsung: false,
            line: None,
            word_in_line: None,
            ad_lib: false,
        }
    }

    fn rw(text: &str, start: f64) -> RefWord {
        RefWord {
            norm: anchor::normalize_word(text),
            text: text.into(),
            start,
            end: start + 0.3,
            freestyle: false,
        }
    }

    #[test]
    fn perfect_match_scores_zero() {
        let map = WordTimingMap::new(
            10.0,
            vec![word("Hello,", 1.0, 1.3), word("world!", 1.5, 1.9)],
            vec![],
        );
        let refs = vec![rw("hello", 1.0), rw("world", 1.5)];
        let r = grade(&map, &refs);
        assert_eq!(r.n_matched, 2);
        assert!(r.unmatched_ref.is_empty() && r.unmatched_hyp.is_empty());
        assert_eq!(r.stats.max_ms, 0.0);
        assert_eq!(r.stats.pct_within_50ms, 100.0);
    }

    #[test]
    fn known_offsets_produce_expected_percentiles() {
        // 10 words, |errors| 10..100 ms, alternating sign
        let mut hyp = Vec::new();
        let mut refs = Vec::new();
        for k in 0..10 {
            let t = 1.0 + k as f64;
            let err = (k + 1) as f64 * 0.010 * if k % 2 == 0 { 1.0 } else { -1.0 };
            hyp.push(word(&format!("w{k}ord"), t + err, t + err + 0.3));
            refs.push(rw(&format!("w{k}ord"), t));
        }
        let map = WordTimingMap::new(60.0, hyp, vec![]);
        let r = grade(&map, &refs);
        assert_eq!(r.n_matched, 10);
        assert!((r.stats.median_ms - 50.0).abs() < 1e-6, "{:?}", r.stats);
        assert!((r.stats.p90_ms - 90.0).abs() < 1e-6);
        assert!((r.stats.p95_ms - 100.0).abs() < 1e-6);
        assert!((r.stats.max_ms - 100.0).abs() < 1e-6);
        assert!((r.stats.pct_within_50ms - 50.0).abs() < 1e-6);
        assert!((r.stats.pct_within_100ms - 100.0).abs() < 1e-6);
        // alternating sign, magnitudes 10,-20,30,-40,... -> mean -5 ms
        assert!((r.stats.mean_signed_ms - (-5.0)).abs() < 1e-6);
    }

    #[test]
    fn unmatched_words_are_reported_on_both_sides() {
        // pipeline missed "ghost"; pipeline hallucinated placement of "extra"
        let map = WordTimingMap::new(
            20.0,
            vec![
                word("one", 1.0, 1.2),
                word("extra", 2.0, 2.2),
                word("two", 3.0, 3.2),
            ],
            vec![],
        );
        let refs = vec![rw("one", 1.0), rw("two", 3.0), rw("ghost", 5.0)];
        let r = grade(&map, &refs);
        assert_eq!(r.n_matched, 2);
        assert_eq!(r.unmatched_ref.len(), 1);
        assert_eq!(r.unmatched_ref[0].word, "ghost");
        assert_eq!(r.unmatched_hyp.len(), 1);
        assert_eq!(r.unmatched_hyp[0].word, "extra");
    }

    #[test]
    fn fuzzy_text_still_matches_but_junk_does_not() {
        let map = WordTimingMap::new(
            10.0,
            vec![word("running", 1.0, 1.4), word("42", 2.0, 2.0)],
            vec![],
        );
        let refs = vec![rw("runnin'", 1.02)];
        let r = grade(&map, &refs);
        assert_eq!(r.n_matched, 1);
        assert!((r.matched[0].error_s - (-0.02)).abs() < 1e-9);
        // the unalignable "42" (empty norm) never matches
        assert_eq!(r.unmatched_hyp.len(), 1);
    }

    #[test]
    fn self_check_error_is_quantization_bound_only() {
        // realistic map shape: two lines, an ad-lib, an unsung word — every
        // exporter code path (normal, freestyle) crosses the round trip
        let mut words = vec![
            word("Cold", 12.113, 12.471),
            word("water", 12.502, 12.988),
            word("rising", 13.100, 13.642),
            word("slow", 13.701, 14.250),
            word("(hey)", 15.010, 15.300),
            word("carry", 16.407, 16.881),
            word("me", 16.940, 17.203),
            word("home", 17.290, 17.881),
        ];
        for (i, w) in words.iter_mut().enumerate() {
            w.line = Some(i / 4);
            w.word_in_line = Some(i % 4);
        }
        words[4].ad_lib = true;
        words[7].unsung = true;
        let map = WordTimingMap::new(30.0, words, vec![]);
        let r = self_check(&map, &ExportMeta::default()).unwrap();
        assert_eq!(r.n_matched, map.words.len(), "unmatched: {:?} / {:?}", r.unmatched_ref, r.unmatched_hyp);
        assert!(r.unmatched_ref.is_empty() && r.unmatched_hyp.is_empty());
        assert!(
            r.stats.max_ms <= SELF_CHECK_BOUND_MS + 1e-6,
            "max {} ms exceeds the one-beat bound",
            r.stats.max_ms
        );
        assert_eq!(r.n_freestyle_matched, 2); // the ad-lib and the unsung word
    }
}
