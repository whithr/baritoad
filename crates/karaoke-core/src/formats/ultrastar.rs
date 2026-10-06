//! UltraStar .txt export **and import** (timings; melody notes
//! are passed through only if *imported* — we never invent them).
//!
//! Format conventions (file-format interop only — no UltraStar Deluxe code
//! is used or ported; the format itself is not copyrightable):
//!
//! - **BPM**: UltraStar's `#BPM` is a resolution constant, not the song's
//!   real tempo — players tick at `4 × BPM / 60` beats per second and
//!   community files conventionally use an inflated "quarter BPM" for note
//!   resolution. We write a **fixed `#BPM:300`** → 20 beats/s → 50 ms per
//!   beat, comfortably under the ~100 ms word-onset accuracy target, and an
//!   integer, which sidesteps the format's historical decimal-comma
//!   ambiguity. ([`BEAT_MS`] documents the math.)
//! - **GAP**: `#GAP` is the offset of beat 0 in **milliseconds**; we set it
//!   to the first word's onset, so the first note starts at beat 0.
//! - **Pitch 0 convention**: every exported note carries pitch `0` (C4 in
//!   UltraStar's relative scale). v1 has no melody data — pitch detection is
//!   v2 — and 0 is the least-surprising placeholder for players
//!   that render a note lane. When UltraStar import lands beside this
//!   exporter, imported melodies will round-trip through the timing map and
//!   replace the 0s.
//! - **Note types**: `:` (normal) for sung words; `F` (freestyle — shown,
//!   never pitch/timing scored) for unsung-span words and flagged ad-libs,
//!   so downstream scoring apps don't grade anyone against timings the
//!   aligner marked approximate or decorative.
//! - Note lines are `: <start-beat> <length> <pitch> <text>`, line breaks
//!   are `- <beat>`, terminated by `E`. Note text keeps lyric words
//!   verbatim; a trailing space separates words within a line (UltraStar
//!   concatenates note texts when rendering).
//! - Beats round ties-to-even like everything in this module; lengths are
//!   at least 1 beat and starts are clamped monotonic so no note overlaps
//!   the previous one.
//!
//! Time base: original-song time, verbatim ([module docs](super)).
//!
//! ## Import ([`import`])
//!
//! Reads community and hand-made files back into structure: headers, notes
//! (`:` normal, `*` golden, `F` freestyle, `R`/`G` rap), line breaks, `E`
//! terminator. Pitch data is **preserved in the parsed struct but unused**
//! in v1 (melody is v2); [`UltraStarSong::words`] merges
//! syllable notes into words by the whitespace convention (a note whose text
//! starts with a space — or follows one ending with a space — begins a new
//! word), and [`UltraStarSong::to_timing_map`] produces a playable
//! [`WordTimingMap`] for the app-phase import path. `#BPM` decimal commas
//! and `#RELATIVE:YES` beat offsets are handled. Duet files (`P1`/`P2`) are
//! rejected explicitly — grading or playing a duet as one voice would be
//! silently wrong.

use crate::error::{Error, Result};
use crate::timing::{WordTiming, WordTimingMap};

use super::{div_round_half_even, export_lines, to_ms, ExportMeta};

/// Fixed `#BPM` we export (see module docs).
pub const BPM: i64 = 300;

/// Milliseconds per UltraStar beat at [`BPM`]: 60_000 / (4 × 300) = 50.
pub const BEAT_MS: i64 = 60_000 / (4 * BPM);

