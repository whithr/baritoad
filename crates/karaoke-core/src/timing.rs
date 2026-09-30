//! Word-timing map — the alignment stage's output and the player's input.
//!
//! Hard rule (PLAN.md §5): timing maps always store **original-song time**.
//! Nothing in this type knows about tempo stretch; the player clock translates
//! device position through the active stretch ratio at the boundary. Exporters
//! (LRC/ASS/UltraStar) consume this type in a later milestone.

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

/// Serialized format version.
pub const TIMING_MAP_VERSION: u32 = 1;

/// The only time base a timing map may carry (PLAN.md §5).
pub const TIME_BASE_ORIGINAL_SONG: &str = "original-song";

/// One word of the user's lyrics with its timing in original-song seconds.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WordTiming {
    /// Display text exactly as the user pasted it (case/punctuation intact).
    pub word: String,
    /// Onset, original-song seconds.
    pub start: f64,
    /// End (exclusive), original-song seconds.
    pub end: f64,
    /// CTC path confidence in [0, 1] (exp of mean frame log-prob).
    pub confidence: f32,
    /// True when whisper independently heard this word near this time
    /// (edit-distance anchor agreed with the CTC placement).
    pub anchored: bool,
    /// True when the word sits in a span judged not-sung / unreliable —
    /// the player should treat its timing as approximate, not highlight-exact.
    pub unsung: bool,
    /// Stable link back to the lyric structure (lyric cleanup output —
    /// [`crate::lyrics`]): index of the cleaned lyric line this word belongs
    /// to. Optional so pre-cleanup maps still parse.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<usize>,
    /// Word index within that lyric line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub word_in_line: Option<usize>,
    /// Parenthetical ad-lib (lyric cleanup flagged it; display may style it
    /// differently). Defaults false for maps written before cleanup existed.
    #[serde(default)]
    pub ad_lib: bool,
}

/// Where the lyric words came from (PLAN.md §3): pasted lyrics are the golden
/// path; when none are provided the whisper transcript is the lyric source
/// and the map is marked as such. `Imported` maps came whole — words and
/// hand-made timings — from an UltraStar .txt (no aligner involved).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LyricSource {
    Pasted,
    Transcribed,
    Imported,
}

/// A contiguous run of lyric words the aligner could not place with
/// confidence (typically an instrumental stretch, or pasted lyrics the singer
/// never sang). Made explicit so downstream stages see the problem instead of
/// silently stretched words.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnsungSpan {
    /// Index of the first word of the span in `words`.
    pub first_word: usize,
    /// Index of the last word of the span in `words` (inclusive).
    pub last_word: usize,
    pub start: f64,
    pub end: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WordTimingMap {
    pub version: u32,
    /// Always [`TIME_BASE_ORIGINAL_SONG`]; serialized so a map file is
    /// self-describing about the §5 rule.
    pub time_base: String,
    /// Song duration in seconds (original-song time).
    pub duration: f64,
    /// Where the words came from (absent in maps written before this field
    /// existed; those were all pasted-lyrics maps).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lyric_source: Option<LyricSource>,
    pub words: Vec<WordTiming>,
    pub unsung_spans: Vec<UnsungSpan>,
}

impl WordTimingMap {
    pub fn new(duration: f64, words: Vec<WordTiming>, unsung_spans: Vec<UnsungSpan>) -> Self {
        Self {
            version: TIMING_MAP_VERSION,
            time_base: TIME_BASE_ORIGINAL_SONG.to_string(),
            duration,
            lyric_source: None,
            words,
            unsung_spans,
        }
    }

    pub fn to_json_pretty(&self) -> Result<String> {
        serde_json::to_string_pretty(self).map_err(|e| Error::Encode(format!("timing map: {e}")))
    }

    pub fn from_json(s: &str) -> Result<Self> {
        let map: Self = serde_json::from_str(s)
            .map_err(|e| Error::InvalidInput(format!("timing map parse: {e}")))?;
        if map.time_base != TIME_BASE_ORIGINAL_SONG {
            return Err(Error::InvalidInput(format!(
                "timing map has time_base '{}' — only '{TIME_BASE_ORIGINAL_SONG}' is valid (PLAN.md §5)",
                map.time_base
            )));
        }
        Ok(map)
    }

