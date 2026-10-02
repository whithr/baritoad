//! Party mode's core (docs/PARTY.md, docs/PARTY-PROTOCOL.md): the wire
//! protocol, what of the library a party shares, the rules for a guest's
//! pick, and toads. No I/O here — the relay client is the desktop app's
//! (`src-tauri/src/party.rs`), the relay is `services/relay/`.
//!
//! What leaves the machine is exactly what these types carry: per song with
//! timings an opaque per-party id, title, artist, duration and collection
//! names; per queue entry its id, song, singer and toad. Never audio, lyrics,
//! timing maps, cover art, file paths or hashes — `Song` and `QueueEntry`
//! carry paths, so they're projected into [`ListedSong`] / [`SharedEntry`]
//! here, and a test checks the JSON for anything else.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::library::{QueueEntry, Song};

/// The `v` every frame carries; another value closes the connection.
pub const PROTOCOL_VERSION: u64 = 1;

/// How many songs one guest can have waiting (the default; a setting).
pub const PER_GUEST_DEFAULT: usize = 2;

// ---------------------------------------------------------------- toads

/// A guest's toad: the site's toad family (docs/PARTY.md "Toads").
pub const FACES: &[&str] = &["sing", "smile", "grin", "wink", "sleepy", "surprised", "love", "cool", "belt", "nervous", "sad"];
pub const COLOURS: &[&str] = &["green", "pink", "blue", "gold", "purple"];
pub const HATS: &[&str] = &["none", "crown", "partyhat", "cap", "bow", "headphones", "bowtie"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Toad {
    pub face: String,
    pub colour: String,
    pub hat: String,
}

impl Default for Toad {
    fn default() -> Self {
        Toad { face: "sing".into(), colour: "green".into(), hat: "none".into() }
    }
}

impl Toad {
    /// Every part from the fixed lists.
    pub fn valid(&self) -> bool {
        FACES.contains(&self.face.as_str()) && COLOURS.contains(&self.colour.as_str()) && HATS.contains(&self.hat.as_str())
    }
}

/// Longest display name, in characters.
pub const NAME_MAX: usize = 14;

/// A guest's display name as the TV shows it: control characters out,
/// whitespace collapsed, trimmed, at most [`NAME_MAX`] characters. None
/// when nothing is left.
pub fn clean_name(raw: &str) -> Option<String> {
    let collapsed: String = raw
        .chars()
        .map(|c| if c.is_whitespace() { ' ' } else { c })
        .filter(|c| !c.is_control())
        .collect::<String>()
        .split(' ')
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let name: String = collapsed.chars().take(NAME_MAX).collect::<String>().trim_end().to_string();
    (!name.is_empty()).then_some(name)
}

// ---------------------------------------------------------------- what's shared

/// One song as guests see it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ListedSong {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artist: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
    pub collections: Vec<String>,
}

/// The song list for one party, with its id mapping (which never leaves).
#[derive(Debug, Clone, Default)]
pub struct Listing {
    pub songs: Vec<ListedSong>,
    to_db: HashMap<String, i64>,
    to_party: HashMap<i64, String>,
}

impl Listing {
    /// A party song id's library song.
    pub fn db_id(&self, party_id: &str) -> Option<i64> {
        self.to_db.get(party_id).copied()
    }
    /// A library song's party id, if it's listed.
    pub fn party_id(&self, db_id: i64) -> Option<&str> {
        self.to_party.get(&db_id).map(String::as_str)
    }
}

/// A per-party song id: opaque, and stable while the party lasts (the
/// same song keeps its id when the list is sent again), but meaningless in
/// the next party, since `salt` is new each time.
pub fn party_song_id(salt: &str, db_id: i64) -> String {
    let mut h = Sha256::new();
    h.update(salt.as_bytes());
    h.update(b":");
    h.update(db_id.to_le_bytes());
    let d = h.finalize();
    format!("s{}", d[..5].iter().map(|b| format!("{b:02x}")).collect::<String>())
}

