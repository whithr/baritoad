//! ASS subtitle export (PLAN.md §3): one Dialogue event per lyric line with
//! standard `\k` centisecond karaoke tags — the classic karaoke effect that
//! VLC, mpv and Aegisub (all libass-based) play out of the box.
//!
//! Layout decisions:
//! - PlayRes 1280x720 with a bold 64 px default style, bottom-center, thick
//!   outline — TV-friendly at couch distance.
//! - `Karaoke` style for lyric lines; `AdLib` (smaller, italic) for lines
//!   that are entirely flagged ad-libs; ad-lib words *inside* a mixed line
//!   are italicized inline instead of restyled (one line = one event).
//! - Karaoke sweep: text starts in `SecondaryColour` (white) and fills to
//!   `PrimaryColour` (gold) as each word's `\k` duration elapses.
//! - Gap handling: each line gets up to [`LEAD_IN_CS`] of lead-in (clamped
//!   so events never overlap the previous line; genuinely overlapping lines
//!   keep their true start). The lead-in and any silence *between* words are
//!   emitted as text-less `{\k}` filler blocks, so a word is highlighted for
//!   exactly its sung duration — the sweep never smears across a rest.
//! - Unsung spans (PLAN.md §3 honesty rule): lines whose words are all
//!   inside unsung spans produce **no Dialogue event** — their timing is
//!   approximate and a karaoke sweep would be a lie. Words are dropped only
//!   with the whole line; mixed lines keep their flagged words.
//! - Escaping: `{` and `}` are written as `\{` / `\}` (libass literal-brace
//!   escapes) so lyric text can never open an override block.
//!
//! Rounding (centiseconds, ties-to-even) and time base: [module docs](super).

use crate::timing::WordTimingMap;

use super::{export_lines, to_cs, ExportMeta};

/// Maximum lead-in before a line's first word, centiseconds.
pub const LEAD_IN_CS: i64 = 50;

/// `H:MM:SS.CC` (ASS timestamp shape).
fn ts(cs: i64) -> String {
    format!(
        "{}:{:02}:{:02}.{:02}",
        cs / 360_000,
        (cs / 6000) % 60,
        (cs / 100) % 60,
        cs % 100
    )
}

/// Literal-brace escapes understood by libass.
fn esc(text: &str) -> String {
    text.replace('{', "\\{").replace('}', "\\}")
}