/// Render the map as an UltraStar .txt (UTF-8, LF line endings,
/// deterministic). Header fields default honestly: `#TITLE`/`#ARTIST` fall
/// back to "Unknown", `#MP3` is written only when an audio name is known.
pub fn export(map: &WordTimingMap, meta: &ExportMeta) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "#TITLE:{}\n",
        meta.title.as_deref().unwrap_or("Unknown")
    ));
    out.push_str(&format!(
        "#ARTIST:{}\n",
        meta.artist.as_deref().unwrap_or("Unknown")
    ));
    if let Some(mp3) = &meta.audio_name {
        out.push_str(&format!("#MP3:{mp3}\n"));
    }
    out.push_str("#LANGUAGE:English\n"); // v1 is English-first
    out.push_str(&format!("#BPM:{BPM}\n"));

    let lines = export_lines(map);
    let gap_ms = lines
        .first()
        .map(|l| to_ms(l.start).max(0))
        .unwrap_or(0);
    out.push_str(&format!("#GAP:{gap_ms}\n"));

    let beat = |t: f64| div_round_half_even(to_ms(t) - gap_ms, BEAT_MS);

    let mut prev_end_beat = 0i64;
    for (li, line) in lines.iter().enumerate() {
        if li > 0 {
            // line break sits at the next line's start, never before the
            // previous line's last note ends
            out.push_str(&format!("- {}\n", beat(line.start).max(prev_end_beat)));
        }
        let n = line.words.len();
        for (wi, w) in line.words.iter().enumerate() {
            let start = beat(w.start).max(prev_end_beat);
            let len = (beat(w.end) - start).max(1); // notes are ≥ 1 beat
            let kind = if w.unsung || w.ad_lib { 'F' } else { ':' };
            let sep = if wi + 1 < n { " " } else { "" };
            out.push_str(&format!("{kind} {start} {len} 0 {}{sep}\n", w.word));
            prev_end_beat = start + len;
        }
    }
    out.push_str("E\n");
    out
}

// ---------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------

/// UltraStar note kinds. Rap kinds are parsed (community files use them) and
/// treated like their sung/freestyle counterparts downstream.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NoteKind {
    Normal,
    Golden,
    Freestyle,
    Rap,
    RapGolden,
}

impl NoteKind {
    /// Freestyle notes are shown but never timing/pitch scored — our exporter
    /// writes unsung/ad-lib words as freestyle for exactly that reason.
    pub fn is_freestyle(self) -> bool {
        self == NoteKind::Freestyle
    }
}

/// One parsed note. Beats are **absolute** (relative-mode offsets are already
/// applied); pitch is UltraStar's relative scale, preserved untouched.
#[derive(Debug, Clone)]
pub struct Note {
    pub kind: NoteKind,
    pub start_beat: i64,
    pub len_beats: i64,
    pub pitch: i32,
    /// Verbatim note text including any leading/trailing spaces — the spaces
    /// are the format's word-separator signal.
    pub text: String,
}

/// Notes between two line breaks.
#[derive(Debug, Clone, Default)]
pub struct UsLine {
    pub notes: Vec<Note>,
}

/// A parsed UltraStar file.
#[derive(Debug, Clone)]
pub struct UltraStarSong {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub mp3: Option<String>,
    pub language: Option<String>,
    /// The format's resolution constant (see export module docs), decimal
    /// comma tolerated.
    pub bpm: f64,
    /// Offset of beat 0 in milliseconds.
    pub gap_ms: f64,
    pub relative: bool,
    pub lines: Vec<UsLine>,
    /// Every header verbatim (key uppercased, value trimmed) — nothing is
    /// dropped on import, so unknown tags survive a future re-export.
    pub headers: Vec<(String, String)>,
}

/// One display word after syllable merging, in original-song seconds.
#[derive(Debug, Clone)]
pub struct ImportedWord {
    pub text: String,
    pub start: f64,
    /// End of the last merged note (start + length beats).
    pub end: f64,
    /// Index of the [`UsLine`] the word sits on.
    pub line: usize,
    /// True when every merged note is freestyle (timing not gradable).
    pub freestyle: bool,
    /// True when any merged note is golden.
    pub golden: bool,
    /// Pitches of the merged notes, preserved in order (unused in v1).
    pub pitches: Vec<i32>,
}

impl UltraStarSong {
    /// Beat → original-song seconds: `GAP/1000 + beat · 60 / (4 · BPM)`.
    pub fn beat_to_seconds(&self, beat: i64) -> f64 {
        self.gap_ms / 1000.0 + beat as f64 * 60.0 / (4.0 * self.bpm)
    }

