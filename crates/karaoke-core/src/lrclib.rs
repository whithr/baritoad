//! Online lyrics lookup through LRCLIB's public API (PLAN.md §5 "Lyrics
//! lookup", §7). lrclib.net is free and keyless; requests identify the client
//! in `User-Agent`, as LRCLIB asks. Only title / artist / album / duration
//! leave the machine — never audio.
//!
//! Lookup order: `GET /api/get` (exact match on title + artist, duration
//! within a couple of seconds) when the artist is known, then
//! `/api/search` by title + artist, then by title alone. Search results go
//! through [`pick_best`]: LRCLIB's "instrumental" flag is unreliable for old
//! recordings (several vocal 1908 recordings are tagged instrumental), so only
//! records that carry lyrics are candidates, and duration decides between
//! versions — a 43-second kids' cut of a song is not its lyrics.
//!
//! `plainLyrics` is what the pipeline aligns against (it goes through the
//! cleanup pass like pasted lyrics); `syncedLyrics` (line-timed LRC) is kept
//! beside it.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

pub const DEFAULT_BASE: &str = "https://lrclib.net";

const TIMEOUT: Duration = Duration::from_secs(15);

/// Duration slack when choosing between search results: a candidate within
/// this many seconds (or [`DURATION_SLACK_FRACTION`] of the song, whichever is
/// larger) can be the same song; further off is a different cut.
const DURATION_SLACK_S: f64 = 20.0;
const DURATION_SLACK_FRACTION: f64 = 0.25;
/// Candidates whose durations are off by a similar amount (same 10-second
/// band) are told apart by how complete their lyrics are.
const DURATION_BAND_S: f64 = 10.0;
/// Within this, a record is taken to be the same recording (LRCLIB's own
/// exact-match tolerance is about 2 s) and beats any further one.
const SAME_RECORDING_S: f64 = 3.0;

/// What we know about the song.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Query {
    pub title: String,
    #[serde(default)]
    pub artist: Option<String>,
    #[serde(default)]
    pub album: Option<String>,
    /// Seconds, from the audio itself (keeps the match to the same edit).
    #[serde(default)]
    pub duration_s: Option<f64>,
}

/// One LRCLIB record (the API's camelCase JSON).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub id: i64,
    #[serde(default)]
    pub track_name: String,
    #[serde(default)]
    pub artist_name: String,
    #[serde(default)]
    pub album_name: Option<String>,
    #[serde(default)]
    pub duration: Option<f64>,
    #[serde(default)]
    pub instrumental: bool,
    #[serde(default)]
    pub plain_lyrics: Option<String>,
    #[serde(default)]
    pub synced_lyrics: Option<String>,
}

impl Record {
    /// Lyrics text to align against: `plainLyrics`, or the synced lyrics'
    /// words when only those exist.
    pub fn lyrics_text(&self) -> Option<String> {
        if let Some(p) = self.plain_lyrics.as_deref().filter(|p| !p.trim().is_empty()) {
            return Some(p.to_string());
        }
        self.synced_lyrics
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .map(|s| crate::formats::lrc::lyrics_text(s).text)
            .filter(|t| !t.trim().is_empty())
    }

    fn has_lyrics(&self) -> bool {
        self.lyrics_text().is_some()
    }
}

pub struct Client {
    agent: ureq::Agent,
    base: String,
}

impl Client {
    /// `user_agent`: app name + version (+ homepage when there is one).
    pub fn new(user_agent: &str) -> Self {
        Self::with_base(DEFAULT_BASE, user_agent)
    }

