//! Format interop (PLAN.md §3 "Formats & interop").
//!
//! Exporters from the word-timing map to the karaoke interchange formats:
//! Enhanced LRC ([`lrc`]), ASS karaoke subtitles ([`ass`]), UltraStar .txt
//! ([`ultrastar`]). Importers (UltraStar .txt and LRC — PLAN.md §3) are an
//! app-phase milestone and will land *beside* the exporters, one file per
//! format, sharing this module's line/rounding conventions so each format
//! file stays read/write symmetric.
//!
//! ## Time base (PLAN.md §5 — load-bearing)
//!
//! Timing maps store **original-song time**, and the exporters consume that
//! time base verbatim. No tempo/stretch translation happens here — only the
//! player clock translates through stretch ratios, at the device boundary.
//! An exported file therefore matches the original song file, which is
//! exactly what every external player expects.
//!
//! ## Rounding convention (documented, one rule everywhere)
//!
//! LRC and ASS are centisecond formats. Seconds are quantized to whole
//! milliseconds first (nearest), then to centiseconds with **ties-to-even**
//! ("banker's rounding"): x.995 s → (x+1).00, x.985 s → x.98. UltraStar
//! beats use the same ties-to-even rule at beat resolution. One rule keeps
//! output deterministic across platforms and bounds round-trip drift at
//! half the target resolution (≤ 5 ms for cs formats).
//!
//! ## Line structure
//!
//! Exporters are line-oriented. Words carry lyric line links when the map
//! was built from cleaned pasted lyrics ([`crate::lyrics`]), and chunk-lines
//! (one whisper chunk = one line) when it was auto-transcribed — both arrive
//! through the same `line` field. Words with no link at all (hand-written or
//! pre-cleanup maps) fall back to gap grouping: a contiguous unlinked run is
//! one line, split where the inter-word silence reaches
//! [`FALLBACK_LINE_GAP_S`]. The fallback is honest — it never invents
//! structure beyond "a long silence probably separates lines".

pub mod ass;
pub mod lrc;
pub mod ultrastar;

use crate::timing::{WordTiming, WordTimingMap};

/// Silence that splits a run of link-less words into separate fallback lines.
pub const FALLBACK_LINE_GAP_S: f64 = 1.5;

/// The export formats we write (PLAN.md §3; the rendered-video export goes
/// through ffmpeg, not this module).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    /// Enhanced LRC: line tags + per-word `<mm:ss.xx>` tags.
    Lrc,
    /// ASS subtitles with `\k` karaoke tags (VLC / mpv / Aegisub — libass).
    Ass,
    /// UltraStar .txt (timings; pitch 0 — no melody data in v1, PLAN.md §3).
    UltraStar,
}

impl Format {
    /// Conventional file extension (UltraStar uses `.ultrastar.txt` so an
    /// export never clobbers a lyrics `.txt` sitting beside the song).
    pub fn extension(self) -> &'static str {
        match self {
            Format::Lrc => "lrc",
            Format::Ass => "ass",
            Format::UltraStar => "ultrastar.txt",
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Format::Lrc => "lrc",
            Format::Ass => "ass",
            Format::UltraStar => "ultrastar",
        }
    }
}

/// Render `map` in `format` (dispatch over the per-format `export` fns).
pub fn export(map: &WordTimingMap, meta: &ExportMeta, format: Format) -> String {
    match format {
        Format::Lrc => lrc::export(map, meta),
        Format::Ass => ass::export(map, meta),
        Format::UltraStar => ultrastar::export(map, meta),
    }
}

/// Song metadata the formats can carry. Everything is optional; each
/// exporter documents its own defaults for required header fields.
#[derive(Debug, Clone, Default)]
pub struct ExportMeta {
    pub title: Option<String>,
    pub artist: Option<String>,
    /// Audio file name the export should reference (UltraStar `#MP3`).
    pub audio_name: Option<String>,
}

/// One exporter-facing line: a slice of the map's words plus its time span.
#[derive(Debug)]
pub struct ExportLine<'a> {
    pub words: Vec<&'a WordTiming>,
    /// First word onset, original-song seconds.
    pub start: f64,
    /// Latest word end in the line, original-song seconds.
    pub end: f64,
}

impl ExportLine<'_> {
    /// Every word sits in an unsung span — the aligner judged the timing
    /// approximate (instrumental stretch / never sung). ASS emits no lyric
    /// event for such lines.
    pub fn all_unsung(&self) -> bool {
        self.words.iter().all(|w| w.unsung)
    }

    /// Every word is a flagged ad-lib (e.g. a whole-line "(woo)").
    pub fn all_ad_lib(&self) -> bool {
        self.words.iter().all(|w| w.ad_lib)
    }
}

