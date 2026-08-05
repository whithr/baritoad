//! UltraStar .txt export (PLAN.md §3: timings; melody notes are passed
//! through only if *imported* — we never invent them).
//!
//! Format conventions (file-format interop only — no UltraStar Deluxe code
//! is used or ported; the format itself is not copyrightable, PLAN.md §6):
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
//!   v2 (PLAN.md §3) — and 0 is the least-surprising placeholder for players
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

use crate::timing::WordTimingMap;

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
    out.push_str("#LANGUAGE:English\n"); // v1 is English-first (PLAN.md §1)
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
}
