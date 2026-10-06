//! Fixture-level tests for the lyric cleanup pass over
//! hand-written dirty files in the Genius / AZLyrics paste style.
//!
//! All lyric text is invented for these tests — never copied or scraped from
//! lyrics sites (CLAUDE.md hard rule).

use karaoke_core::lyrics::{clean, Edit, RepeatScope};
use karaoke_core::timing::{WordTiming, WordTimingMap};

const GENIUS: &str = include_str!("fixtures/dirty_genius.txt");
const AZLYRICS: &str = include_str!("fixtures/dirty_azlyrics.txt");
const CLEAN: &str = include_str!("fixtures/clean_passthrough.txt");

fn kind_counts(edits: &[Edit]) -> (usize, usize, usize, usize, usize) {
    let mut headers = 0;
    let mut credits = 0;
    let mut embeds = 0;
    let mut repeats = 0;
    let mut adlibs = 0;
    for e in edits {
        match e {
            Edit::SectionHeaderRemoved { .. } => headers += 1,
            Edit::CreditLineRemoved { .. } => credits += 1,
            Edit::EmbedSuffixRemoved { .. } => embeds += 1,
            Edit::RepeatExpanded { .. } => repeats += 1,
            Edit::AdLibFlagged { .. } => adlibs += 1,
        }
    }
    (headers, credits, embeds, repeats, adlibs)
}

#[test]
fn genius_style_paste_cleans_fully() {
    let c = clean(GENIUS);
    let (headers, credits, embeds, repeats, adlibs) = kind_counts(&c.edits);
    assert_eq!(headers, 6, "edits: {:#?}", c.edits);
    assert_eq!(credits, 2); // Contributors line + "You might also like"
    assert_eq!(embeds, 1); // "…rain42Embed"
    assert_eq!(repeats, 2); // [Chorus x2] section + "shore x2" line
    assert_eq!(adlibs, 3); // (don't look back) + (glow, glow) twice

    // 14 kept lines: 1 intro + 3 verse + (2 chorus)*2 + (2+1) verse 2 + 2
    // chorus + 1 outro
    assert_eq!(c.lines.len(), 14);

    // section expansion: the chorus body appears twice, copies marked
    let displays: Vec<&str> = c.lines.iter().map(|l| l.display.as_str()).collect();
    assert_eq!(
        displays
            .iter()
            .filter(|d| **d == "Light it up, let it go")
            .count(),
        3 // twice from [Chorus x2], once from the plain [Chorus]
    );
    let section_edit = c
        .edits
        .iter()
        .find_map(|e| match e {
            Edit::RepeatExpanded {
                scope: RepeatScope::Section,
                section,
                times,
                lines_added,
                ..
            } => Some((section.clone(), *times, *lines_added)),
            _ => None,
        })
        .expect("section repeat recorded");
    assert_eq!(section_edit, (Some("chorus".into()), 2, 2));

    // repeat provenance: generated copies flagged, originals not
    assert_eq!(c.lines.iter().filter(|l| l.repeated).count(), 3);

    // embed junk stripped but the lyric kept
    assert_eq!(c.lines.last().unwrap().display, "Paper lanterns in the rain");

    // ad-lib words flagged but kept verbatim
    let chorus_line = c
        .lines
        .iter()
        .find(|l| l.display.contains("(glow, glow)"))
        .unwrap();
    // "Watch the river start to glow (glow, glow)" -> last two words flagged
    let flags: Vec<bool> = chorus_line.words.iter().map(|w| w.ad_lib).collect();
    assert_eq!(
        flags,
        vec![false, false, false, false, false, false, true, true]
    );

    let s = c.summary();
    assert!(s.contains("removed 6 section headers"), "{s}");
    assert!(s.contains("expanded 2 marked repeats"), "{s}");
}

#[test]
fn azlyrics_style_paste_cleans_fully() {
    let c = clean(AZLYRICS);
    let (headers, credits, embeds, repeats, adlibs) = kind_counts(&c.edits);
    assert_eq!(headers, 1, "edits: {:#?}", c.edits); // bare "Chorus:"
    assert_eq!(credits, 2); // Writer(s): + "Lyrics licensed and provided by"
    assert_eq!(embeds, 0);
    assert_eq!(repeats, 1); // "La la la la (x2)"
    assert_eq!(adlibs, 0);

    // unclassifiable title line is conservatively kept (cleanup must not
    // eat lyrics), smart quotes survive verbatim
    assert_eq!(c.lines[0].display, "\"Silver Static\"");
    assert!(c
        .lines
        .iter()
        .any(|l| l.display == "You said you\u{2019}d never leave me alone"));

    let la_count = c
        .lines
        .iter()
        .filter(|l| l.display == "La la la la")
        .count();
    assert_eq!(la_count, 2);
    assert_eq!(c.lines.len(), 7);
}

#[test]
fn clean_paste_is_byte_identical_and_edit_free() {
    let c = clean(CLEAN);
    assert!(c.edits.is_empty(), "edits: {:#?}", c.edits);
    assert_eq!(c.to_text(), CLEAN);
    assert_eq!(c.summary(), "no changes needed");
    // stanza structure preserved for the line-oriented exporters
    assert_eq!(c.lines.len(), 8);
    assert_eq!(c.lines[4].blank_before, 1);
}

#[test]
fn annotate_map_links_words_to_lyric_structure() {
    let c = clean(GENIUS);
    let words = c.lyric_words();

    // synthetic timing map with the aligner's 1:1 word correspondence
    let timed: Vec<WordTiming> = words
        .iter()
        .enumerate()
        .map(|(i, w)| WordTiming {
            word: w.display.clone(),
            start: i as f64 * 0.5,
            end: i as f64 * 0.5 + 0.4,
            confidence: 0.9,
            anchored: true,
            unsung: false,
            line: None,
            word_in_line: None,
            ad_lib: false,
        })
        .collect();
    let mut map = WordTimingMap::new(words.len() as f64 * 0.5 + 1.0, timed, vec![]);
    c.annotate_map(&mut map).unwrap();

    // links walk forward through the lyric structure — validate() checks this
    assert!(map.validate().is_empty(), "{:?}", map.validate());
    assert_eq!(map.words[0].line, Some(0));
    assert_eq!(map.words[0].word_in_line, Some(0));
    let last = map.words.last().unwrap();
    assert_eq!(last.line, Some(c.lines.len() - 1));

    // ad-lib flags carried through to the map
    let n_adlib_map = map.words.iter().filter(|w| w.ad_lib).count();
    let n_adlib_lyrics = c
        .lines
        .iter()
        .flat_map(|l| &l.words)
        .filter(|w| w.ad_lib)
        .count();
    assert_eq!(n_adlib_map, n_adlib_lyrics);
    assert!(n_adlib_map > 0);

    // round-trips through JSON with the new fields intact
    let back = WordTimingMap::from_json(&map.to_json_pretty().unwrap()).unwrap();
    assert_eq!(back.words[0].line, Some(0));
    assert_eq!(
        back.words.iter().filter(|w| w.ad_lib).count(),
        n_adlib_map
    );
}

#[test]
fn annotate_map_rejects_word_count_mismatch() {
    let c = clean(GENIUS);
    let mut map = WordTimingMap::new(10.0, vec![], vec![]);
    assert!(c.annotate_map(&mut map).is_err());
}
