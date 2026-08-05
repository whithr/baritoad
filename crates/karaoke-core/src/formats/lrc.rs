//! Enhanced LRC export (PLAN.md §3): line timestamps `[mm:ss.xx]` plus
//! per-word `<mm:ss.xx>` tags (the "A2" / enhanced-LRC extension understood
//! by Walaoke-style players and most modern LRC consumers).
//!
//! Shape per lyric line:
//!
//! ```text
//! [mm:ss.xx]<mm:ss.xx>word <mm:ss.xx>word ... <mm:ss.xx>
//! ```
//!
//! - the line tag repeats the first word's onset;
//! - each word is preceded by its onset tag;
//! - the trailing tag is the line's end time, so the last word's highlight
//!   duration survives the round trip.
//!
//! LRC has no styling and no escape syntax, so this exporter is
//! data-complete and verbatim: unsung-span words are included (their timing
//! is the map's best estimate — LRC has no way to mark "approximate") and
//! word text is written untouched. Structural characters are positional in
//! LRC — `[` only opens a tag at line start and `<` only opens a tag when it
//! matches `<digits:...>` — so verbatim text is safe for real lyrics; a
//! pathological word that *is* a timestamp-shaped tag would be read back as
//! timing, which we accept rather than altering lyric text.
//!
//! Rounding and time base: see the [module docs](super).

use crate::timing::WordTimingMap;

use super::{export_lines, to_cs, ExportMeta};

/// `[mm:ss.xx]` body (no brackets). Minutes grow past 59 rather than
/// overflowing into an hours field LRC doesn't have.
fn ts(cs: i64) -> String {
    format!("{:02}:{:02}.{:02}", cs / 6000, (cs / 100) % 60, cs % 100)
}

/// Render the map as an Enhanced LRC document (UTF-8, LF line endings,
/// deterministic).
pub fn export(map: &WordTimingMap, meta: &ExportMeta) -> String {
    let mut out = String::new();
    if let Some(t) = &meta.title {
        out.push_str(&format!("[ti:{t}]\n"));
    }
    if let Some(a) = &meta.artist {
        out.push_str(&format!("[ar:{a}]\n"));
    }
    if !out.is_empty() {
        out.push('\n');
    }

    for line in export_lines(map) {
        let line_start_cs = to_cs(line.start);
        let line_end_cs = to_cs(line.end).max(line_start_cs);
        out.push_str(&format!("[{}]", ts(line_start_cs)));
        for w in &line.words {
            out.push_str(&format!("<{}>{} ", ts(to_cs(w.start)), w.word));
        }
        out.push_str(&format!("<{}>\n", ts(line_end_cs)));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::super::testutil::word;
    use super::*;
    use crate::timing::WordTimingMap;

    #[test]
    fn timestamp_format_is_mm_ss_cc() {
        assert_eq!(ts(0), "00:00.00");
        assert_eq!(ts(6199), "01:01.99");
        assert_eq!(ts(600000), "100:00.00"); // minutes grow, no hours field
    }

    #[test]
    fn line_and_word_tags_with_trailing_end() {
        let map = WordTimingMap::new(
            10.0,
            vec![word("hey", 1.0, 1.4), word("you", 1.5, 2.0)],
            vec![],
        );
        let lrc = export(&map, &ExportMeta::default());
        assert_eq!(lrc, "[00:01.00]<00:01.00>hey <00:01.50>you <00:02.00>\n");
    }

    #[test]
    fn header_tags_only_when_present() {
        let map = WordTimingMap::new(5.0, vec![word("a", 1.0, 1.2)], vec![]);
        let plain = export(&map, &ExportMeta::default());
        assert!(!plain.contains("[ti:"));
        let meta = ExportMeta {
            title: Some("Paper Lanterns".into()),
            artist: Some("The Invented".into()),
            audio_name: None,
        };
        let tagged = export(&map, &meta);
        assert!(tagged.starts_with("[ti:Paper Lanterns]\n[ar:The Invented]\n\n"));
    }
}