    pub fn with_base(base: &str, user_agent: &str) -> Self {
        // System TLS (SChannel / Security.framework / the system OpenSSL) and
        // the platform's root store — no bundled CA list.
        let tls = ureq::tls::TlsConfig::builder()
            .provider(ureq::tls::TlsProvider::NativeTls)
            .root_certs(ureq::tls::RootCerts::PlatformVerifier)
            .build();
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(TIMEOUT))
            .user_agent(user_agent)
            .tls_config(tls)
            .http_status_as_error(false)
            .build();
        Self {
            agent: ureq::Agent::new_with_config(config),
            base: base.trim_end_matches('/').to_string(),
        }
    }

    /// `/api/get`: LRCLIB's exact match. `Ok(None)` when it has no record.
    pub fn get(&self, q: &Query, artist: &str) -> Result<Option<Record>> {
        let mut req = self
            .agent
            .get(format!("{}/api/get", self.base))
            .query("track_name", q.title.trim())
            .query("artist_name", artist.trim());
        if let Some(album) = q.album.as_deref().map(str::trim).filter(|a| !a.is_empty()) {
            req = req.query("album_name", album);
        }
        if let Some(d) = q.duration_s.filter(|d| (1.0..=3600.0).contains(d)) {
            req = req.query("duration", format!("{}", d.round() as i64));
        }
        let mut resp = req.call().map_err(net)?;
        let status = resp.status().as_u16();
        let body = resp.body_mut().read_to_string().map_err(net)?;
        match status {
            200 => serde_json::from_str(&body).map(Some).map_err(|e| bad_reply(&e)),
            404 => Ok(None),
            s => Err(Error::Network(format!("LRCLIB answered HTTP {s}"))),
        }
    }

    /// `/api/search` by title (and artist, when given).
    pub fn search(&self, title: &str, artist: Option<&str>) -> Result<Vec<Record>> {
        let mut req = self
            .agent
            .get(format!("{}/api/search", self.base))
            .query("track_name", title.trim());
        if let Some(a) = artist.map(str::trim).filter(|a| !a.is_empty()) {
            req = req.query("artist_name", a);
        }
        let mut resp = req.call().map_err(net)?;
        let status = resp.status().as_u16();
        let body = resp.body_mut().read_to_string().map_err(net)?;
        match status {
            200 => serde_json::from_str(&body).map_err(|e| bad_reply(&e)),
            s => Err(Error::Network(format!("LRCLIB answered HTTP {s}"))),
        }
    }

    /// The best record with lyrics for `q`, or `Ok(None)` when LRCLIB has
    /// nothing that fits (the job then transcribes).
    pub fn lookup(&self, q: &Query) -> Result<Option<Record>> {
        let title = q.title.trim();
        if title.is_empty() {
            return Ok(None);
        }
        let artist = q.artist.as_deref().map(str::trim).filter(|a| !a.is_empty());
        if let Some(a) = artist {
            if let Some(r) = self.get(q, a)? {
                if r.has_lyrics() {
                    return Ok(Some(r));
                }
            }
            let hits = self.search(title, Some(a))?;
            if let Some(r) = pick_best(&hits, q) {
                return Ok(Some(r.clone()));
            }
        }
        let hits = self.search(title, None)?;
        Ok(pick_best(&hits, q).cloned())
    }
}

fn net(e: ureq::Error) -> Error {
    Error::Network(format!("LRCLIB: {e}"))
}

fn bad_reply(e: &serde_json::Error) -> Error {
    Error::Network(format!("LRCLIB sent a reply we couldn't read: {e}"))
}