    /// Persist the map to `path` for the fix editor's Save (PLAN.md §3
    /// review screen): refuses an invalid map ([`Self::validate`] must be
    /// clean), keeps a `.bak` of the previous map beside it (`song.align.json`
    /// → `song.align.json.bak`), then writes atomically (temp file + rename)
    /// so a kill mid-save leaves either the old map or the new one — never a
    /// torn file.
    pub fn save_atomic(&self, path: &std::path::Path) -> Result<()> {
        let violations = self.validate();
        if !violations.is_empty() {
            return Err(Error::InvalidInput(format!(
                "refusing to save invalid timing map: {}",
                violations.join("; ")
            )));
        }
        let json = self.to_json_pretty()?;
        if path.is_file() {
            let mut bak = path.as_os_str().to_owned();
            bak.push(".bak");
            std::fs::copy(path, std::path::PathBuf::from(bak))?;
        }
        crate::pipeline::manifest::write_atomic(path, json.as_bytes())
    }

    /// Shift every word by `offset_s` (e.g. the onset-bias correction),
    /// clamping into `[0, duration]` and preserving monotonic order.
    pub fn shift(&mut self, offset_s: f64) {
        if offset_s == 0.0 {
            return;
        }
        for w in &mut self.words {
            w.start = (w.start + offset_s).clamp(0.0, self.duration);
            w.end = (w.end + offset_s).clamp(w.start, self.duration);
        }
        for s in &mut self.unsung_spans {
            s.start = (s.start + offset_s).clamp(0.0, self.duration);
            s.end = (s.end + offset_s).clamp(s.start, self.duration);
        }
    }

    /// Sanity violations, empty when the map is well formed: word times within
    /// `[0, duration]`, `start <= end`, onsets non-decreasing, spans indexing
    /// real words.
    pub fn validate(&self) -> Vec<String> {
        let mut v = Vec::new();
        let mut prev_start = f64::NEG_INFINITY;
        for (i, w) in self.words.iter().enumerate() {
            if !(w.start.is_finite() && w.end.is_finite()) {
                v.push(format!("word {i} '{}' has non-finite time", w.word));
                continue;
            }
            if w.start < 0.0 || w.end > self.duration + 1e-6 {
                v.push(format!(
                    "word {i} '{}' [{:.3}, {:.3}] outside [0, {:.3}]",
                    w.word, w.start, w.end, self.duration
                ));
            }
            if w.end < w.start {
                v.push(format!("word {i} '{}' end before start", w.word));
            }
            if w.start < prev_start {
                v.push(format!("word {i} '{}' onset not monotonic", w.word));
            }
            prev_start = w.start;
        }
        for (i, s) in self.unsung_spans.iter().enumerate() {
            if s.first_word > s.last_word || s.last_word >= self.words.len() {
                v.push(format!("unsung span {i} has bad word range"));
            }
        }
        // lyric links, when present, must walk forward through the lyric
        // structure (line indices non-decreasing; word index increasing
        // within a line) — the stable map<->lyrics correspondence
        let mut prev: Option<(usize, usize)> = None;
        for (i, w) in self.words.iter().enumerate() {
            if let (Some(line), Some(wi)) = (w.line, w.word_in_line) {
                if let Some((pl, pw)) = prev {
                    if line < pl || (line == pl && wi <= pw) {
                        v.push(format!(
                            "word {i} '{}' lyric link ({line},{wi}) not after ({pl},{pw})",
                            w.word
                        ));
                    }
                }
                prev = Some((line, wi));
            }
        }
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn json_round_trip() {
        let map = WordTimingMap::new(
            10.0,
            vec![word("Hello,", 1.0, 1.4), word("world!", 1.5, 2.0)],
            vec![UnsungSpan {
                first_word: 1,
                last_word: 1,
                start: 1.5,
                end: 2.0,
            }],
        );
        let s = map.to_json_pretty().unwrap();
        let back = WordTimingMap::from_json(&s).unwrap();
        assert_eq!(back.words.len(), 2);
        assert_eq!(back.words[0].word, "Hello,"); // display text preserved
        assert_eq!(back.time_base, TIME_BASE_ORIGINAL_SONG);
        assert!(back.validate().is_empty());
    }

    #[test]
    fn pre_cleanup_map_json_still_parses() {
        // a map serialized before the lyric-link fields existed (no line /
        // word_in_line / ad_lib / lyric_source) must load with defaults
        let s = r#"{
            "version": 1,
            "time_base": "original-song",
            "duration": 5.0,
            "words": [{"word": "hi", "start": 1.0, "end": 1.2,
                       "confidence": 0.8, "anchored": true, "unsung": false}],
            "unsung_spans": []
        }"#;
        let map = WordTimingMap::from_json(s).unwrap();
        assert_eq!(map.words[0].line, None);
        assert_eq!(map.words[0].word_in_line, None);
        assert!(!map.words[0].ad_lib);
        assert_eq!(map.lyric_source, None);
        assert!(map.validate().is_empty());
    }

