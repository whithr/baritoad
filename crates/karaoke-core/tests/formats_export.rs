//! Golden-file and property tests for the export stage (PLAN.md §3
//! "Formats & interop") over a hand-built timing-map fixture.
//!
//! All lyric text is invented — never copied from a real song (CLAUDE.md
//! hard rule). The fixture deliberately covers: lyric-linked lines, ad-lib
//! words (inline and whole-line), a fully unsung span, link-less words (the
//! transcribed-map fallback path, including a gap split), a centisecond
//! rounding edge (x.995 s), and format-special characters.
//!
//! Golden files live in `tests/fixtures/export/`. To regenerate after an
//! intentional format change: `BLESS=1 cargo test -p karaoke-core --test
//! formats_export` — then diff the goldens and commit them with the change.

use karaoke_core::formats::{self, ExportMeta, Format};
use karaoke_core::timing::{UnsungSpan, WordTiming, WordTimingMap};

fn w(
    word: &str,
    start: f64,
    end: f64,
    line: Option<usize>,
    word_in_line: Option<usize>,
    ad_lib: bool,
    unsung: bool,
) -> WordTiming {
    WordTiming {
        word: word.into(),
        start,
        end,
        confidence: 0.9,
        anchored: !unsung,
        unsung,
        line,
        word_in_line,
        ad_lib,
    }
}

/// The shared fixture: 3 lyric-linked lines (one fully unsung) plus a
/// link-less tail that must fall back to gap grouping.
fn fixture_map() -> WordTimingMap {
    let words = vec![
        // line 0 — plain sung line; "run" ends on the x.995 rounding edge
        w("Neon", 5.0, 5.4, Some(0), Some(0), false, false),
        w("rivers", 5.5, 6.0, Some(0), Some(1), false, false),
        w("run", 6.1, 6.995, Some(0), Some(2), false, false),
        // line 1 — special characters + trailing inline ad-lib pair
        w("through", 8.0, 8.3, Some(1), Some(0), false, false),
        w("fire{works}", 8.4, 9.0, Some(1), Some(1), false, false),
        w("(oh,", 9.1, 9.4, Some(1), Some(2), true, false),
        w("yeah!)", 9.45, 9.985, Some(1), Some(3), true, false),
        // line 2 — entirely inside an unsung span (instrumental stretch)
        w("silent", 14.0, 14.5, Some(2), Some(0), false, true),
        w("bridge", 14.6, 15.2, Some(2), Some(1), false, true),
        // link-less words (transcribed-map path): first two are one
        // fallback line, the 2.4 s silence splits off "away"
        w("echo", 20.0, 20.4, None, None, false, false),
        w("fades", 20.5, 21.1, None, None, false, false),
        w("away", 23.5, 24.0, None, None, false, false),
    ];
    let mut map = WordTimingMap::new(
        30.0,
        words,
        vec![UnsungSpan {
            first_word: 7,
            last_word: 8,
            start: 14.0,
            end: 15.2,
        }],
    );
    map.lyric_source = None;
    assert!(map.validate().is_empty(), "fixture must be well formed");
    map
}

fn meta() -> ExportMeta {
    ExportMeta {
        title: Some("Paper Lanterns".into()),
        artist: Some("The Invented".into()),
        audio_name: Some("paper-lanterns.mp3".into()),
    }
}

fn golden_path(name: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/export")
        .join(name)
}

fn check_golden(name: &str, rendered: &str) {
    let path = golden_path(name);
    if std::env::var_os("BLESS").is_some() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, rendered).unwrap();
        return;
    }
    let expected = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("missing golden {} ({e}); run with BLESS=1", path.display()))
        .replace("\r\n", "\n"); // tolerate checkout autocrlf; exporters emit LF
    assert_eq!(
        rendered,
        expected,
        "{name} drifted from its golden file — if intentional, BLESS=1 and review the diff"
    );
}

// ---------------------------------------------------------------------------
// golden files
// ---------------------------------------------------------------------------

#[test]
fn lrc_matches_golden() {
    check_golden(
        "paper-lanterns.lrc",
        &formats::export(&fixture_map(), &meta(), Format::Lrc),
    );
}

#[test]
fn ass_matches_golden() {
    check_golden(
        "paper-lanterns.ass",
        &formats::export(&fixture_map(), &meta(), Format::Ass),
    );
}