/// The songs a party offers: those with timings, by title.
/// `collections_of` gives a song's collection names.
pub fn listing(songs: &[Song], collections_of: &dyn Fn(i64) -> Vec<String>, salt: &str) -> Listing {
    let mut out = Listing::default();
    let mut ready: Vec<&Song> = songs.iter().filter(|s| s.timing_map_path.is_some()).collect();
    ready.sort_by_key(|s| (s.title.to_lowercase(), s.artist.clone().unwrap_or_default().to_lowercase()));
    for s in ready {
        let id = party_song_id(salt, s.id);
        out.to_db.insert(id.clone(), s.id);
        out.to_party.insert(s.id, id.clone());
        out.songs.push(ListedSong {
            id,
            title: s.title.clone(),
            artist: s.artist.clone().filter(|a| !a.trim().is_empty()),
            duration: s.duration_s.map(|d| (d * 10.0).round() / 10.0),
            collections: collections_of(s.id),
        });
    }
    out
}

/// One queue entry as guests see it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SharedEntry {
    pub id: String,
    pub song: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub singer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub toad: Option<Toad>,
    /// The guest who picked it (per-party id), so their page can say
    /// "you're #N".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub guest: Option<String>,
}

/// The queue as guests see it, and the entry on the Stage (its shared id —
/// the same song can be queued twice). Entries whose song isn't listed (no
/// timings any more) are left out.
pub fn shared_queue(entries: &[QueueEntry], listing: &Listing, playing: Option<i64>) -> (Vec<SharedEntry>, Option<String>) {
    let mut now = None;
    let mut out = Vec::new();
    for e in entries {
        let Some(song) = listing.party_id(e.song.id) else { continue };
        if Some(e.id) == playing {
            now = Some(format!("e{}", e.id));
        }
        out.push(SharedEntry {
            id: format!("e{}", e.id),
            song: song.to_string(),
            singer: e.singer.clone(),
            toad: e.toad.clone(),
            guest: e.guest.clone(),
        });
    }
    (out, now)
}

/// The library entry id behind a shared entry id ("e12" → 12).
pub fn entry_db_id(shared: &str) -> Option<i64> {
    shared.strip_prefix('e')?.parse().ok()
}

// ---------------------------------------------------------------- requests

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RefuseCode {
    /// The guest already has their songs waiting.
    Limit,
    /// No such song in this party's list.
    UnknownSong,
    /// The song lost its timings since the list went out.
    NotReady,
}

/// A guest's pick: the library song to queue, or why not. `ready` says
/// whether a library song can still be sung (it exists and has timings).
pub fn check_request(
    listing: &Listing,
    song: &str,
    guest: &str,
    queue: &[QueueEntry],
    playing: Option<i64>,
    per_guest: usize,
    ready: &dyn Fn(i64) -> bool,
) -> Result<i64, RefuseCode> {
    let db = listing.db_id(song).ok_or(RefuseCode::UnknownSong)?;
    if !ready(db) {
        return Err(RefuseCode::NotReady);
    }
    let waiting = queue.iter().filter(|e| e.guest.as_deref() == Some(guest) && Some(e.id) != playing).count();
    if waiting >= per_guest {
        return Err(RefuseCode::Limit);
    }
    Ok(db)
}

// ---------------------------------------------------------------- protocol

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Resume {
    pub room: String,
    pub secret: String,
}

/// App → relay.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum AppMsg {
    Hello {
        app: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        resume: Option<Resume>,
    },
    Listing {
        songs: Vec<ListedSong>,
    },
    Queue {
        entries: Vec<SharedEntry>,
        #[serde(rename = "nowPlaying", skip_serializing_if = "Option::is_none")]
        now_playing: Option<String>,
    },
    RequestResult {
        req: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<RefuseCode>,
    },
    Kick {
        guest: String,
    },
    NewCode,
    Close,
}