/// Choose among search results: same title, lyrics present, the artist when
/// we know it, then the closest duration within the slack.
pub fn pick_best<'a>(hits: &'a [Record], q: &Query) -> Option<&'a Record> {
    let want_title = normalize(&q.title);
    if want_title.is_empty() {
        return None;
    }
    let titled: Vec<&Record> = hits
        .iter()
        .filter(|r| r.has_lyrics() && titles_match(&want_title, &normalize(&r.track_name)))
        .collect();
    // Prefer the artist we were told; fall back to any artist only when none
    // match (compilations credit "Various Artists").
    let by_artist: Vec<&Record> = match q.artist.as_deref().map(normalize).filter(|a| !a.is_empty()) {
        Some(want) => {
            let m: Vec<&Record> = titled
                .iter()
                .copied()
                .filter(|r| artists_match(&want, &normalize(&r.artist_name)))
                .collect();
            if m.is_empty() {
                titled
            } else {
                m
            }
        }
        None => titled,
    };
    // A live album's lyrics carry stage banter; prefer a studio version
    // unless the song itself is a live one.
    let want_live = is_live(&q.title);
    let off_live = |r: &Record| !want_live && (is_live(&r.track_name) || r.album_name.as_deref().is_some_and(is_live));
    match q.duration_s.filter(|d| *d > 0.0) {
        Some(want) => {
            let slack = DURATION_SLACK_S.max(want * DURATION_SLACK_FRACTION);
            // Durations compare in bands: within one, the fuller lyrics win —
            // a missing verse leaves the singer nothing to read, while extra
            // lines only become unsung spans.
            let band = |off: f64| {
                if off <= SAME_RECORDING_S {
                    -1
                } else {
                    (off / DURATION_BAND_S).floor() as i64
                }
            };
            by_artist
                .into_iter()
                .filter_map(|r| r.duration.map(|d| ((d - want).abs(), r)))
                .filter(|(off, _)| *off <= slack)
                // studio first, then the same recording, nearest band,
                // fullest lyrics, synced
                .min_by(|(a, ra), (b, rb)| {
                    off_live(ra)
                        .cmp(&off_live(rb))
                        .then_with(|| band(*a).cmp(&band(*b)))
                        .then_with(|| lyric_lines(rb).cmp(&lyric_lines(ra)))
                        .then_with(|| rb.synced_lyrics.is_some().cmp(&ra.synced_lyrics.is_some()))
                        .then_with(|| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
                })
                .map(|(_, r)| r)
        }
        None => by_artist
            .iter()
            .copied()
            .filter(|r| !off_live(r))
            .find(|r| r.synced_lyrics.is_some())
            .or_else(|| by_artist.iter().copied().find(|r| !off_live(r)))
            .or_else(|| by_artist.first().copied()),
    }
}

fn lyric_lines(r: &Record) -> usize {
    r.lyrics_text().map(|t| t.lines().filter(|l| !l.trim().is_empty()).count()).unwrap_or(0)
}

/// "(Live)", "Live at …", "Live from …" — a recorded performance.
fn is_live(s: &str) -> bool {
    let lower = s.to_lowercase();
    let words: Vec<&str> = lower.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).collect();
    words.windows(2).any(|w| w[0] == "live" && matches!(w[1], "at" | "in" | "from" | "on"))
        || lower.contains("(live") || lower.contains("[live") || lower.contains("- live") || words == ["live"]
}

/// Lowercase words only: brackets and what's in them ("(Remastered 2011)",
/// "[Live]"), a trailing "feat. …", and punctuation all drop out.
pub fn normalize(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut depth = 0usize;
    for ch in s.chars() {
        match ch {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth = depth.saturating_sub(1),
            _ if depth > 0 => {}
            c if c.is_alphanumeric() => out.extend(c.to_lowercase()),
            '\'' | '’' => {} // "don't" == "dont"
            _ => out.push(' '),
        }
    }
    let words: Vec<&str> = out.split_whitespace().collect();
    let cut = words
        .iter()
        .position(|w| matches!(*w, "feat" | "ft" | "featuring"))
        .unwrap_or(words.len());
    words[..cut].join(" ")
}

fn titles_match(want: &str, got: &str) -> bool {
    !got.is_empty() && (want == got || squash(want) == squash(got))
}

/// Whole-word containment either way, so multi-artist credits ("A & B",
/// "A, B" — punctuation is already spaces) match any one of their names,
/// while "a" never matches "abba".
fn artists_match(want: &str, got: &str) -> bool {
    if want.is_empty() || got.is_empty() {
        return false;
    }
    let (w, g) = (format!(" {want} "), format!(" {got} "));
    g.contains(&w) || w.contains(&g)
}