/// Render the map as an ASS document (UTF-8, LF line endings, deterministic).
pub fn export(map: &WordTimingMap, meta: &ExportMeta) -> String {
    let title = meta.title.as_deref().unwrap_or("Karaoke export");
    let mut out = String::new();
    out.push_str("[Script Info]\n");
    out.push_str("; Karaoke export — timings are original-song time (PLAN.md \u{a7}5);\n");
    out.push_str("; play against the original audio file, not a tempo-shifted render.\n");
    out.push_str(&format!("Title: {title}\n"));
    if let Some(artist) = &meta.artist {
        out.push_str(&format!("; Artist: {artist}\n"));
    }
    out.push_str("ScriptType: v4.00+\n");
    out.push_str("PlayResX: 1280\nPlayResY: 720\n");
    out.push_str("WrapStyle: 0\nScaledBorderAndShadow: yes\nYCbCr Matrix: TV.709\n");
    out.push('\n');
    out.push_str("[V4+ Styles]\n");
    out.push_str(
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, \
         BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, \
         BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n",
    );
    // Primary = sung fill (gold), Secondary = not-yet-sung (white).
    out.push_str(
        "Style: Karaoke,Arial,64,&H0000D7FF,&H00FFFFFF,&H00101010,&H80000000,\
         -1,0,0,0,100,100,0,0,1,3,1,2,60,60,40,1\n",
    );
    out.push_str(
        "Style: AdLib,Arial,44,&H0000D7FF,&H00DDDDDD,&H00101010,&H80000000,\
         0,-1,0,0,100,100,0,0,1,2,1,2,60,60,120,1\n",
    );
    out.push('\n');
    out.push_str("[Events]\n");
    out.push_str("Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n");

    let mut prev_end_cs = 0i64;
    for line in export_lines(map) {
        if line.all_unsung() {
            continue; // unsung span: no lyric event (module docs)
        }
        // word boundaries in cs, forced monotonic after rounding
        let n = line.words.len();
        let mut starts = Vec::with_capacity(n);
        let mut ends = Vec::with_capacity(n);
        let mut cursor = 0i64;
        for w in &line.words {
            let s = to_cs(w.start).max(cursor);
            let e = to_cs(w.end).max(s);
            starts.push(s);
            ends.push(e);
            cursor = s; // onsets are monotonic; ends may overlap the next onset
        }
        // clip each word's highlight at the next word's onset
        for i in 0..n - 1 {
            ends[i] = ends[i].min(starts[i + 1]);
        }
        let first_cs = starts[0];
        let last_cs = ends[n - 1];
        if last_cs <= first_cs {
            continue; // zero-length line (all-unalignable words): nothing to sweep
        }
        // lead-in, clamped so events never overlap; true line overlaps kept
        let start_cs = if prev_end_cs <= first_cs {
            (first_cs - LEAD_IN_CS).max(prev_end_cs)
        } else {
            first_cs
        };
        let all_ad_lib = line.all_ad_lib();
        let style = if all_ad_lib { "AdLib" } else { "Karaoke" };

        let mut text = String::new();
        if first_cs > start_cs {
            text.push_str(&format!("{{\\k{}}}", first_cs - start_cs)); // lead-in filler
        }
        for i in 0..n {
            let k = ends[i] - starts[i];
            let w = line.words[i];
            let word = esc(&w.word);
            if w.ad_lib && !all_ad_lib {
                text.push_str(&format!("{{\\k{k}\\i1}}{word}{{\\i0}}"));
            } else {
                text.push_str(&format!("{{\\k{k}}}{word}"));
            }
            if i + 1 < n {
                let gap = starts[i + 1] - ends[i];
                if gap > 0 {
                    text.push_str(&format!("{{\\k{gap}}} ")); // rest: space sweeps alone
                } else {
                    text.push(' ');
                }
            }
        }
        out.push_str(&format!(
            "Dialogue: 0,{},{},{style},,0,0,0,,{}\n",
            ts(start_cs),
            ts(last_cs),
            text
        ));
        prev_end_cs = last_cs.max(prev_end_cs);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::super::testutil::word;
    use super::*;
    use crate::timing::{UnsungSpan, WordTimingMap};

    #[test]
    fn timestamp_format() {
        assert_eq!(ts(0), "0:00:00.00");
        assert_eq!(ts(366_199), "1:01:01.99");
    }

    #[test]
    fn braces_are_escaped() {
        assert_eq!(esc("a{b}c"), "a\\{b\\}c");
    }

    #[test]
    fn k_tags_sum_to_event_duration() {
        let map = WordTimingMap::new(
            10.0,
            vec![word("hey", 1.0, 1.4), word("you", 1.8, 2.5)],
            vec![],
        );
        let ass = export(&map, &ExportMeta::default());
        let dialogue = ass.lines().find(|l| l.starts_with("Dialogue:")).unwrap();
        // start 0.50 (0.5 s lead-in), end 2.50; \k tags: 50 lead + 40 hey
        // + 40 rest + 70 you = 200 cs = event duration
        assert!(dialogue.contains("0:00:00.50,0:00:02.50"), "{dialogue}");
        assert!(
            dialogue.contains("{\\k50}{\\k40}hey{\\k40} {\\k70}you"),
            "{dialogue}"
        );
    }

    #[test]
    fn fully_unsung_line_emits_no_event() {
        let mut a = word("ghost", 3.0, 3.5);
        a.unsung = true;
        a.line = Some(0);
        let mut b = word("real", 8.0, 8.5);
        b.line = Some(1);
        let map = WordTimingMap::new(
            10.0,
            vec![a, b],
            vec![UnsungSpan {
                first_word: 0,
                last_word: 0,
                start: 3.0,
                end: 3.5,
            }],
        );
        let ass = export(&map, &ExportMeta::default());
        let events: Vec<&str> = ass.lines().filter(|l| l.starts_with("Dialogue:")).collect();
        assert_eq!(events.len(), 1);
        assert!(events[0].contains("real") && !events[0].contains("ghost"));
    }

    #[test]
    fn whole_adlib_line_uses_adlib_style_and_inline_adlib_italicizes() {
        let mut woo = word("(woo)", 1.0, 1.5);
        woo.ad_lib = true;
        woo.line = Some(0);
        let mut hey = word("hey", 3.0, 3.4);
        hey.line = Some(1);
        let mut oh = word("(oh)", 3.5, 3.9);
        oh.ad_lib = true;
        oh.line = Some(1);
        let map = WordTimingMap::new(10.0, vec![woo, hey, oh], vec![]);
        let ass = export(&map, &ExportMeta::default());
        let events: Vec<&str> = ass.lines().filter(|l| l.starts_with("Dialogue:")).collect();
        assert!(events[0].contains(",AdLib,"), "{}", events[0]);
        assert!(events[1].contains(",Karaoke,"), "{}", events[1]);
        assert!(events[1].contains("\\i1}(oh){\\i0}"), "{}", events[1]);
    }

    #[test]
    fn lead_in_never_overlaps_previous_event() {
        let mut a = word("one", 1.0, 2.0);
        a.line = Some(0);
        let mut b = word("two", 2.2, 3.0); // only 0.2 s after previous end
        b.line = Some(1);
        let map = WordTimingMap::new(10.0, vec![a, b], vec![]);
        let ass = export(&map, &ExportMeta::default());
        let events: Vec<&str> = ass.lines().filter(|l| l.starts_with("Dialogue:")).collect();
        // second event starts at the previous end (2.00), lead-in clamped to 20 cs
        assert!(events[1].contains("0:00:02.00,0:00:03.00"), "{}", events[1]);
        assert!(events[1].contains("{\\k20}{\\k80}two"), "{}", events[1]);
    }
}