/// Relay → app.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum RelayMsg {
    Room {
        room: String,
        secret: String,
        #[serde(rename = "joinUrl")]
        join_url: String,
    },
    GuestJoined {
        guest: String,
        name: String,
        toad: Toad,
    },
    Request {
        req: String,
        guest: String,
        song: String,
    },
    Withdraw {
        guest: String,
        entry: String,
    },
    GuestLeft {
        guest: String,
    },
    Error {
        code: String,
        message: String,
    },
}

/// A frame for the relay: the message with `"v": 1`.
pub fn encode(msg: &AppMsg) -> String {
    let mut v = serde_json::to_value(msg).expect("protocol messages serialize");
    if let Value::Object(m) = &mut v {
        m.insert("v".into(), Value::from(PROTOCOL_VERSION));
    }
    v.to_string()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodeError {
    /// Not a JSON object with a `t`.
    Malformed,
    /// Another protocol version — the app needs updating (or the relay).
    Version(u64),
}

/// A frame from the relay. Unknown message types are ignored (`Ok(None)`),
/// as the protocol says, so the relay can add some without breaking us.
pub fn decode(text: &str) -> Result<Option<RelayMsg>, DecodeError> {
    let v: Value = serde_json::from_str(text).map_err(|_| DecodeError::Malformed)?;
    let obj = v.as_object().ok_or(DecodeError::Malformed)?;
    match obj.get("v").and_then(Value::as_u64) {
        Some(PROTOCOL_VERSION) => {}
        Some(other) => return Err(DecodeError::Version(other)),
        None => return Err(DecodeError::Malformed),
    }
    if !obj.get("t").is_some_and(Value::is_string) {
        return Err(DecodeError::Malformed);
    }
    Ok(serde_json::from_value(v).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn song(id: i64, title: &str, timed: bool) -> Song {
        let dir = std::path::PathBuf::from(format!("C:/Users/x/Music/{title}-karaoke"));
        Song {
            id,
            title: title.into(),
            artist: Some("Someone".into()),
            album: None,
            audio_path: format!("C:/Users/x/Music/{title}.mp3").into(),
            audio_hash: format!("hash{id}"),
            timing_map_path: timed.then(|| dir.join("song.align.json")),
            job_dir: dir,
            vocals_path: None,
            instrumental_path: None,
            duration_s: Some(201.234),
            cover_path: Some("C:/Users/x/AppData/Local/baritoad/covers/abc.png".into()),
            lyric_source: Some("pasted".into()),
            language_tag: "en".into(),
            date_added: 0,
            last_played: None,
            play_count: 0,
            reviewed_at: None,
            year: None,
            genre: None,
            pace_wpm: None,
        }
    }

    fn entry(id: i64, s: &Song, guest: Option<&str>) -> QueueEntry {
        QueueEntry {
            id,
            position: id,
            added_from_collection: None,
            song: s.clone(),
            singer: guest.map(|g| format!("Singer {g}")),
            toad: guest.map(|_| Toad::default()),
            guest: guest.map(String::from),
        }
    }

    /// Every key anywhere in a JSON value.
    fn keys(v: &Value, out: &mut Vec<String>) {
        match v {
            Value::Object(m) => {
                for (k, x) in m {
                    out.push(k.clone());
                    keys(x, out);
                }
            }
            Value::Array(a) => a.iter().for_each(|x| keys(x, out)),
            _ => {}
        }
    }

    #[test]
    fn nothing_but_metadata_leaves() {
        let songs = vec![song(1, "Back On My BS", true), song(2, "Not Yet Timed", false)];
        let l = listing(&songs, &|_| vec!["Cassie's hits".into()], "salt");
        assert_eq!(l.songs.len(), 1, "only songs with timings");
        let q = vec![entry(7, &songs[0], Some("g1")), entry(8, &songs[0], None)];
        let (entries, now) = shared_queue(&q, &l, Some(7));
        let frames = [
            encode(&AppMsg::Listing { songs: l.songs.clone() }),
            encode(&AppMsg::Queue { entries, now_playing: now }),
        ];
        let allowed = [
            "v", "t", "songs", "id", "title", "artist", "duration", "collections", "entries", "song", "singer", "toad", "face", "colour", "hat",
            "guest", "nowPlaying",
        ];
        for f in frames {
            let v: Value = serde_json::from_str(&f).unwrap();
            let mut ks = Vec::new();
            keys(&v, &mut ks);
            for k in ks {
                assert!(allowed.contains(&k.as_str()), "unexpected field {k} in {f}");
            }
            for leak in ["C:/", "hash", "align", ".png", ".mp3", "karaoke"] {
                assert!(!f.contains(leak), "{leak} leaked: {f}");
            }
        }
    }

    #[test]
    fn party_ids_are_stable_within_a_party_and_differ_between_parties() {
        let songs = vec![song(1, "A", true), song(2, "B", true)];
        let a = listing(&songs, &|_| vec![], "party-1");
        let b = listing(&songs, &|_| vec![], "party-1");
        let c = listing(&songs, &|_| vec![], "party-2");
        assert_eq!(a.songs[0].id, b.songs[0].id);
        assert_ne!(a.songs[0].id, c.songs[0].id);
        assert!(a.songs[0].id.starts_with('s') && a.songs[0].id.len() == 11, "opaque: s + 10 hex");
        assert_eq!(a.db_id(&a.songs[1].id), Some(2));
    }

    #[test]
    fn request_rules() {
        let songs = vec![song(1, "A", true), song(2, "B", true)];
        let l = listing(&songs, &|_| vec![], "p");
        let a = l.party_id(1).unwrap().to_string();
        let ready = |_: i64| true;
        let q = vec![entry(10, &songs[0], Some("g1")), entry(11, &songs[1], Some("g1"))];
        assert_eq!(check_request(&l, "s0000000000", "g1", &[], None, 2, &ready), Err(RefuseCode::UnknownSong));
        assert_eq!(check_request(&l, &a, "g2", &q, None, 2, &ready), Ok(1));
        assert_eq!(check_request(&l, &a, "g1", &q, None, 2, &ready), Err(RefuseCode::Limit));
        // The one on the Stage doesn't count as waiting.
        assert_eq!(check_request(&l, &a, "g1", &q, Some(10), 2, &ready), Ok(1));
        assert_eq!(check_request(&l, &a, "g2", &q, None, 2, &|_| false), Err(RefuseCode::NotReady));
    }

    #[test]
    fn frames_round_trip_and_carry_the_version() {
        let f = encode(&AppMsg::RequestResult { req: "r1".into(), ok: false, code: Some(RefuseCode::Limit) });
        assert_eq!(f, r#"{"code":"limit","ok":false,"req":"r1","t":"request_result","v":1}"#);
        assert_eq!(encode(&AppMsg::NewCode), r#"{"t":"new_code","v":1}"#);
        let room = r#"{"v":1,"t":"room","room":"r","secret":"s","joinUrl":"https://party.baritoad.com/j/r/k"}"#;
        assert_eq!(
            decode(room),
            Ok(Some(RelayMsg::Room { room: "r".into(), secret: "s".into(), join_url: "https://party.baritoad.com/j/r/k".into() }))
        );
        assert_eq!(decode(r#"{"v":1,"t":"something_new","x":1}"#), Ok(None), "unknown types are ignored");
        assert_eq!(decode(r#"{"v":2,"t":"room"}"#), Err(DecodeError::Version(2)));
        assert_eq!(decode("not json"), Err(DecodeError::Malformed));
    }

    #[test]
    fn names_and_toads() {
        assert_eq!(clean_name("  Cassie \t  B. "), Some("Cassie B.".into()));
        assert_eq!(clean_name("a really long name indeed"), Some("a really long".into()));
        assert_eq!(clean_name(" \u{0007} "), None);
        assert!(Toad::default().valid());
        assert!(!Toad { face: "sing".into(), colour: "red".into(), hat: "none".into() }.valid());
    }
}
