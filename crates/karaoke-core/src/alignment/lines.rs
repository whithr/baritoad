//! Line breaks for transcribed lyrics.
//!
//! Without pasted lyrics there are no line breaks to keep, and whisper's
//! silence-aware chunks run up to ~30 s — a whole verse in one "line"
//! (9 lines of 11-49 words for a 4:07 song). This re-breaks each chunk the
//! way lyrics are written, from the aligned word timings: a small optimal
//! line-breaking pass (Knuth-Plass style) that rewards breaking at the
//! singer's pauses — and after whisper's sentence punctuation — while keeping
//! each line near a typical sung-line shape.
//!
//! Why not a pause threshold: in 7 songs with real line breaks, half the
//! breaks have a gap under 0.38 s (the singer flows into the next line) and
//! 3% of gaps *inside* lines exceed 0.78 s, so any fixed threshold misses
//! most breaks or splits mid-line. Which gaps are big *relative to the line
//! length* is the useful signal. Measured on those songs (timings only, no
//! punctuation), break F1 0.65 exact / 0.76 within one word, against 0.37 /
//! 0.39 for chunk boundaries alone. Typical lines there: 3-10 words (median
//! 6), 1.0-5.2 s (median 2.5 s).

/// One aligned word.
#[derive(Debug, Clone, Copy)]
pub struct Timed<'a> {
    pub start: f64,
    pub end: f64,
    pub text: &'a str,
}

/// Line shape the cost pulls toward (tuned on the songs above).
const TARGET_WORDS: f64 = 7.0;
const TARGET_SECONDS: f64 = 3.0;
const WORDS_WEIGHT: f64 = 0.25;
const SECONDS_WEIGHT: f64 = 0.4;
/// Reward for breaking at a gap: weight × √(gap, capped at 2 s).
const GAP_WEIGHT: f64 = 3.0;
const GAP_CAP_S: f64 = 2.0;
/// Extra reward for breaking after ". ? !" (whisper punctuates).
const PUNCT_BONUS: f64 = 0.8;
/// Every break costs this much, so lines aren't split for nothing.
const BREAK_COST: f64 = 2.5;
/// Longest line the search considers.
const MAX_LINE_WORDS: usize = 24;

/// Word indices a new line starts at (never 0), ascending.
pub fn break_lines(words: &[Timed<'_>]) -> Vec<usize> {
    let n = words.len();
    if n < 2 {
        return Vec::new();
    }
    let gap = |i: usize| (words[i].start - words[i - 1].end).max(0.0);
    let punct = |i: usize| {
        matches!(
            words[i - 1].text.trim_end().chars().last(),
            Some('.') | Some('?') | Some('!')
        )
    };
    let shape = |a: usize, z: usize| {
        let k = (z - a) as f64;
        let secs = (words[z - 1].end - words[a].start).max(0.2);
        WORDS_WEIGHT * (k / TARGET_WORDS).ln().powi(2) * k + SECONDS_WEIGHT * (secs / TARGET_SECONDS).ln().powi(2)
    };
    let reward = |a: usize| {
        if a == 0 {
            return 0.0;
        }
        GAP_WEIGHT * gap(a).min(GAP_CAP_S).sqrt() + if punct(a) { PUNCT_BONUS } else { 0.0 } - BREAK_COST
    };
    // best[z]: cheapest way to break words[..z]; prev[z]: where its last line starts
    let mut best = vec![f64::INFINITY; n + 1];
    let mut prev = vec![0usize; n + 1];
    best[0] = 0.0;
    for z in 1..=n {
        for a in z.saturating_sub(MAX_LINE_WORDS)..z {
            let c = best[a] + shape(a, z) - reward(a);
            if c < best[z] {
                best[z] = c;
                prev[z] = a;
            }
        }
    }
    let mut breaks = Vec::new();
    let mut z = n;
    while z > 0 {
        let a = prev[z];
        if a > 0 {
            breaks.push(a);
        }
        z = a;
    }
    breaks.reverse();
    breaks
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Words of `dur` seconds separated by `gaps[i]` before word i+1.
    fn timed<'a>(texts: &[&'a str], dur: f64, gaps: &[f64]) -> Vec<Timed<'a>> {
        let mut t = 0.0;
        texts
            .iter()
            .enumerate()
            .map(|(i, &text)| {
                if i > 0 {
                    t += gaps[i - 1];
                }
                let w = Timed { start: t, end: t + dur, text };
                t += dur;
                w
            })
            .collect()
    }

    // Lyric text in these tests is invented (CLAUDE.md: never real lyrics).
    #[test]
    fn breaks_at_the_pauses_between_phrases() {
        let words = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
        let mut gaps = vec![0.05; 11];
        gaps[5] = 0.9; // pause before "seven"
        let w = timed(&words, 0.3, &gaps);
        assert_eq!(break_lines(&w), vec![6]);
    }

    #[test]
    fn a_long_unbroken_run_still_splits_near_line_length() {
        let words: Vec<String> = (0..28).map(|i| format!("w{i}")).collect();
        let refs: Vec<&str> = words.iter().map(String::as_str).collect();
        let w = timed(&refs, 0.35, &vec![0.08; 27]);
        let b = break_lines(&w);
        assert!(!b.is_empty(), "28 words is several lines");
        let mut edges = vec![0];
        edges.extend(&b);
        edges.push(28);
        for pair in edges.windows(2) {
            let k = pair[1] - pair[0];
            assert!((4..=12).contains(&k), "line of {k} words: {b:?}");
        }
    }

    #[test]
    fn a_short_chunk_stays_one_line() {
        let w = timed(&["short", "little", "line", "here"], 0.3, &[0.1, 0.1, 0.1]);
        assert!(break_lines(&w).is_empty());
    }

    #[test]
    fn sentence_punctuation_tips_a_close_call() {
        // Two equal small gaps; the one after "done." wins.
        let words = ["we", "walked", "along", "the", "road", "until", "done.", "then", "we", "sat", "down", "together"];
        let mut gaps = vec![0.05; 11];
        gaps[3] = 0.3; // before "road"
        gaps[6] = 0.3; // before "then"
        let w = timed(&words, 0.3, &gaps);
        assert_eq!(break_lines(&w), vec![7]);
    }

    #[test]
    fn zero_length_placeholder_words_are_harmless() {
        let mut w = timed(&["a", "b", "c", "d", "e", "f", "g", "h"], 0.3, &[0.1; 7]);
        w[3].end = w[3].start; // an unalignable word
        let _ = break_lines(&w);
        assert!(break_lines(&[]).is_empty());
        assert!(break_lines(&w[..1]).is_empty());
    }
}