    /// Merge syllable notes into words (module docs: whitespace convention).
    pub fn words(&self) -> Vec<ImportedWord> {
        let mut out: Vec<ImportedWord> = Vec::new();
        for (li, line) in self.lines.iter().enumerate() {
            let mut prev_ends_space = true; // first note of a line starts a word
            for n in &line.notes {
                let starts_word = prev_ends_space
                    || n.text.starts_with(|c: char| c.is_whitespace());
                let trimmed = n.text.trim();
                if starts_word || out.last().map(|w| w.line) != Some(li) {
                    out.push(ImportedWord {
                        text: trimmed.to_string(),
                        start: self.beat_to_seconds(n.start_beat),
                        end: self.beat_to_seconds(n.start_beat + n.len_beats),
                        line: li,
                        freestyle: n.kind.is_freestyle(),
                        golden: matches!(n.kind, NoteKind::Golden | NoteKind::RapGolden),
                        pitches: vec![n.pitch],
                    });
                } else {
                    let w = out.last_mut().expect("word exists on this line");
                    w.text.push_str(trimmed);
                    w.end = self.beat_to_seconds(n.start_beat + n.len_beats);
                    w.freestyle &= n.kind.is_freestyle();
                    w.golden |= matches!(n.kind, NoteKind::Golden | NoteKind::RapGolden);
                    w.pitches.push(n.pitch);
                }
                prev_ends_space = n.text.ends_with(|c: char| c.is_whitespace());
            }
        }
        out
    }

    /// Convert to a playable timing map (import: lyrics + timings
    /// used for playback). Freestyle words become unsung (approximate
    /// timing); pitch data stays behind in the parsed struct — the map has no
    /// melody in v1.
    pub fn to_timing_map(&self) -> WordTimingMap {
        let words = self.words();
        let duration = words.iter().fold(0.0f64, |d, w| d.max(w.end));
        let mut line_word = std::collections::HashMap::new();
        let timings = words
            .iter()
            .map(|w| {
                let wi = line_word.entry(w.line).or_insert(0usize);
                let t = WordTiming {
                    word: w.text.clone(),
                    start: w.start,
                    end: w.end,
                    confidence: 1.0, // human-timed file: trusted
                    anchored: true,
                    unsung: w.freestyle,
                    line: Some(w.line),
                    word_in_line: Some(*wi),
                    ad_lib: false,
                };
                *wi += 1;
                t
            })
            .collect();
        WordTimingMap::new(duration, timings, vec![])
    }
}

/// Parse an UltraStar .txt. Tolerates BOM, CRLF, decimal-comma numbers, and
/// `#RELATIVE:YES`; rejects duet files and structurally broken note lines
/// with the offending line number.
pub fn import(text: &str) -> Result<UltraStarSong> {
    let text = text.trim_start_matches('\u{feff}');
    let mut headers: Vec<(String, String)> = Vec::new();
    let mut lines: Vec<UsLine> = vec![UsLine::default()];
    let mut rel_offset: i64 = 0;
    let mut seen_end = false;

    let bad = |n: usize, m: &str| Error::InvalidInput(format!("ultrastar line {n}: {m}"));

    for (idx, raw) in text.split('\n').enumerate() {
        let n = idx + 1;
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if line.trim().is_empty() {
            continue;
        }
        if seen_end {
            continue; // anything after E is ignored (community files do this)
        }
        let first = line.chars().next().expect("non-empty");
        match first {
            '#' => {
                let body = &line[1..];
                let (k, v) = body
                    .split_once(':')
                    .ok_or_else(|| bad(n, "header without ':'"))?;
                headers.push((k.trim().to_uppercase(), v.trim().to_string()));
            }
            ':' | '*' | 'F' | 'R' | 'G' => {
                // guard: "F"/"R"/"G" must be a lone tag char, not a lyric word
                if line.len() > 1 && !line[1..].starts_with([' ', '\t']) {
                    return Err(bad(n, "unrecognized line (note tag not followed by space)"));
                }
                let kind = match first {
                    ':' => NoteKind::Normal,
                    '*' => NoteKind::Golden,
                    'F' => NoteKind::Freestyle,
                    'R' => NoteKind::Rap,
                    _ => NoteKind::RapGolden,
                };
                let (start, len, pitch, text) = parse_note_body(&line[1..])
                    .ok_or_else(|| bad(n, "malformed note (want: start len pitch text)"))?;
                lines
                    .last_mut()
                    .expect("at least one line")
                    .notes
                    .push(Note {
                        kind,
                        start_beat: start + rel_offset,
                        len_beats: len,
                        pitch,
                        text,
                    });
            }
            '-' => {
                let nums: Vec<i64> = line[1..]
                    .split_whitespace()
                    .map(|t| t.parse::<i64>())
                    .collect::<std::result::Result<_, _>>()
                    .map_err(|_| bad(n, "malformed line break"))?;
                if is_yes(&headers, "RELATIVE") {
                    // relative mode: the (last) number advances the beat offset
                    let adv = *nums.last().ok_or_else(|| bad(n, "relative line break needs an offset"))?;
                    rel_offset += adv;
                }
                lines.push(UsLine::default());
            }
            'E' if line.trim() == "E" => {
                seen_end = true;
            }
            'P' => {
                return Err(bad(
                    n,
                    "duet file (P1/P2 voices) — duet import is not supported in v1",
                ));
            }
            _ => return Err(bad(n, "unrecognized line")),
        }
    }

    let get = |key: &str| {
        headers
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.clone())
    };
    let bpm: f64 = get("BPM")
        .ok_or_else(|| Error::InvalidInput("ultrastar: missing #BPM header".into()))?
        .replace(',', ".")
        .parse()
        .map_err(|_| Error::InvalidInput("ultrastar: unparseable #BPM".into()))?;
    if !(bpm.is_finite() && bpm > 0.0) {
        return Err(Error::InvalidInput(format!("ultrastar: bad #BPM {bpm}")));
    }
    let gap_ms: f64 = match get("GAP") {
        Some(v) => v
            .replace(',', ".")
            .parse()
            .map_err(|_| Error::InvalidInput("ultrastar: unparseable #GAP".into()))?,
        None => 0.0,
    };
    lines.retain(|l| !l.notes.is_empty());
    if lines.is_empty() {
        return Err(Error::InvalidInput("ultrastar: file has no notes".into()));
    }
    Ok(UltraStarSong {
        title: get("TITLE"),
        artist: get("ARTIST"),
        mp3: get("MP3"),
        language: get("LANGUAGE"),
        bpm,
        gap_ms,
        relative: is_yes(&headers, "RELATIVE"),
        lines,
        headers,
    })
}

