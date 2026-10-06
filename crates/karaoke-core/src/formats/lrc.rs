//! Enhanced LRC export: line timestamps `[mm:ss.xx]` plus
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
//! Import ([`lyrics_text`]) is words-only for now: a bulk-imported `.lrc`
//! supplies the lyric text and `[ti:]`/`[ar:]` metadata, and the aligner
//! times the words (LRC line times aren't used as anchors yet).
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

/// What an `.lrc` file contributes to an import: its words as plain lyric
/// lines, plus the `[ti:]` / `[ar:]` header values.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LrcLyrics {
    /// One line per lyric line; lines that carried only timestamps (the
    /// instrumental gaps LRC marks with an empty tag) become stanza breaks,
    /// never more than one in a row.
    pub text: String,
    pub title: Option<String>,
    pub artist: Option<String>,
}

/// Strip an (Enhanced) LRC document to plain lyrics: `[mm:ss.xx]` line
/// tags, `<mm:ss.xx>` word tags and ID tags (`[ar:…]`, `[ti:…]`, `[al:…]`,
/// `[by:…]`, `[offset:…]`, …) are removed; the words stay verbatim.
pub fn lyrics_text(lrc: &str) -> LrcLyrics {
    let mut out = LrcLyrics::default();
    let mut lines: Vec<String> = Vec::new();
    for raw in lrc.trim_start_matches('\u{feff}').lines() {
        let mut rest = raw.trim();
        let mut had_time = false;
        // Leading bracket tags: any number of timestamps, or ID tags.
        while let Some(body) = rest.strip_prefix('[') {
            let Some(close) = body.find(']') else { break };
            let tag = &body[..close];
            if is_timestamp(tag) {
                had_time = true;
            } else {
                // "[ar:Name]" is an ID tag; "[Chorus]" / "[Bridge: X]" are
                // lyric content, left for the lyric cleanup pass.
                let Some((key, value)) = tag.split_once(':') else { break };
                let key = key.trim().to_ascii_lowercase();
                if !LRC_ID_TAGS.contains(&key.as_str()) {
                    break;
                }
                let value = value.trim();
                match key.as_str() {
                    "ti" if !value.is_empty() => out.title = Some(value.to_string()),
                    "ar" if !value.is_empty() => out.artist = Some(value.to_string()),
                    _ => {}
                }
            }
            rest = body[close + 1..].trim_start();
        }
        let words = strip_word_tags(rest);
        let words = words.split_whitespace().collect::<Vec<_>>().join(" ");
        if words.is_empty() {
            if had_time && lines.last().is_some_and(|l| !l.is_empty()) {
                lines.push(String::new());
            }
            continue;
        }
        lines.push(words);
    }
    while lines.last().is_some_and(|l| l.is_empty()) {
        lines.pop();
    }
    out.text = lines.join("\n");
    out
}

/// The LRC ID tags a reader skips (a whitelist, so a lowercase
/// `[chorus: …]` header stays lyric text for the cleanup pass).
const LRC_ID_TAGS: &[&str] = &[
    "ar", "al", "ti", "au", "by", "offset", "length", "re", "ve", "tool", "la", "lang", "id", "#",
];

/// `mm:ss`, `mm:ss.xx` or `mm:ss:xx` — digits only around the separators.
fn is_timestamp(tag: &str) -> bool {
    let mut parts = tag.split([':', '.']);
    let (Some(m), Some(sec)) = (parts.next(), parts.next()) else {
        return false;
    };
    let digits = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit());
    digits(m) && digits(sec) && parts.all(digits)
}

/// Remove `<mm:ss.xx>` word tags; any other `<…>` is lyric text.
fn strip_word_tags(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(open) = rest.find('<') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        match after.find('>') {
            Some(close) if is_timestamp(&after[..close]) => {
                out.push(' ');
                rest = &after[close + 1..];
            }
            _ => {
                out.push('<');
                rest = after;
            }
        }
    }
    out.push_str(rest);
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

    #[test]
    fn lyrics_text_strips_every_tag_kind() {
        let lrc = "\u{feff}[ti:Paper Lanterns]\n[ar:The Invented]\n[offset:+120]\n\n\
                   [00:01.00]<00:01.00>hey <00:01.50>you <00:02.00>\n\
                   [00:03.10][01:10.00]second line\n\
                   [00:05.00]\n\
                   [00:06.00]after the gap\n";
        let got = lyrics_text(lrc);
        assert_eq!(got.title.as_deref(), Some("Paper Lanterns"));
        assert_eq!(got.artist.as_deref(), Some("The Invented"));
        assert_eq!(got.text, "hey you\nsecond line\n\nafter the gap");
    }

    #[test]
    fn lyrics_text_keeps_lyric_brackets_and_angles() {
        let got = lyrics_text("[Chorus]\n[00:01.00]a <3 b\n[Bridge: Someone]\n");
        assert_eq!(got.text, "[Chorus]\na <3 b\n[Bridge: Someone]");
    }

    #[test]
    fn exported_lrc_reads_back_as_its_words() {
        let map = WordTimingMap::new(
            10.0,
            vec![word("hey", 1.0, 1.4), word("you", 1.5, 2.0)],
            vec![],
        );
        let meta = ExportMeta {
            title: Some("T".into()),
            artist: Some("A".into()),
            audio_name: None,
        };
        let got = lyrics_text(&export(&map, &meta));
        assert_eq!(got.text, "hey you");
        assert_eq!(got.title.as_deref(), Some("T"));
        assert_eq!(got.artist.as_deref(), Some("A"));
    }
}
