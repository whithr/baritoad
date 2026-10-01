//! Song facts computed from the timing map — local, measured from our own
//! word timings, never looked up. They feed the Library's "Singability"
//! shelves (easy sing-alongs, fast lyrics).

use crate::timing::WordTimingMap;

/// Bump when [`singing_pace`] (or any fact the library backfills) changes,
/// so existing songs are recomputed ([`super::backfill_meta`]).
pub const META_VERSION: i64 = 1;

/// Words per minute *while singing*: sung words over the summed spans of
/// the lyric lines (first word's start to last word's end), so long
/// instrumental breaks don't make a fast song look slow. Words marked unsung
/// (approximate timing) are left out. `None` when there's too little to go
/// on (fewer than 10 words or under 5 s of singing).
pub fn singing_pace(map: &WordTimingMap) -> Option<f64> {
    let words: Vec<_> = map.words.iter().filter(|w| !w.unsung).collect();
    if words.len() < 10 {
        return None;
    }
    // Lines by lyric line id; words without one split on pauses over 2 s.
    let mut spans: Vec<(f64, f64)> = Vec::new();
    let mut prev: Option<(Option<usize>, f64)> = None;
    for w in &words {
        let end = w.end.max(w.start);
        let same_line = match prev {
            Some((line, prev_end)) => match (line, w.line) {
                (Some(a), Some(b)) => a == b,
                _ => w.start - prev_end <= 2.0,
            },
            None => false,
        };
        if same_line {
            if let Some(last) = spans.last_mut() {
                last.1 = last.1.max(end);
            }
        } else {
            spans.push((w.start, end));
        }
        prev = Some((w.line, end));
    }
    let singing_s: f64 = spans.iter().map(|(a, b)| (b - a).max(0.0)).sum();
    (singing_s >= 5.0).then(|| words.len() as f64 / (singing_s / 60.0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::timing::WordTiming;

    fn word(line: Option<usize>, start: f64, end: f64) -> WordTiming {
        WordTiming {
            word: "la".into(),
            start,
            end,
            confidence: 1.0,
            anchored: false,
            unsung: false,
            line,
            word_in_line: None,
            ad_lib: false,
        }
    }

    #[test]
    fn pace_counts_only_time_spent_singing() {
        // Two lines of 6 words, 0.5 s apart each, a minute of silence between.
        let mut words = Vec::new();
        for (line, t0) in [(0usize, 10.0), (1, 70.0)] {
            for k in 0..6 {
                let s = t0 + k as f64 * 0.5;
                words.push(word(Some(line), s, s + 0.4));
            }
        }
        let map = WordTimingMap::new(120.0, words, vec![]);
        // 12 words over 2 × 2.9 s of singing = 124 words/min.
        let pace = singing_pace(&map).unwrap();
        assert!((pace - 12.0 / (5.8 / 60.0)).abs() < 1e-6, "{pace}");
    }

    #[test]
    fn unlined_words_split_on_pauses() {
        let mut words = Vec::new();
        for k in 0..10 {
            words.push(word(None, k as f64 * 0.6, k as f64 * 0.6 + 0.5));
        }
        for k in 0..10 {
            let s = 30.0 + k as f64 * 0.6;
            words.push(word(None, s, s + 0.5));
        }
        let pace = singing_pace(&WordTimingMap::new(60.0, words, vec![])).unwrap();
        assert!((pace - 20.0 / (2.0 * 5.9 / 60.0)).abs() < 1e-6, "{pace}");
    }

    #[test]
    fn too_little_singing_has_no_pace() {
        let words = (0..5).map(|k| word(Some(0), k as f64, k as f64 + 0.5)).collect();
        assert_eq!(singing_pace(&WordTimingMap::new(10.0, words, vec![])), None);
    }
}