fn is_yes(headers: &[(String, String)], key: &str) -> bool {
    headers
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.eq_ignore_ascii_case("yes") || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

/// Parse `  start len pitch text…` — three integer fields, then the text,
/// verbatim after exactly one separating space (further spaces belong to the
/// text: they are the word-separator convention).
fn parse_note_body(rest: &str) -> Option<(i64, i64, i32, String)> {
    fn next_token<'a>(s: &'a str, pos: &mut usize) -> Option<&'a str> {
        let tail = &s[*pos..];
        let start = tail.find(|c: char| !c.is_whitespace())?;
        let end = tail[start..]
            .find(char::is_whitespace)
            .map(|e| start + e)
            .unwrap_or(tail.len());
        let tok = &tail[start..end];
        *pos += end;
        Some(tok)
    }
    let mut pos = 0usize;
    let start: i64 = next_token(rest, &mut pos)?.parse().ok()?;
    let len: i64 = next_token(rest, &mut pos)?.parse().ok()?;
    let pitch: i32 = next_token(rest, &mut pos)?.parse().ok()?;
    let mut text = &rest[pos..];
    if let Some(stripped) = text.strip_prefix(' ') {
        text = stripped;
    }
    if text.trim().is_empty() {
        return None; // a note with no text is not a note
    }
    if len < 0 {
        return None;
    }
    Some((start, len, pitch, text.to_string()))
}

#[cfg(test)]
mod tests {
    use super::super::testutil::word;
    use super::*;
    use crate::timing::WordTimingMap;

    #[test]
    fn beat_resolution_is_50ms() {
        assert_eq!(BEAT_MS, 50);
    }

    #[test]
    fn gap_is_first_onset_and_first_note_is_beat_zero() {
        let map = WordTimingMap::new(
            10.0,
            vec![word("dawn", 2.345, 2.8), word("light", 3.0, 3.5)],
            vec![],
        );
        let txt = export(&map, &ExportMeta::default());
        assert!(txt.contains("#GAP:2345\n"), "{txt}");
        // dawn: beat 0, len round((2800-2345)/50)=9; light: start
        // round(655/50)=13, len round(1155/50)-13 = 23-13 = 10
        assert!(txt.contains(": 0 9 0 dawn \n"), "{txt}");
        assert!(txt.contains(": 13 10 0 light\n"), "{txt}");
        assert!(txt.trim_end().ends_with('E'), "{txt}");
    }