#[test]
fn ultrastar_matches_golden() {
    check_golden(
        "paper-lanterns.ultrastar.txt",
        &formats::export(&fixture_map(), &meta(), Format::UltraStar),
    );
}

// ---------------------------------------------------------------------------
// LRC: parse what we emit (also the structural check the e2e sanity reuses)
// ---------------------------------------------------------------------------

/// Minimal Enhanced-LRC reader: returns (line_tag_cs, word_tag_cs list) per
/// lyric line. Strict about the shapes this exporter emits.
fn parse_lrc(text: &str) -> Vec<(i64, Vec<i64>)> {
    fn tag_cs(t: &str) -> i64 {
        // mm:ss.xx (mm may exceed 2 digits)
        let (m, rest) = t.split_once(':').expect("mm:ss.xx");
        let (s, cs) = rest.split_once('.').expect("ss.xx");
        m.parse::<i64>().unwrap() * 6000 + s.parse::<i64>().unwrap() * 100
            + cs.parse::<i64>().unwrap()
    }
    let mut out = Vec::new();
    for line in text.lines() {
        if !line.starts_with('[') || !line.as_bytes().get(1).is_some_and(u8::is_ascii_digit) {
            continue; // header tag or blank
        }
        let close = line.find(']').unwrap();
        let line_cs = tag_cs(&line[1..close]);
        let mut words = Vec::new();
        let mut rest = &line[close + 1..];
        while let Some(open) = rest.find('<') {
            let end = rest[open..].find('>').unwrap() + open;
            words.push(tag_cs(&rest[open + 1..end]));
            rest = &rest[end + 1..];
        }
        out.push((line_cs, words));
    }
    out
}

#[test]
fn lrc_parses_and_timestamps_are_monotonic_and_in_bounds() {
    let map = fixture_map();
    let lrc = formats::export(&map, &meta(), Format::Lrc);
    let lines = parse_lrc(&lrc);
    // 5 lines: 3 lyric-linked + 2 fallback; every word present (LRC is
    // data-complete, unsung included)
    assert_eq!(lines.len(), 5);
    let n_word_tags: usize = lines.iter().map(|(_, ws)| ws.len() - 1).sum(); // minus end tag
    assert_eq!(n_word_tags, map.words.len());
    let bound_cs = (map.duration * 100.0).ceil() as i64;
    let mut prev_line = 0i64;
    for (line_cs, word_cs) in &lines {
        assert!(*line_cs >= prev_line, "line tags must be monotonic");
        prev_line = *line_cs;
        assert_eq!(*line_cs, word_cs[0], "line tag repeats first word onset");
        let mut prev = 0i64;
        for cs in word_cs {
            assert!((0..=bound_cs).contains(cs), "timestamp out of song bounds");
            assert!(*cs >= prev, "word tags must be monotonic within a line");
            prev = *cs;
        }
    }
}

#[test]
fn lrc_rounding_edge_is_ties_to_even() {
    let lrc = formats::export(&fixture_map(), &meta(), Format::Lrc);
    // "run" ends the line at 6.995 s -> 699.5 cs -> 700 (ties-to-even, up)
    assert!(lrc.contains("run <00:07.00>"), "{lrc}");
    // "yeah!)" ends its line at 9.985 s -> 998.5 cs -> 998 (down to even)
    assert!(lrc.contains("yeah!) <00:09.98>"), "{lrc}");
}

// ---------------------------------------------------------------------------
// ASS: structural checks
// ---------------------------------------------------------------------------

