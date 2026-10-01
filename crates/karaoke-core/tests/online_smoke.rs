//! Live checks against LRCLIB and yt-dlp — network, so `#[ignore]`d:
//!
//!   KARAOKE_YTDLP=apps/desktop/src-tauri/tools/yt-dlp.exe \
//!     cargo test -p karaoke-core --test online_smoke -- --ignored --nocapture
//!
//! The test song is a public-domain 1908 recording (archive.org 78rpm
//! collection) whose lyrics are public domain too. Only metadata is printed —
//! never lyric text.

use karaoke_core::fetch::Tools;
use karaoke_core::lrclib::{Client, Query};

const PD_URL: &str = "https://archive.org/details/78_take-me-out-to-the-ball-game_harvey-hindermeyer_gbia0111514b";

#[test]
#[ignore = "network"]
fn lrclib_finds_full_lyrics_for_the_1908_recording() {
    let client = Client::new("Karascape-dev/0.1 (karaoke app; smoke test)");
    let q = Query {
        title: "Take Me Out To The Ball Game".into(),
        artist: Some("Harvey Hindermeyer".into()),
        album: None,
        duration_s: Some(157.62),
    };
    let rec = client.lookup(&q).expect("lookup").expect("a match");
    let lines = rec.lyrics_text().map(|t| t.lines().filter(|l| !l.trim().is_empty()).count()).unwrap_or(0);
    println!(
        "LRCLIB #{}: '{}' by '{}', {:?} s, {} lyric lines, synced: {}",
        rec.id,
        rec.track_name,
        rec.artist_name,
        rec.duration,
        lines,
        rec.synced_lyrics.is_some()
    );
    assert!(lines >= 8, "expected the full song, got {lines} lines");
}

#[test]
#[ignore = "network"]
fn lrclib_near_misses_still_find_the_song() {
    let client = Client::new("Karascape-dev/0.1 (karaoke app; smoke test)");
    // A version tag on the upload's title.
    let tagged = Query {
        title: "Take Me Out To The Ball Game v2".into(),
        artist: Some("Harvey Hindermeyer".into()),
        album: None,
        duration_s: Some(157.62),
    };
    let r = client.lookup(&tagged).expect("lookup").expect("found despite the v2");
    println!("v2 title -> LRCLIB #{} '{}' by '{}'", r.id, r.track_name, r.artist_name);
    // An upload named "Song - Artist": title and artist arrive swapped.
    let swapped = Query {
        title: "Ed Meeker".into(),
        artist: Some("Take Me Out to the Ball Game".into()),
        album: None,
        duration_s: None,
    };
    let r = client.lookup(&swapped).expect("lookup").expect("found despite the swap");
    println!("swapped -> LRCLIB #{} '{}' by '{}'", r.id, r.track_name, r.artist_name);
    assert!(r.track_name.to_lowercase().contains("ball game"));
}

#[test]
#[ignore = "network + yt-dlp"]
fn ytdlp_checks_a_public_domain_link() {
    let tools = Tools::locate(&[]).expect("set KARAOKE_YTDLP or put yt-dlp on PATH");
    println!("yt-dlp {} (deno: {:?}, ffmpeg: {:?})", tools.version().unwrap(), tools.deno, tools.ffmpeg);
    let links = tools.check_link(PD_URL).expect("check");
    println!("{links:#?}");
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].title, "Take Me Out To The Ball Game");
    assert_eq!(links[0].artist.as_deref(), Some("Harvey Hindermeyer"));
}