/// Group the map's words into exporter lines (module docs: lyric links when
/// present, chunk-lines for transcribed maps — same field — and gap-split
/// fallback for link-less words). Deterministic: input order is preserved,
/// grouping depends only on the map contents.
pub fn export_lines(map: &WordTimingMap) -> Vec<ExportLine<'_>> {
    let mut lines: Vec<ExportLine<'_>> = Vec::new();
    let mut prev: Option<&WordTiming> = None;
    for w in &map.words {
        let new_line = match prev {
            None => true,
            Some(p) => match (p.line, w.line) {
                // linked words: a line break is a change of lyric line index
                (Some(pl), Some(wl)) => wl != pl,
                // linked <-> unlinked transition always breaks
                (None, Some(_)) | (Some(_), None) => true,
                // fallback: split unlinked runs at long silences
                (None, None) => w.start - p.end >= FALLBACK_LINE_GAP_S,
            },
        };
        if new_line {
            lines.push(ExportLine {
                words: Vec::new(),
                start: w.start,
                end: w.end,
            });
        }
        let line = lines.last_mut().expect("pushed above");
        line.words.push(w);
        line.end = line.end.max(w.end);
        prev = Some(w);
    }
    lines
}

// ---------------------------------------------------------------------------
// rounding (module docs: ms first, then target resolution with ties-to-even)
// ---------------------------------------------------------------------------

/// Seconds → whole milliseconds, nearest (the µs-level tie direction is
/// irrelevant at our accuracy; f64 seconds are not exact decimals anyway).
pub(crate) fn to_ms(t: f64) -> i64 {
    (t * 1000.0).round() as i64
}

/// `n / d` rounded to nearest with **ties-to-even**, for `d > 0`.
pub(crate) fn div_round_half_even(n: i64, d: i64) -> i64 {
    debug_assert!(d > 0);
    let q = n.div_euclid(d);
    let r = n.rem_euclid(d); // 0..d
    match (2 * r).cmp(&d) {
        std::cmp::Ordering::Less => q,
        std::cmp::Ordering::Greater => q + 1,
        std::cmp::Ordering::Equal => q + (q.rem_euclid(2)), // up iff q odd
    }
}

/// Seconds → centiseconds under the module rounding convention, clamped at 0.
pub(crate) fn to_cs(t: f64) -> i64 {
    div_round_half_even(to_ms(t).max(0), 10)
}

/// Test-only word builder shared by the per-format test modules.
#[cfg(test)]
pub(crate) mod testutil {
    use crate::timing::WordTiming;

    pub(crate) fn word(w: &str, start: f64, end: f64) -> WordTiming {
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
}

#[cfg(test)]
mod tests {
    use super::testutil::word;
    use super::*;
    use crate::timing::WordTimingMap;

    #[test]
    fn cs_rounding_is_ties_to_even() {
        assert_eq!(to_cs(1.995), 200); // 199.5 cs, 199 odd -> up
        assert_eq!(to_cs(1.985), 198); // 198.5 cs, 198 even -> down
        assert_eq!(to_cs(1.994), 199);
        assert_eq!(to_cs(1.996), 200);
        assert_eq!(to_cs(0.0), 0);
        assert_eq!(to_cs(-0.3), 0); // clamped
    }

    #[test]
    fn linked_words_group_by_line_index() {
        let mut a = word("a", 1.0, 1.2);
        a.line = Some(0);
        let mut b = word("b", 1.3, 1.5);
        b.line = Some(0);
        let mut c = word("c", 5.0, 5.2);
        c.line = Some(1);
        let map = WordTimingMap::new(10.0, vec![a, b, c], vec![]);
        let lines = export_lines(&map);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].words.len(), 2);
        assert_eq!(lines[0].start, 1.0);
        assert_eq!(lines[0].end, 1.5);
        assert_eq!(lines[1].words.len(), 1);
    }

    #[test]
    fn unlinked_words_split_at_long_gaps_only() {
        let map = WordTimingMap::new(
            20.0,
            vec![
                word("a", 1.0, 1.2),
                word("b", 1.4, 1.6), // 0.2 s gap: same line
                word("c", 4.0, 4.2), // 2.4 s gap: new line
            ],
            vec![],
        );
        let lines = export_lines(&map);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].words.len(), 2);
    }

    #[test]
    fn linked_unlinked_transition_breaks_line() {
        let mut a = word("a", 1.0, 1.2);
        a.line = Some(0);
        let b = word("b", 1.3, 1.5); // no link, hot on a's heels
        let map = WordTimingMap::new(10.0, vec![a, b], vec![]);
        assert_eq!(export_lines(&map).len(), 2);
    }
}
