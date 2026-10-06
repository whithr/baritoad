//! Pasted-lyrics anchoring: the user's lyrics are ground truth;
//! whisper's transcript is never trusted as text. Whisper words are matched to
//! lyric words by edit distance, and matched lyric words inherit whisper's
//! rough time window (its chunk) as an *anchor* — independent evidence that
//! the word was sung near that time. The CTC pass aligns the user's words; the
//! anchors validate its placements and expose unsung/uncertain spans.
//!
//! Normalization here is deliberately minimal: case folding plus dropping
//! characters outside the wav2vec2 charset (A–Z and apostrophe), used only for
//! matching/targets. Display text is preserved verbatim. The full lyric
//! cleanup stage (section headers, ×2 expansion, ad-libs) is a
//! separate upcoming milestone.

/// Maximum char-level edit-distance ratio for two words to count as a match.
pub const MATCH_MAX_RATIO: f64 = 0.5;

/// One word of pasted lyrics.
#[derive(Debug, Clone)]
pub struct LyricWord {
    /// Exactly as pasted (display text).
    pub display: String,
    /// Uppercased, wav2vec2-charset-only form used for matching and CTC
    /// targets. Empty when the token has no alignable characters.
    pub norm: String,
}

/// A whisper transcript word with the rough time window of the chunk that
/// produced it.
#[derive(Debug, Clone)]
pub struct TranscriptWord {
    pub norm: String,
    pub window_start_s: f64,
    pub window_end_s: f64,
}

/// Fold a word to the wav2vec2 charset: uppercase A–Z plus apostrophe.
/// Unicode apostrophes fold to `'`; everything else outside the charset drops.
pub fn normalize_word(w: &str) -> String {
    let mut out = String::with_capacity(w.len());
    for c in w.chars() {
        match c {
            '\u{2018}' | '\u{2019}' | '\u{02BC}' => out.push('\''),
            _ => {
                for u in c.to_uppercase() {
                    if u.is_ascii_alphabetic() || u == '\'' {
                        out.push(u);
                    }
                }
            }
        }
    }
    out
}

/// Split pasted lyrics into words, preserving display text.
pub fn parse_lyrics(text: &str) -> Vec<LyricWord> {
    text.split_whitespace()
        .map(|w| LyricWord {
            display: w.to_string(),
            norm: normalize_word(w),
        })
        .collect()
}

fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.is_empty() {
        return b.len();
    }
    if b.is_empty() {
        return a.len();
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0usize; b.len() + 1];
    for (i, &ca) in a.iter().enumerate() {
        cur[0] = i + 1;
        for (j, &cb) in b.iter().enumerate() {
            let sub = prev[j] + usize::from(ca != cb);
            cur[j + 1] = sub.min(prev[j + 1] + 1).min(cur[j] + 1);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}

/// Edit-distance ratio in [0, 1]: 0 = identical. `pub(crate)` because the
/// accuracy harness ([`crate::accuracy`]) reuses the same word-match rule.
pub(crate) fn edit_ratio(a: &str, b: &str) -> f64 {
    let m = a.chars().count().max(b.chars().count());
    if m == 0 {
        return 0.0;
    }
    levenshtein(a, b) as f64 / m as f64
}

/// Per-lyric-word anchor result.
#[derive(Debug, Clone, Copy)]
pub struct Anchor {
    /// Rough time window (whisper chunk) the matched transcript word came from.
    pub window_start_s: f64,
    pub window_end_s: f64,
}

/// Match lyric words to transcript words with a monotonic global alignment
/// (Needleman–Wunsch over words; substitution cost = char edit ratio, gap
/// cost 1). Returns one `Option<Anchor>` per lyric word — `Some` when whisper
/// independently heard a matching word (ratio <= [`MATCH_MAX_RATIO`]).
pub fn anchor_lyrics(lyrics: &[LyricWord], transcript: &[TranscriptWord]) -> Vec<Option<Anchor>> {
    let n = lyrics.len();
    let m = transcript.len();
    let mut anchors: Vec<Option<Anchor>> = vec![None; n];
    if n == 0 || m == 0 {
        return anchors;
    }
    const GAP: f64 = 1.0;
    // cost for pairing words that don't really match: worse than one gap but
    // better than two, so the DP still prefers gaps around genuine matches.
    const MISMATCH: f64 = 1.5;

    let sub_cost = |i: usize, j: usize| -> f64 {
        let r = edit_ratio(&lyrics[i].norm, &transcript[j].norm);
        if r <= MATCH_MAX_RATIO {
            r
        } else {
            MISMATCH
        }
    };

    // dp[(i, j)] over (n+1) x (m+1); backpointer 0=diag, 1=skip-lyric, 2=skip-transcript
    let w = m + 1;
    let mut dp = vec![0.0f64; (n + 1) * w];
    let mut bp = vec![0u8; (n + 1) * w];
    for j in 0..=m {
        dp[j] = j as f64 * GAP;
        bp[j] = 2;
    }
    for i in 1..=n {
        dp[i * w] = i as f64 * GAP;
        bp[i * w] = 1;
        for j in 1..=m {
            let diag = dp[(i - 1) * w + (j - 1)] + sub_cost(i - 1, j - 1);
            let up = dp[(i - 1) * w + j] + GAP; // skip lyric word
            let left = dp[i * w + (j - 1)] + GAP; // skip transcript word
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

    let (mut i, mut j) = (n, m);
    while i > 0 || j > 0 {
        match bp[i * w + j] {
            0 => {
                i -= 1;
                j -= 1;
                if edit_ratio(&lyrics[i].norm, &transcript[j].norm) <= MATCH_MAX_RATIO
                    && !lyrics[i].norm.is_empty()
                {
                    anchors[i] = Some(Anchor {
                        window_start_s: transcript[j].window_start_s,
                        window_end_s: transcript[j].window_end_s,
                    });
                }
            }
            1 => i -= 1,
            _ => j -= 1,
        }
    }
    anchors
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tw(words: &[&str], t0: f64, t1: f64) -> Vec<TranscriptWord> {
        words
            .iter()
            .map(|w| TranscriptWord {
                norm: normalize_word(w),
                window_start_s: t0,
                window_end_s: t1,
            })
            .collect()
    }

    #[test]
    fn normalization_folds_case_and_punctuation() {
        assert_eq!(normalize_word("Hello,"), "HELLO");
        assert_eq!(normalize_word("don\u{2019}t"), "DON'T");
        assert_eq!(normalize_word("na-na"), "NANA");
        assert_eq!(normalize_word("[Chorus]"), "CHORUS");
        assert_eq!(normalize_word("42"), ""); // no alignable characters
    }

    #[test]
    fn parse_preserves_display_text() {
        let words = parse_lyrics("Hello, world!\nDon\u{2019}t stop");
        assert_eq!(words.len(), 4);
        assert_eq!(words[0].display, "Hello,");
        assert_eq!(words[0].norm, "HELLO");
        assert_eq!(words[2].display, "Don\u{2019}t");
        assert_eq!(words[2].norm, "DON'T");
    }

    #[test]
    fn exact_transcript_anchors_everything() {
        let lyr = parse_lyrics("the quick brown fox");
        let tr = tw(&["the", "quick", "brown", "fox"], 0.0, 5.0);
        let a = anchor_lyrics(&lyr, &tr);
        assert!(a.iter().all(|x| x.is_some()));
        assert_eq!(a[0].unwrap().window_end_s, 5.0);
    }

    #[test]
    fn under_transcription_leaves_missed_words_unanchored() {
        // whisper missed the middle words (instrumental-heavy stretch)
        let lyr = parse_lyrics("one two three four five six");
        let tr = tw(&["one", "two", "six"], 0.0, 30.0);
        let a = anchor_lyrics(&lyr, &tr);
        assert!(a[0].is_some());
        assert!(a[1].is_some());
        assert!(a[2].is_none());
        assert!(a[3].is_none());
        assert!(a[4].is_none());
        assert!(a[5].is_some());
    }

    #[test]
    fn fuzzy_match_anchors_close_words_only() {
        let lyr = parse_lyrics("running colour");
        // whisper heard variants; "runnin" matches, "table" does not
        let tr = tw(&["runnin", "table"], 0.0, 10.0);
        let a = anchor_lyrics(&lyr, &tr);
        assert!(a[0].is_some(), "RUNNIN should anchor RUNNING");
        assert!(a[1].is_none(), "TABLE must not anchor COLOUR");
    }

    #[test]
    fn hallucinated_extra_words_are_ignored() {
        let lyr = parse_lyrics("hello world");
        let tr = tw(&["hello", "thanks", "for", "watching", "world"], 0.0, 10.0);
        let a = anchor_lyrics(&lyr, &tr);
        assert!(a[0].is_some());
        assert!(a[1].is_some());
    }

    #[test]
    fn empty_norm_words_never_anchor() {
        let lyr = parse_lyrics("42 hello");
        let tr = tw(&["hello"], 0.0, 10.0);
        let a = anchor_lyrics(&lyr, &tr);
        assert!(a[0].is_none());
        assert!(a[1].is_some());
    }
}
