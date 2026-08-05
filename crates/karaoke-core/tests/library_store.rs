//! Library store tests — temp-DB (path-injected) coverage of migrations,
//! CRUD, search/sort, collections m2m, queue ordering/persistence, and the
//! idempotent completion→library registration hook.

use std::path::{Path, PathBuf};

use karaoke_core::library::{
    register_completed_job, LibraryStore, SongQuery, SongSort, SongUpsert,
};
use karaoke_core::pipeline::manifest::{Artifact, InputRef, JobManifest, StageId};
use karaoke_core::timing::{LyricSource, WordTiming, WordTimingMap};

fn tmp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "karaoke-library-test-{tag}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn upsert(hash: &str, title: &str, artist: Option<&str>) -> SongUpsert {
    SongUpsert {
        title: title.into(),
        artist: artist.map(String::from),
        audio_path: PathBuf::from(format!("C:/music/{title}.mp3")),
        audio_hash: hash.into(),
        job_dir: PathBuf::from(format!("C:/music/{title}-karaoke")),
        ..SongUpsert::default()
    }
}

// ---------------------------------------------------------------------------
// migrations
// ---------------------------------------------------------------------------

#[test]
fn migrations_run_once_and_reopen_is_stable() {
    let dir = tmp_dir("migrate");
    let db = dir.join("library.db");
    {
        let store = LibraryStore::open(&db).unwrap();
        assert_eq!(store.schema_version().unwrap(), 2);
        store.upsert_song(&upsert("h1", "First", None)).unwrap();
    }
    // Re-open: schema stays, data stays, no re-migration damage.
    let store = LibraryStore::open(&db).unwrap();
    assert_eq!(store.schema_version().unwrap(), 2);
    let songs = store.list_songs(&SongQuery::default()).unwrap();
    assert_eq!(songs.len(), 1);
    assert_eq!(songs[0].title, "First");
    let _ = std::fs::remove_dir_all(&dir);
}