    #[test]
    fn header_defaults_are_honest() {
        let map = WordTimingMap::new(5.0, vec![word("a", 1.0, 1.2)], vec![]);
        let txt = export(&map, &ExportMeta::default());
        assert!(txt.starts_with("#TITLE:Unknown\n#ARTIST:Unknown\n"));
        assert!(!txt.contains("#MP3:"));
        let named = export(
            &map,
            &ExportMeta {
                title: Some("Glass Rivers".into()),
                artist: Some("Nobody Real".into()),
                audio_name: Some("glass-rivers.mp3".into()),
            },
        );
        assert!(named.contains("#MP3:glass-rivers.mp3\n"));
    }

    #[test]
    fn unsung_and_adlib_words_are_freestyle_notes() {
        let mut ghost = word("ghost", 1.0, 1.4);
        ghost.unsung = true;
        ghost.line = Some(0);
        let mut woo = word("(woo)", 2.0, 2.4);
        woo.ad_lib = true;
        woo.line = Some(0);
        let mut sung = word("sung", 3.0, 3.4);
        sung.line = Some(0);
        let map = WordTimingMap::new(5.0, vec![ghost, woo, sung], vec![]);
        let txt = export(&map, &ExportMeta::default());
        assert!(txt.contains("F 0 8 0 ghost \n"), "{txt}");
        assert!(txt.contains("F 20 8 0 (woo) \n"), "{txt}");
        assert!(txt.contains(": 40 8 0 sung\n"), "{txt}");
    }

    #[test]
    fn notes_never_overlap_and_line_breaks_sit_between_lines() {
        // second word's rounded start would collide with the first's end
        let mut a = word("a", 1.0, 1.29);
        a.line = Some(0);
        let mut b = word("b", 1.26, 1.5);
        b.line = Some(0);
        let mut c = word("c", 4.0, 4.4);
        c.line = Some(1);
        let map = WordTimingMap::new(10.0, vec![a, b, c], vec![]);
        let txt = export(&map, &ExportMeta::default());
        // a: beat 0 len 6; b would start at round(260/50)=5 -> clamped to 6
        assert!(txt.contains(": 0 6 0 a \n"), "{txt}");
        assert!(txt.contains(": 6 4 0 b\n"), "{txt}");
        assert!(txt.contains("- 60\n"), "{txt}"); // break at line 2's start
        assert!(txt.contains(": 60 8 0 c\n"), "{txt}");
    }

    // ------------------------------------------------------------------
    // import
    // ------------------------------------------------------------------

    #[test]
    fn import_reads_headers_notes_and_pitch() {
        let txt = "\u{feff}#TITLE:Glass Rivers\r\n#ARTIST:Nobody Real\r\n#MP3:glass.mp3\r\n#BPM:300\r\n#GAP:2345\r\n: 0 9 5 dawn \r\n: 13 10 -2 light\r\n- 30\r\n* 40 8 12 gold\r\nE\r\n";
        let song = import(txt).unwrap();
        assert_eq!(song.title.as_deref(), Some("Glass Rivers"));
        assert_eq!(song.bpm, 300.0);
        assert_eq!(song.gap_ms, 2345.0);
        assert_eq!(song.lines.len(), 2);
        let n = &song.lines[0].notes[0];
        assert_eq!((n.start_beat, n.len_beats, n.pitch), (0, 9, 5));
        assert_eq!(n.text, "dawn "); // verbatim, trailing space kept
        assert_eq!(song.lines[0].notes[1].pitch, -2); // pitch preserved
        assert_eq!(song.lines[1].notes[0].kind, NoteKind::Golden);

        let words = song.words();
        assert_eq!(words.len(), 3);
        assert_eq!(words[0].text, "dawn");
        assert!((words[0].start - 2.345).abs() < 1e-9); // GAP + beat 0
        assert!((words[0].end - (2.345 + 9.0 * 0.05)).abs() < 1e-9);
        assert_eq!(words[2].line, 1);
        assert!(words[2].golden);
        assert_eq!(words[0].pitches, vec![5]);
    }