#[test]
fn ass_structure_events_and_k_sums() {
    let map = fixture_map();
    let ass = formats::export(&map, &meta(), Format::Ass);
    for section in ["[Script Info]", "[V4+ Styles]", "[Events]"] {
        assert!(ass.contains(section), "missing {section}");
    }
    let styles = ass.lines().filter(|l| l.starts_with("Style: ")).count();
    assert_eq!(styles, 2); // Karaoke + AdLib

    let events: Vec<&str> = ass
        .lines()
        .filter(|l| l.starts_with("Dialogue: "))
        .collect();
    // 4 events: unsung line 2 must not produce one
    assert_eq!(events.len(), 4, "{ass}");
    assert!(
        !ass.contains("silent") && !ass.contains("bridge"),
        "unsung span leaked into events"
    );
    // special characters escaped so lyric text can't open an override block
    assert!(ass.contains("fire\\{works\\}"), "{ass}");
    // inline ad-libs italicized in place
    assert!(ass.contains("\\i1}(oh,{\\i0}"), "{ass}");

    fn cs(t: &str) -> i64 {
        let p: Vec<&str> = t.split([':', '.']).collect();
        p[0].parse::<i64>().unwrap() * 360_000
            + p[1].parse::<i64>().unwrap() * 6000
            + p[2].parse::<i64>().unwrap() * 100
            + p[3].parse::<i64>().unwrap()
    }
    let bound_cs = (map.duration * 100.0).ceil() as i64;
    let mut prev_start = 0i64;
    for ev in &events {
        let fields: Vec<&str> = ev.splitn(10, ',').collect();
        let (start, end) = (cs(&fields[1]), cs(&fields[2]));
        assert!(start <= end && end <= bound_cs && start >= 0);
        assert!(start >= prev_start, "events must be ordered");
        prev_start = start;
        // \k durations must sum exactly to the event duration
        let text = fields[9];
        let mut k_sum = 0i64;
        let mut rest = text;
        while let Some(pos) = rest.find("\\k") {
            let tail = &rest[pos + 2..];
            let digits: String = tail.chars().take_while(char::is_ascii_digit).collect();
            k_sum += digits.parse::<i64>().unwrap();
            rest = tail;
        }
        assert_eq!(k_sum, end - start, "\\k tags must fill the event: {ev}");
    }
}

// ---------------------------------------------------------------------------
// UltraStar: beats reconstruct word onsets
// ---------------------------------------------------------------------------

#[test]
fn ultrastar_beats_reconstruct_onsets_within_one_beat() {
    let map = fixture_map();
    let txt = formats::export(&map, &meta(), Format::UltraStar);
    let gap_ms: i64 = txt
        .lines()
        .find_map(|l| l.strip_prefix("#GAP:"))
        .unwrap()
        .parse()
        .unwrap();
    let bpm: i64 = txt
        .lines()
        .find_map(|l| l.strip_prefix("#BPM:"))
        .unwrap()
        .parse()
        .unwrap();
    let beat_ms = 60_000 / (4 * bpm);

    let notes: Vec<(char, i64, i64, i64, &str)> = txt
        .lines()
        .filter(|l| l.starts_with(": ") || l.starts_with("F "))
        .map(|l| {
            let mut it = l.splitn(5, ' ');
            let kind = it.next().unwrap().chars().next().unwrap();
            let beat: i64 = it.next().unwrap().parse().unwrap();
            let len: i64 = it.next().unwrap().parse().unwrap();
            let pitch: i64 = it.next().unwrap().parse().unwrap();
            (kind, beat, len, pitch, it.next().unwrap())
        })
        .collect();
    assert_eq!(notes.len(), map.words.len());
    assert!(txt.trim_end().ends_with('E'));
    assert_eq!(txt.matches("\n- ").count(), 4); // 5 lines -> 4 breaks

    let dur_ms = (map.duration * 1000.0) as i64;
    let mut prev_end = i64::MIN;
    for ((kind, beat, len, pitch, text), word) in notes.iter().zip(&map.words) {
        assert_eq!(*pitch, 0, "v1 exports pitch 0 (no melody data)");
        assert!(*len >= 1);
        assert!(*beat >= prev_end, "notes must not overlap");
        prev_end = beat + len;
        // freestyle for unsung/ad-lib words, normal otherwise
        let expect_kind = if word.unsung || word.ad_lib { 'F' } else { ':' };
        assert_eq!(*kind, expect_kind, "word {}", word.word);
        assert_eq!(text.trim_end(), word.word);
        // onset reconstruction: within one beat (50 ms at BPM 300)
        let t_ms = gap_ms + beat * beat_ms;
        let onset_ms = (word.start * 1000.0).round() as i64;
        assert!(
            (t_ms - onset_ms).abs() <= beat_ms,
            "word {} onset {onset_ms} ms reconstructed as {t_ms} ms",
            word.word
        );
        assert!((0..=dur_ms + beat_ms).contains(&t_ms), "note beyond song");
    }
}