/// The v1 schema exactly as milestone 2 shipped it — frozen here so the
/// v1→v2 upgrade path is tested against a real v1 database forever, not
/// against whatever MIGRATIONS[0] currently says.
const SHIPPED_V1_SCHEMA: &str = "
    CREATE TABLE songs (
        id               INTEGER PRIMARY KEY,
        title            TEXT NOT NULL,
        artist           TEXT,
        album            TEXT,
        audio_path       TEXT NOT NULL,
        audio_hash       TEXT NOT NULL UNIQUE,
        job_dir          TEXT NOT NULL,
        timing_map_path  TEXT,
        vocals_path      TEXT,
        instrumental_path TEXT,
        duration_s       REAL,
        cover_path       TEXT,
        lyric_source     TEXT,
        language_tag     TEXT NOT NULL DEFAULT 'en',
        date_added       INTEGER NOT NULL,
        last_played      INTEGER,
        play_count       INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_songs_title  ON songs(title);
    CREATE INDEX idx_songs_artist ON songs(artist);
    CREATE TABLE collections (
        id      INTEGER PRIMARY KEY,
        name    TEXT NOT NULL UNIQUE,
        created INTEGER NOT NULL
    );
    CREATE TABLE collection_songs (
        collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
        song_id       INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
        position      INTEGER NOT NULL,
        PRIMARY KEY (collection_id, song_id)
    );
    CREATE TABLE queue (
        id                    INTEGER PRIMARY KEY,
        song_id               INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
        position              INTEGER NOT NULL,
        added_from_collection INTEGER REFERENCES collections(id) ON DELETE SET NULL
    );
    CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
";

#[test]
fn v1_database_upgrades_to_v2_preserving_rows() {
    let dir = tmp_dir("v1-upgrade");
    let db = dir.join("library.db");
    {
        // Build a genuine v1 database with data in every table.
        let conn = rusqlite_open(&db);
        conn.execute_batch(SHIPPED_V1_SCHEMA).unwrap();
        conn.execute_batch(
            "INSERT INTO songs (title, artist, audio_path, audio_hash, job_dir, date_added, play_count)
             VALUES ('Old Song', 'Old Artist', 'C:/music/old.mp3', 'v1hash', 'C:/music/old-karaoke', 1700000000, 3);
             INSERT INTO collections (name, created) VALUES ('Party', 1700000001);
             INSERT INTO collection_songs (collection_id, song_id, position) VALUES (1, 1, 0);
             INSERT INTO queue (song_id, position) VALUES (1, 0);
             INSERT INTO settings (key, value) VALUES ('k', 'v');",
        )
        .unwrap();
        conn.pragma_update(None, "user_version", 1).unwrap();
    }

    let store = LibraryStore::open(&db).unwrap();
    assert_eq!(store.schema_version().unwrap(), 2);

    // Every v1 row survives; the new column reads as NULL (never reviewed).
    let songs = store.list_songs(&SongQuery::default()).unwrap();
    assert_eq!(songs.len(), 1);
    let s = &songs[0];
    assert_eq!(s.title, "Old Song");
    assert_eq!(s.artist.as_deref(), Some("Old Artist"));
    assert_eq!(s.audio_hash, "v1hash");
    assert_eq!(s.play_count, 3);
    assert_eq!(s.date_added, 1700000000);
    assert_eq!(s.reviewed_at, None, "pre-v2 songs start un-reviewed");
    let colls = store.list_collections().unwrap();
    assert_eq!(colls.len(), 1);
    assert_eq!(colls[0].song_count, 1);
    assert_eq!(store.queue_list().unwrap().len(), 1);
    assert_eq!(store.setting("k").unwrap().as_deref(), Some("v"));

    // The new review API works on the migrated row.
    store.set_reviewed(s.id, true).unwrap();
    let after = store.song(s.id).unwrap().unwrap();
    assert!(after.reviewed_at.is_some());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn reviewed_at_set_clear_and_reset_on_regenerate() {
    let store = LibraryStore::open_in_memory().unwrap();
    let s = store.upsert_song(&upsert("h-rev", "Song", None)).unwrap();
    assert_eq!(s.reviewed_at, None);

    store.set_reviewed(s.id, true).unwrap();
    assert!(store.song(s.id).unwrap().unwrap().reviewed_at.is_some());

    store.set_reviewed(s.id, false).unwrap();
    assert_eq!(store.song(s.id).unwrap().unwrap().reviewed_at, None);

    // Reviewed, then re-generated: the fresh timings need a fresh look.
    store.set_reviewed(s.id, true).unwrap();
    let again = store.upsert_song(&upsert("h-rev", "Song v2", None)).unwrap();
    assert_eq!(again.id, s.id);
    assert_eq!(again.reviewed_at, None, "regenerate clears review state");

    // Unknown id is an error, not a silent no-op.
    assert!(store.set_reviewed(9999, true).is_err());
}

#[test]
fn newer_schema_is_refused_not_clobbered() {
    let dir = tmp_dir("newer");
    let db = dir.join("library.db");
    LibraryStore::open(&db).unwrap();
    // Simulate a future build having migrated further.
    let conn = rusqlite_open(&db);
    conn.pragma_update(None, "user_version", 99).unwrap();
    drop(conn);
    let err = match LibraryStore::open(&db) {
        Ok(_) => panic!("opening a newer-schema db must fail"),
        Err(e) => e,
    };
    assert!(err.to_string().contains("newer"), "got: {err}");
    let _ = std::fs::remove_dir_all(&dir);
}

// rusqlite is a dev-visible dependency of karaoke-core itself; open directly
// to poke pragmas the store API deliberately doesn't expose.
fn rusqlite_open(path: &Path) -> rusqlite::Connection {
    rusqlite::Connection::open(path).unwrap()
}

// ---------------------------------------------------------------------------
// songs: CRUD + idempotent upsert + search + sort
// ---------------------------------------------------------------------------

#[test]
fn upsert_is_idempotent_by_audio_hash() {
    let store = LibraryStore::open_in_memory().unwrap();
    let a = store.upsert_song(&upsert("hash-a", "Original Title", None)).unwrap();

    // Same hash, regenerated with better metadata: updates, no duplicate.
    let mut again = upsert("hash-a", "Fixed Title", Some("The Band"));
    again.duration_s = Some(94.0);
    let b = store.upsert_song(&again).unwrap();

    assert_eq!(a.id, b.id, "regenerating must update, not duplicate");
    assert_eq!(b.title, "Fixed Title");
    assert_eq!(b.artist.as_deref(), Some("The Band"));
    assert_eq!(b.duration_s, Some(94.0));
    assert_eq!(b.date_added, a.date_added, "date_added survives update");
    assert_eq!(store.list_songs(&SongQuery::default()).unwrap().len(), 1);

    // Fields the update didn't supply are kept (cover, duration).
    let mut sparse = upsert("hash-a", "Fixed Title", Some("The Band"));
    sparse.duration_s = None;
    let c = store.upsert_song(&sparse).unwrap();
    assert_eq!(c.duration_s, Some(94.0), "None duration keeps the old value");
}

#[test]
fn get_delete_and_played_counters() {
    let store = LibraryStore::open_in_memory().unwrap();
    let s = store.upsert_song(&upsert("h", "Song", None)).unwrap();
    assert_eq!(s.play_count, 0);
    assert_eq!(s.language_tag, "en", "English-first default (PLAN.md §1)");

    store.record_played(s.id).unwrap();
    store.record_played(s.id).unwrap();
    let s2 = store.song(s.id).unwrap().unwrap();
    assert_eq!(s2.play_count, 2);
    assert!(s2.last_played.is_some());

    assert!(store.delete_song(s.id).unwrap());
    assert!(store.song(s.id).unwrap().is_none());
    assert!(!store.delete_song(s.id).unwrap(), "double delete is false");
}

#[test]
fn search_matches_title_artist_like_and_exact_tag() {
    let store = LibraryStore::open_in_memory().unwrap();
    store.upsert_song(&upsert("h1", "Dancing On My Own", Some("Robyn"))).unwrap();
    store.upsert_song(&upsert("h2", "Dance The Night", Some("Dua Lipa"))).unwrap();
    store.upsert_song(&upsert("h3", "Halo", Some("Beyoncé"))).unwrap();

    let q = |s: &str| SongQuery {
        search: Some(s.into()),
        ..SongQuery::default()
    };
    // title substring, case-insensitive (SQLite LIKE is ASCII-case-blind)
    assert_eq!(store.list_songs(&q("danc")).unwrap().len(), 2);
    // artist substring
    let by_artist = store.list_songs(&q("robyn")).unwrap();
    assert_eq!(by_artist.len(), 1);
    assert_eq!(by_artist[0].title, "Dancing On My Own");
    // exact language tag
    assert_eq!(store.list_songs(&q("en")).unwrap().len(), 3);
    // LIKE metacharacters are literal, not wildcards
    assert_eq!(store.list_songs(&q("100%")).unwrap().len(), 0);
    assert_eq!(store.list_songs(&q("_")).unwrap().len(), 0);
    // no match
    assert_eq!(store.list_songs(&q("zzz")).unwrap().len(), 0);
}

#[test]
fn sort_orders_recently_added_played_title() {
    let store = LibraryStore::open_in_memory().unwrap();
    let a = store.upsert_song(&upsert("h1", "Bravo", None)).unwrap();
    let b = store.upsert_song(&upsert("h2", "alpha", None)).unwrap();
    let c = store.upsert_song(&upsert("h3", "Charlie", None)).unwrap();

    // Title: case-insensitive alphabetical.
    let titles: Vec<String> = store
        .list_songs(&SongQuery { sort: SongSort::Title, ..SongQuery::default() })
        .unwrap()
        .into_iter()
        .map(|s| s.title)
        .collect();
    assert_eq!(titles, vec!["alpha", "Bravo", "Charlie"]);

    // Recently played: played songs first (most recent first), never-played after.
    store.record_played(a.id).unwrap();
    let played: Vec<i64> = store
        .list_songs(&SongQuery { sort: SongSort::RecentlyPlayed, ..SongQuery::default() })
        .unwrap()
        .into_iter()
        .map(|s| s.id)
        .collect();
    assert_eq!(played[0], a.id);
    assert!(played.contains(&b.id) && played.contains(&c.id));

    // Recently added: same-second inserts fall back to id DESC (insert order).
    let added: Vec<i64> = store
        .list_songs(&SongQuery::default())
        .unwrap()
        .into_iter()
        .map(|s| s.id)
        .collect();
    assert_eq!(added, vec![c.id, b.id, a.id]);
}

// ---------------------------------------------------------------------------
// collections (m2m — PLAN.md §3: a song lives in any number of collections)
// ---------------------------------------------------------------------------

#[test]
fn collections_many_to_many_and_cascade() {
    let store = LibraryStore::open_in_memory().unwrap();
    let s1 = store.upsert_song(&upsert("h1", "One", None)).unwrap();
    let s2 = store.upsert_song(&upsert("h2", "Two", None)).unwrap();

    let cassie = store.create_collection("Cassie's hits").unwrap();
    let party = store.create_collection("Christmas party").unwrap();

    // duplicate name refused
    assert!(store.create_collection("Cassie's hits").is_err());

    // s1 in both collections; s2 in one (m2m)
    store.add_to_collection(cassie.id, s1.id).unwrap();
    store.add_to_collection(party.id, s1.id).unwrap();
    store.add_to_collection(party.id, s2.id).unwrap();
    // idempotent add
    store.add_to_collection(party.id, s1.id).unwrap();

    let mut of_s1 = store.collections_of_song(s1.id).unwrap();
    of_s1.sort();
    assert_eq!(of_s1, vec![cassie.id, party.id]);

    let listed = store.list_collections().unwrap();
    assert_eq!(listed.len(), 2);
    let party_info = listed.iter().find(|c| c.id == party.id).unwrap();
    assert_eq!(party_info.song_count, 2);

    // collection filter + manual order (insert order here)
    let in_party = store
        .list_songs(&SongQuery {
            collection: Some(party.id),
            sort: SongSort::CollectionOrder,
            ..SongQuery::default()
        })
        .unwrap();
    assert_eq!(
        in_party.iter().map(|s| s.id).collect::<Vec<_>>(),
        vec![s1.id, s2.id]
    );

    // removing a song from one collection leaves the other
    assert!(store.remove_from_collection(cassie.id, s1.id).unwrap());
    assert_eq!(store.collections_of_song(s1.id).unwrap(), vec![party.id]);

    // rename + delete; songs survive collection deletion
    store.rename_collection(party.id, "NYE party").unwrap();
    assert!(store.delete_collection(party.id).unwrap());
    assert_eq!(store.list_songs(&SongQuery::default()).unwrap().len(), 2);
    assert!(store.collections_of_song(s1.id).unwrap().is_empty());

    // deleting a song removes it from its collections
    let c3 = store.create_collection("c3").unwrap();
    store.add_to_collection(c3.id, s2.id).unwrap();
    store.delete_song(s2.id).unwrap();
    assert_eq!(store.list_collections().unwrap()[0].song_count, 0);
}

// ---------------------------------------------------------------------------
// up-next queue (PLAN.md §3: survives restarts mid-party)
// ---------------------------------------------------------------------------

#[test]
fn queue_ordering_move_remove_and_duplicates() {
    let mut store = LibraryStore::open_in_memory().unwrap();
    let s1 = store.upsert_song(&upsert("h1", "One", None)).unwrap();
    let s2 = store.upsert_song(&upsert("h2", "Two", None)).unwrap();
    let s3 = store.upsert_song(&upsert("h3", "Three", None)).unwrap();

    let e1 = store.queue_add(s1.id, None).unwrap();
    let e2 = store.queue_add(s2.id, None).unwrap();
    let e3 = store.queue_add(s3.id, None).unwrap();
    // same song twice is allowed (parties repeat crowd-pleasers)
    let e4 = store.queue_add(s1.id, None).unwrap();

    let order = |store: &LibraryStore| -> Vec<i64> {
        store.queue_list().unwrap().into_iter().map(|e| e.id).collect()
    };
    assert_eq!(order(&store), vec![e1.id, e2.id, e3.id, e4.id]);

    // move last to front
    store.queue_move(e4.id, 0).unwrap();
    assert_eq!(order(&store), vec![e4.id, e1.id, e2.id, e3.id]);

    // move front into the middle
    store.queue_move(e4.id, 2).unwrap();
    assert_eq!(order(&store), vec![e1.id, e2.id, e4.id, e3.id]);

    // out-of-range index clamps to the end
    store.queue_move(e1.id, 99).unwrap();
    assert_eq!(order(&store), vec![e2.id, e4.id, e3.id, e1.id]);

    // remove compacts positions
    assert!(store.queue_remove(e4.id).unwrap());
    let entries = store.queue_list().unwrap();
    assert_eq!(
        entries.iter().map(|e| e.position).collect::<Vec<_>>(),
        vec![0, 1, 2]
    );

    // unknown entry
    assert!(store.queue_move(9999, 0).is_err());
    assert!(!store.queue_remove(9999).unwrap());

    store.queue_clear().unwrap();
    assert!(store.queue_list().unwrap().is_empty());
}

#[test]
fn queue_persists_across_reopen_mid_party() {
    let dir = tmp_dir("queue-persist");
    let db = dir.join("library.db");
    let (id1, id2);
    {
        let store = LibraryStore::open(&db).unwrap();
        let s1 = store.upsert_song(&upsert("h1", "One", None)).unwrap();
        let s2 = store.upsert_song(&upsert("h2", "Two", None)).unwrap();
        let coll = store.create_collection("party").unwrap();
        store.add_to_collection(coll.id, s2.id).unwrap();
        id1 = store.queue_add(s1.id, None).unwrap().id;
        id2 = store.queue_add(s2.id, Some(coll.id)).unwrap().id;
    } // app "crashes" mid-party
    let store = LibraryStore::open(&db).unwrap();
    let entries = store.queue_list().unwrap();
    assert_eq!(
        entries.iter().map(|e| e.id).collect::<Vec<_>>(),
        vec![id1, id2]
    );
    assert_eq!(entries[1].song.title, "Two");
    assert!(entries[1].added_from_collection.is_some());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn settings_roundtrip() {
    let store = LibraryStore::open_in_memory().unwrap();
    assert!(store.setting("sort").unwrap().is_none());
    store.set_setting("sort", "title").unwrap();
    store.set_setting("sort", "recently_added").unwrap();
    assert_eq!(store.setting("sort").unwrap().as_deref(), Some("recently_added"));
}

// ---------------------------------------------------------------------------
// completion → library registration hook (mocked pipeline outcome: a
// fabricated-but-valid manifest + timing map on disk, no ML inference)
// ---------------------------------------------------------------------------

fn fabricate_completed_job(dir: &Path, duration: f64) -> PathBuf {
    let out_dir = dir.join("song-karaoke");
    std::fs::create_dir_all(out_dir.join("stems")).unwrap();

    // "audio" file — arbitrary bytes; tags::read_tags will fail and that must
    // be tolerated (best-effort tag read).
    let audio = dir.join("song.mp3");
    std::fs::write(&audio, b"not really an mp3").unwrap();

    // stems
    let vocals = out_dir.join("stems").join("vocals.wav");
    let instrumental = out_dir.join("stems").join("instrumental.wav");
    std::fs::write(&vocals, b"v").unwrap();
    std::fs::write(&instrumental, b"i").unwrap();

    // timing map
    let map_path = out_dir.join("song.align.json");
    let mut map = WordTimingMap::new(
        duration,
        vec![WordTiming {
            word: "hello".into(),
            start: 1.0,
            end: 1.4,
            confidence: 0.9,
            anchored: true,
            unsung: false,
            line: Some(0),
            word_in_line: Some(0),
            ad_lib: false,
        }],
        vec![],
    );
    map.lyric_source = Some(LyricSource::Pasted);
    std::fs::write(&map_path, map.to_json_pretty().unwrap()).unwrap();

    // manifest with completed stages + artifacts
    let audio_ref = InputRef::from_file(&audio).unwrap();
    let mut man = JobManifest::new("testjob00000".into(), audio_ref, None, &out_dir);
    man.mark_in_flight(StageId::Separate, 1, "fp-sep");
    man.mark_complete(
        StageId::Separate,
        1,
        vec![
            Artifact { name: "vocals".into(), path: vocals, bytes: 1 },
            Artifact { name: "instrumental".into(), path: instrumental, bytes: 1 },
        ],
        1.0,
    );
    man.mark_not_applicable(StageId::CleanLyrics, 1, "fp-clean");
    man.mark_in_flight(StageId::Align, 1, "fp-align");
    let map_bytes = std::fs::metadata(&map_path).unwrap().len();
    man.mark_complete(
        StageId::Align,
        1,
        vec![Artifact { name: "map".into(), path: map_path, bytes: map_bytes }],
        1.0,
    );
    man.save_atomic(&JobManifest::manifest_path(&out_dir)).unwrap();
    out_dir
}

#[test]
fn register_completed_job_upserts_idempotently() {
    let dir = tmp_dir("register");
    let covers = dir.join("covers");
    let out_dir = fabricate_completed_job(&dir, 94.0);
    let store = LibraryStore::open_in_memory().unwrap();

    let song =
        register_completed_job(&store, &out_dir, &covers, "Back On My BS", Some("Artist X"))
            .unwrap();
    assert_eq!(song.title, "Back On My BS");
    assert_eq!(song.artist.as_deref(), Some("Artist X"));
    assert_eq!(song.duration_s, Some(94.0));
    assert_eq!(song.lyric_source.as_deref(), Some("pasted"));
    assert!(song.timing_map_path.is_some());
    assert!(song.vocals_path.as_ref().unwrap().ends_with("vocals.wav"));
    assert!(song
        .instrumental_path
        .as_ref()
        .unwrap()
        .ends_with("instrumental.wav"));
    assert!(!song.audio_hash.is_empty());
    assert_eq!(song.language_tag, "en");
    assert!(song.cover_path.is_none(), "fake mp3 has no readable cover");

    // Re-registering (user hit re-generate) updates the same row.
    let song2 =
        register_completed_job(&store, &out_dir, &covers, "Back On My BS (v2)", None).unwrap();
    assert_eq!(song2.id, song.id);
    assert_eq!(song2.title, "Back On My BS (v2)");
    assert_eq!(store.list_songs(&SongQuery::default()).unwrap().len(), 1);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn register_fails_cleanly_without_a_map() {
    let dir = tmp_dir("register-nomap");
    let out_dir = dir.join("half-job");
    std::fs::create_dir_all(&out_dir).unwrap();
    let audio = dir.join("a.mp3");
    std::fs::write(&audio, b"x").unwrap();
    let audio_ref = InputRef::from_file(&audio).unwrap();
    let mut man = JobManifest::new("halfjob00000".into(), audio_ref, None, &out_dir);
    man.save_atomic(&JobManifest::manifest_path(&out_dir)).unwrap();

    let store = LibraryStore::open_in_memory().unwrap();
    let err = register_completed_job(&store, &out_dir, &dir.join("covers"), "T", None).unwrap_err();
    assert!(err.to_string().contains("no timing map"), "got: {err}");
    assert!(store.list_songs(&SongQuery::default()).unwrap().is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}