    #[test]
    fn import_merges_syllable_notes_into_words() {
        // community convention: syllables of one word carry no separating
        // space; a new word starts after a space
        let txt = "#BPM:300\n#GAP:0\n: 0 2 5 Hel\n: 2 2 7 lo\n: 6 2 5  world\nE\n";
        let song = import(txt).unwrap();
        let words = song.words();
        assert_eq!(words.len(), 2, "{words:?}");
        assert_eq!(words[0].text, "Hello");
        assert_eq!(words[0].pitches, vec![5, 7]); // melody survives the merge
        assert!((words[0].end - 0.2).abs() < 1e-9); // end of "lo"
        assert_eq!(words[1].text, "world");
    }

    #[test]
    fn import_decimal_comma_bpm_and_relative_mode() {
        // relative mode: note beats restart after each break; offset advances
        // by the break's (last) number
        let txt = "#BPM:292,5\n#GAP:1000\n#RELATIVE:yes\n: 0 4 0 one\n- 8 8\n: 0 4 0 two\nE\n";
        let song = import(txt).unwrap();
        assert!((song.bpm - 292.5).abs() < 1e-9);
        assert!(song.relative);
        let words = song.words();
        assert_eq!(words[0].text, "one");
        assert!((words[0].start - 1.0).abs() < 1e-9);
        // second note: absolute beat 8 -> 1.0 + 8 * 60/(4*292.5)
        let beat_s = 60.0 / (4.0 * 292.5);
        assert!((words[1].start - (1.0 + 8.0 * beat_s)).abs() < 1e-9);
    }

    #[test]
    fn import_freestyle_and_rap_kinds() {
        let txt = "#BPM:300\n#GAP:0\nF 0 4 0 ghost \nR 6 4 3 rapline\nE\n";
        let song = import(txt).unwrap();
        let words = song.words();
        assert!(words[0].freestyle);
        assert!(!words[1].freestyle); // rap is timing-gradable
        assert_eq!(song.lines[0].notes[1].kind, NoteKind::Rap);
    }

    #[test]
    fn import_rejects_broken_files_with_line_numbers() {
        assert!(import("#GAP:0\n: 0 2 0 hi\nE\n").is_err(), "missing BPM");
        let e = import("#BPM:300\n: 0 x 0 hi\nE\n").unwrap_err().to_string();
        assert!(e.contains("line 2"), "{e}");
        let e = import("#BPM:300\nP1\n: 0 2 0 hi\nE\n").unwrap_err().to_string();
        assert!(e.contains("duet"), "{e}");
        assert!(import("#BPM:300\nE\n").is_err(), "no notes");
        // a lyric line starting with F must not parse as a freestyle note
        let e = import("#BPM:300\nFreedom is a word\nE\n").unwrap_err().to_string();
        assert!(e.contains("line 2"), "{e}");
    }

    #[test]
    fn export_import_round_trip_stays_within_one_beat() {
        // the harness self-check contract in miniature: re-imported onsets
        // may differ from the map only by beat quantization (≤ 50 ms)
        let mut words_in = vec![
            word("Silver", 2.113, 2.471),
            word("morning", 2.502, 2.988),
            word("carries", 3.100, 3.542),
            word("me", 3.601, 3.850),
        ];
        for (i, w) in words_in.iter_mut().enumerate() {
            w.line = Some(i / 2);
            w.word_in_line = Some(i % 2);
        }
        let map = WordTimingMap::new(10.0, words_in, vec![]);
        let txt = export(&map, &ExportMeta::default());
        let song = import(&txt).unwrap();
        let words = song.words();
        assert_eq!(words.len(), map.words.len());
        for (w, orig) in words.iter().zip(&map.words) {
            assert_eq!(w.text, orig.word);
            assert!(
                (w.start - orig.start).abs() <= BEAT_MS as f64 / 1000.0 + 1e-9,
                "{}: {} vs {}",
                w.text,
                w.start,
                orig.start
            );
        }
        // and the playback path: timing map from import validates
        let back = song.to_timing_map();
        assert!(back.validate().is_empty(), "{:?}", back.validate());
        assert_eq!(back.words[0].line, Some(0));
        assert_eq!(back.words[3].line, Some(1));
    }
}