    #[test]
    fn validate_catches_backwards_lyric_links() {
        let mut a = word("a", 1.0, 1.2);
        a.line = Some(2);
        a.word_in_line = Some(0);
        let mut b = word("b", 1.3, 1.5);
        b.line = Some(1); // walks backwards through the lyrics
        b.word_in_line = Some(0);
        let map = WordTimingMap::new(5.0, vec![a, b], vec![]);
        assert!(map.validate().iter().any(|m| m.contains("lyric link")));
    }

    #[test]
    fn foreign_time_base_rejected() {
        let map = WordTimingMap::new(10.0, vec![], vec![]);
        let s = map.to_json_pretty().unwrap().replace(
            TIME_BASE_ORIGINAL_SONG,
            "player-clock",
        );
        assert!(WordTimingMap::from_json(&s).is_err());
    }

    #[test]
    fn shift_clamps_and_stays_monotonic() {
        let mut map = WordTimingMap::new(
            10.0,
            vec![word("a", 0.02, 0.10), word("b", 0.20, 9.99)],
            vec![],
        );
        map.shift(-0.055);
        assert_eq!(map.words[0].start, 0.0); // clamped at song start
        assert!(map.words[0].end > 0.0);
        assert!((map.words[1].start - 0.145).abs() < 1e-9);
        assert!(map.validate().is_empty());
    }

    #[test]
    fn save_atomic_keeps_bak_of_previous_map_and_rejects_invalid() {
        let dir = std::env::temp_dir().join(format!(
            "karaoke-timing-save-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("song.align.json");

        // first save: no .bak yet (there was no previous map)
        let v1 = WordTimingMap::new(10.0, vec![word("one", 1.0, 1.5)], vec![]);
        v1.save_atomic(&path).unwrap();
        assert!(path.is_file());
        let bak = dir.join("song.align.json.bak");
        assert!(!bak.exists(), "first save must not invent a .bak");
        assert!(!dir.join("song.align.json.tmp").exists(), "no temp residue");

        // second save: previous content lands in .bak
        let mut v2 = v1.clone();
        v2.words[0].start = 2.0;
        v2.words[0].end = 2.5;
        v2.save_atomic(&path).unwrap();
        let cur = WordTimingMap::from_json(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let old = WordTimingMap::from_json(&std::fs::read_to_string(&bak).unwrap()).unwrap();
        assert_eq!(cur.words[0].start, 2.0);
        assert_eq!(old.words[0].start, 1.0, ".bak holds the pre-save map");

        // invalid map: refused, and neither file on disk is touched
        let broken = WordTimingMap::new(10.0, vec![word("bad", 5.0, 4.0)], vec![]);
        assert!(broken.save_atomic(&path).is_err());
        let cur2 = WordTimingMap::from_json(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(cur2.words[0].start, 2.0, "failed save left the map alone");
        let old2 = WordTimingMap::from_json(&std::fs::read_to_string(&bak).unwrap()).unwrap();
        assert_eq!(old2.words[0].start, 1.0, "failed save left the .bak alone");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn validate_catches_violations() {
        let map = WordTimingMap::new(
            5.0,
            vec![word("a", 2.0, 1.0), word("b", 1.0, 6.0)],
            vec![UnsungSpan {
                first_word: 5,
                last_word: 9,
                start: 0.0,
                end: 1.0,
            }],
        );
        let v = map.validate();
        assert!(v.iter().any(|m| m.contains("end before start")));
        assert!(v.iter().any(|m| m.contains("not monotonic")));
        assert!(v.iter().any(|m| m.contains("outside")));
        assert!(v.iter().any(|m| m.contains("bad word range")));
    }
}