/// Spaces out, so "ball game" == "ballgame".
fn squash(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Lyric text here is invented (CLAUDE.md: never copy real lyrics).
    fn rec(id: i64, track: &str, artist: &str, duration: f64, plain: Option<&str>, synced: Option<&str>) -> Record {
        Record {
            id,
            track_name: track.into(),
            artist_name: artist.into(),
            album_name: None,
            duration: Some(duration),
            instrumental: plain.is_none() && synced.is_none(),
            plain_lyrics: plain.map(String::from),
            synced_lyrics: synced.map(String::from),
        }
    }

    fn q(title: &str, artist: Option<&str>, duration: Option<f64>) -> Query {
        Query {
            title: title.into(),
            artist: artist.map(String::from),
            album: None,
            duration_s: duration,
        }
    }

    #[test]
    fn normalize_drops_brackets_feat_and_punctuation() {
        assert_eq!(normalize("Song Name (Remastered 2011) [Live]"), "song name");
        assert_eq!(normalize("Don't Stop — Me Now!"), "dont stop me now");
        assert_eq!(normalize("Track feat. Somebody Else"), "track");
        assert_eq!(normalize("Track (feat. Somebody)"), "track");
    }

    #[test]
    fn instrumental_records_never_win_even_at_the_right_length() {
        // Mirrors LRCLIB's real answer for a 1908 vocal recording (157.6 s):
        // compilation entries at ~155 s tagged instrumental, a 43 s kids' cut
        // with lyrics, and a full-length vocal version at 122 s.
        let hits = vec![
            rec(1, "Take Me Out To The Ball Game", "Kids Singer", 43.0, Some("la la"), Some("[00:01.00]la la")),
            rec(2, "Take Me Out To The Ball Game", "Various", 155.0, None, None),
            rec(3, "Take Me Out to the Ball Game", "Old Tenor", 122.0, Some("verse one\nchorus"), None),
            rec(4, "Take Me Out to the Ball Game", "Various Artists", 163.0, None, None),
        ];
        let best = pick_best(&hits, &q("TAKE ME OUT TO THE BALL GAME", Some("Harvey Hindermeyer"), Some(157.6)));
        assert_eq!(best.map(|r| r.id), Some(3));
    }

    #[test]
    fn a_studio_version_beats_a_closer_live_album_cut() {
        // LRCLIB's real top picks for the 1908 recording (157.6 s): a live
        // album at 182 s and a 1908 studio recording at 122 s, both in range.
        let mut live = rec(1, "Take Me Out to the Ball Game", "Rock Band", 182.0, Some("x"), Some("[00:01.00]x"));
        live.album_name = Some("On Stage, Vol. 4 (Live)".into());
        let studio = rec(2, "Take Me Out to the Ball Game", "Old Tenor", 122.0, Some("x"), None);
        let hits = vec![live, studio];
        let q1 = q("Take Me Out To The Ball Game", Some("Harvey Hindermeyer"), Some(157.6));
        assert_eq!(pick_best(&hits, &q1).map(|r| r.id), Some(2));
        // ...unless the song asked for is the live one.
        let q2 = q("Take Me Out to the Ball Game (Live)", None, Some(180.0));
        assert_eq!(pick_best(&hits, &q2).map(|r| r.id), Some(1));
        assert!(is_live("Live at the Garden") && is_live("Song (Live 1999)") && !is_live("Live and Let Die") && !is_live("Deliver"));
    }

    #[test]
    fn the_known_artist_is_preferred_over_a_closer_duration() {
        let hits = vec![
            rec(1, "Waterloo", "Cover Band", 165.0, Some("words"), None),
            rec(2, "Waterloo", "ABBA", 171.0, Some("words"), None),
        ];
        let best = pick_best(&hits, &q("Waterloo", Some("ABBA"), Some(165.0)));
        assert_eq!(best.map(|r| r.id), Some(2));
    }

    #[test]
    fn closest_duration_wins_and_synced_breaks_ties() {
        let hits = vec![
            rec(1, "Song", "A", 200.0, Some("x"), None),
            rec(2, "Song", "A", 181.0, Some("x"), None),
            rec(3, "Song", "A", 179.0, Some("x"), Some("[00:01.00]x")),
        ];
        assert_eq!(pick_best(&hits, &q("Song", Some("A"), Some(180.0))).map(|r| r.id), Some(3));
    }

    #[test]
    fn at_a_similar_distance_the_fuller_lyrics_win() {
        // The 1908 recording again (157.6 s, artist matches nobody): a
        // chorus-only cover at 127 s vs the full song at 122 s — both about
        // 30-35 s off, so the full verses win.
        let chorus = rec(1, "Take Me Out to the Ball Game", "Cover Band", 127.0, Some("a\nb\nc\nd"), Some("[00:01.00]a"));
        let full = rec(2, "Take Me Out to the Ball Game", "Old Tenor", 122.0, Some("v1\nv2\nv3\nv4\na\nb\nc\nd"), None);
        let hits = vec![chorus, full];
        assert_eq!(pick_best(&hits, &q("Take Me Out To The Ball Game", Some("Harvey Hindermeyer"), Some(157.6))).map(|r| r.id), Some(2));
        // The same recording (within a few seconds) wins over a fuller one.
        assert_eq!(pick_best(&hits, &q("Take Me Out To The Ball Game", None, Some(128.0))).map(|r| r.id), Some(1));
    }

    #[test]
    fn a_different_cut_is_rejected() {
        let hits = vec![rec(1, "Song", "A", 60.0, Some("x"), None)];
        assert!(pick_best(&hits, &q("Song", Some("A"), Some(240.0))).is_none());
    }

    #[test]
    fn titles_must_match_after_normalizing() {
        let hits = vec![
            rec(1, "Song Part Two", "A", 180.0, Some("x"), None),
            rec(2, "Song (2015 Remaster)", "A", 180.0, Some("x"), None),
        ];
        assert_eq!(pick_best(&hits, &q("song", None, Some(180.0))).map(|r| r.id), Some(2));
        let joined = vec![rec(3, "Take Me Out to the Ballgame", "A", 150.0, Some("x"), None)];
        assert_eq!(pick_best(&joined, &q("Take Me Out to the Ball Game", None, None)).map(|r| r.id), Some(3));
    }

    #[test]
    fn multi_artist_credits_match_any_name() {
        assert!(artists_match(&normalize("Artist One"), &normalize("Artist One & Artist Two")));
        assert!(artists_match(&normalize("Artist Two"), &normalize("Artist One, Artist Two")));
        assert!(!artists_match(&normalize("Someone"), &normalize("Nobody Else")));
        assert!(!artists_match(&normalize("A"), &normalize("ABBA")));
    }

    #[test]
    fn without_a_duration_synced_lyrics_are_preferred() {
        let hits = vec![
            rec(1, "Song", "A", 100.0, Some("x"), None),
            rec(2, "Song", "A", 300.0, Some("x"), Some("[00:01.00]x")),
        ];
        assert_eq!(pick_best(&hits, &q("Song", Some("A"), None)).map(|r| r.id), Some(2));
    }

    #[test]
    fn records_parse_from_lrclib_json_and_fall_back_to_synced_words() {
        let json = r#"{"id":7,"name":"Song","trackName":"Song","artistName":"A","albumName":null,
            "duration":180.0,"instrumental":false,"plainLyrics":null,
            "syncedLyrics":"[00:01.00]first made up line\n[00:04.50]second made up line",
            "hasWordSync":false,"lyricsfile":null}"#;
        let r: Record = serde_json::from_str(json).unwrap();
        assert_eq!(r.id, 7);
        let text = r.lyrics_text().unwrap();
        assert!(text.contains("first made up line") && !text.contains("[00:"));
    }
}
