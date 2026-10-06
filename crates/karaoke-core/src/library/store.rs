//! SQLite-backed library store: songs, collections, up-next queue, settings.
//!
//! Schema history is forward-only ([`MIGRATIONS`]); `PRAGMA user_version`
//! records how far a database has migrated. Every connection runs with
//! foreign keys ON so collection membership and queue entries follow song
//! deletion automatically.

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

/// Forward-only migration batches; index i migrates a DB at `user_version` i
/// to i+1. Never edit a shipped entry — append a new one.
const MIGRATIONS: &[&str] = &[
    // v0 -> v1: initial schema.
    "
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
    ",
    // v1 -> v2: review state ("Preview & fix"). NULL =
    // never reviewed; set to unix seconds when the user confirms "Looks
    // good" (or saves fixes). Cleared on re-generate — new timings need a
    // fresh look (see upsert_song).
    "
    ALTER TABLE songs ADD COLUMN reviewed_at INTEGER;
    ",
    // v2 -> v3: categories. Year and genre come from the audio file's tags,
    // an UltraStar header, or the user (Song › Properties); pace is words
    // per minute while singing, from our own timing map (stats.rs).
    // meta_version marks rows whose computed facts are current — older rows
    // are backfilled once (library::compute_meta).
    "
    ALTER TABLE songs ADD COLUMN year INTEGER;
    ALTER TABLE songs ADD COLUMN genre TEXT;
    ALTER TABLE songs ADD COLUMN pace_wpm REAL;
    ALTER TABLE songs ADD COLUMN meta_version INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX idx_songs_year  ON songs(year);
    CREATE INDEX idx_songs_genre ON songs(genre);
    ",
    // v3 -> v4: a cover the person picked (Song › Properties) — a re-import
    // must not swap it back for the file's embedded art (see upsert_song).
    "
    ALTER TABLE songs ADD COLUMN cover_by_user INTEGER NOT NULL DEFAULT 0;
    ",
    // v4 -> v5: who's singing each queue entry (party mode, docs/PARTY.md):
    // a display name, a toad (JSON: face, colour, hat) and the party guest
    // who picked it (a per-party id) — all NULL for songs the host queued.
    "
    ALTER TABLE queue ADD COLUMN singer TEXT;
    ALTER TABLE queue ADD COLUMN toad TEXT;
    ALTER TABLE queue ADD COLUMN guest TEXT;
    ",
];

pub const SCHEMA_VERSION: i64 = MIGRATIONS.len() as i64;

/// `%LOCALAPPDATA%\baritoad\library.db` (macOS: `~/Library/Application Support/baritoad/`; see `paths`).
pub fn default_library_path() -> PathBuf {
    data_dir().join("library.db")
}

/// `%LOCALAPPDATA%\baritoad\covers` — extracted embedded cover art,
/// hash-named (see [`super::tags::save_cover`]).
pub fn default_covers_dir() -> PathBuf {
    data_dir().join("covers")
}

fn data_dir() -> PathBuf {
    crate::paths::data_dir()
}

// ---------------------------------------------------------------------------
// row types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Song {
    pub id: i64,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub audio_path: PathBuf,
    pub audio_hash: String,
    pub job_dir: PathBuf,
    pub timing_map_path: Option<PathBuf>,
    pub vocals_path: Option<PathBuf>,
    pub instrumental_path: Option<PathBuf>,
    pub duration_s: Option<f64>,
    pub cover_path: Option<PathBuf>,
    /// "pasted" | "transcribed" (mirrors the timing map's lyric_source).
    pub lyric_source: Option<String>,
    pub language_tag: String,
    pub date_added: i64,
    pub last_played: Option<i64>,
    pub play_count: i64,
    /// Unix seconds when the user confirmed the preview ("Looks good") or
    /// saved timing fixes; `None` = awaiting review.
    pub reviewed_at: Option<i64>,
    /// Release year (tags, UltraStar header, or the user).
    pub year: Option<i32>,
    pub genre: Option<String>,
    /// Words per minute while singing ([`super::stats::singing_pace`]).
    pub pace_wpm: Option<f64>,
}

/// What a person edits in Song › Properties.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SongDetails {
    pub title: String,
    #[serde(default)]
    pub artist: Option<String>,
    #[serde(default)]
    pub year: Option<i32>,
    #[serde(default)]
    pub genre: Option<String>,
    /// None keeps the current language.
    #[serde(default)]
    pub language_tag: Option<String>,
}

/// Input to [`LibraryStore::upsert_song`]. Identity is `audio_hash`.
#[derive(Debug, Clone, Default)]
pub struct SongUpsert {
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub audio_path: PathBuf,
    pub audio_hash: String,
    pub job_dir: PathBuf,
    pub timing_map_path: Option<PathBuf>,
    pub vocals_path: Option<PathBuf>,
    pub instrumental_path: Option<PathBuf>,
    pub duration_s: Option<f64>,
    /// `None` keeps an existing cover on re-generate (covers survive a run
    /// whose source file lost its embedded art).
    pub cover_path: Option<PathBuf>,
    pub lyric_source: Option<String>,
    /// `None` ⇒ 'en' on insert, keep existing on update.
    pub language_tag: Option<String>,
    /// Year / genre: on update an existing value wins (it may be the user's
    /// edit); these only fill blanks.
    pub year: Option<i32>,
    pub genre: Option<String>,
    /// Replaces the stored pace when supplied (new timings, new pace).
    pub pace_wpm: Option<f64>,
    /// [`super::stats::META_VERSION`] when the caller computed the facts.
    pub meta_version: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionInfo {
    pub id: i64,
    pub name: String,
    pub created: i64,
    pub song_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueueEntry {
    pub id: i64,
    pub position: i64,
    pub added_from_collection: Option<i64>,
    pub song: Song,
    /// Who's singing it (party mode); None for the host's own picks.
    #[serde(default)]
    pub singer: Option<String>,
    #[serde(default)]
    pub toad: Option<crate::party::Toad>,
    /// The party guest who picked it (per-party id).
    #[serde(default)]
    pub guest: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SongSort {
    #[default]
    RecentlyAdded,
    RecentlyPlayed,
    Title,
    /// Manual order within a collection (only meaningful with a collection
    /// filter; falls back to RecentlyAdded otherwise).
    CollectionOrder,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct SongQuery {
    /// Case-insensitive substring on title/artist, or exact language tag.
    pub search: Option<String>,
    #[serde(default)]
    pub sort: SongSort,
    /// Restrict to one collection.
    pub collection: Option<i64>,
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

pub struct LibraryStore {
    conn: Connection,
}

impl LibraryStore {
    /// Open (creating and migrating as needed) the library at `path`.
    /// Parent directories are created. Tests inject a temp path.
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }
        let conn = Connection::open(path)?;
        let mut store = Self { conn };
        store.init()?;
        Ok(store)
    }

    /// In-memory store (tests).
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        let mut store = Self { conn };
        store.init()?;
        Ok(store)
    }

    /// The app's per-user library ([`default_library_path`]).
    pub fn open_default() -> Result<Self> {
        Self::open(&default_library_path())
    }

    fn init(&mut self) -> Result<()> {
        self.conn.pragma_update(None, "foreign_keys", "ON")?;
        // WAL keeps the UI readable while the worker writes.
        let _ = self.conn.pragma_update(None, "journal_mode", "WAL");
        self.migrate()
    }

    fn migrate(&mut self) -> Result<()> {
        let mut version: i64 =
            self.conn
                .query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version > SCHEMA_VERSION {
            return Err(Error::Db(format!(
                "library db is schema v{version}, newer than this build (v{SCHEMA_VERSION}) — refusing to touch it"
            )));
        }
        while version < SCHEMA_VERSION {
            let tx = self.conn.transaction()?;
            tx.execute_batch(MIGRATIONS[version as usize])?;
            tx.pragma_update(None, "user_version", version + 1)?;
            tx.commit()?;
            version += 1;
        }
        Ok(())
    }

    pub fn schema_version(&self) -> Result<i64> {
        Ok(self.conn.query_row("PRAGMA user_version", [], |r| r.get(0))?)
    }

    // -- songs --------------------------------------------------------------

    /// Insert or update by `audio_hash`. On update: `date_added`,
    /// `play_count`, `last_played` are preserved; `cover_path` and
    /// `language_tag` are only overwritten when the upsert supplies one.
    /// `reviewed_at` is **cleared** on update — a re-generated song has new
    /// timings, so the golden-path preview runs again.
    pub fn upsert_song(&self, s: &SongUpsert) -> Result<Song> {
        if s.audio_hash.is_empty() {
            return Err(Error::InvalidInput("song upsert without audio_hash".into()));
        }
        self.conn.execute(
            "INSERT INTO songs (title, artist, album, audio_path, audio_hash, job_dir,
                                timing_map_path, vocals_path, instrumental_path, duration_s,
                                cover_path, lyric_source, language_tag, date_added,
                                year, genre, pace_wpm, meta_version)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                     COALESCE(?13, 'en'), ?14, ?15, ?16, ?17, ?18)
             ON CONFLICT(audio_hash) DO UPDATE SET
                 title = excluded.title,
                 artist = excluded.artist,
                 album = COALESCE(excluded.album, album),
                 audio_path = excluded.audio_path,
                 job_dir = excluded.job_dir,
                 timing_map_path = excluded.timing_map_path,
                 vocals_path = excluded.vocals_path,
                 instrumental_path = excluded.instrumental_path,
                 duration_s = COALESCE(excluded.duration_s, duration_s),
                 cover_path = CASE WHEN cover_by_user = 1 THEN cover_path ELSE COALESCE(?11, cover_path) END,
                 lyric_source = COALESCE(excluded.lyric_source, lyric_source),
                 language_tag = COALESCE(?13, language_tag),
                 year = COALESCE(year, excluded.year),
                 genre = COALESCE(genre, excluded.genre),
                 pace_wpm = COALESCE(excluded.pace_wpm, pace_wpm),
                 meta_version = MAX(meta_version, excluded.meta_version),
                 reviewed_at = NULL",
            params![
                s.title,
                s.artist,
                s.album,
                path_str(&s.audio_path),
                s.audio_hash,
                path_str(&s.job_dir),
                s.timing_map_path.as_deref().map(path_str),
                s.vocals_path.as_deref().map(path_str),
                s.instrumental_path.as_deref().map(path_str),
                s.duration_s,
                s.cover_path.as_deref().map(path_str),
                s.lyric_source,
                s.language_tag,
                unix_now(),
                s.year,
                s.genre,
                s.pace_wpm,
                s.meta_version,
            ],
        )?;
        self.song_by_hash(&s.audio_hash)?
            .ok_or_else(|| Error::Db("upserted song not found by hash".into()))
    }

    pub fn song(&self, id: i64) -> Result<Option<Song>> {
        Ok(self
            .conn
            .query_row(&format!("{SONG_SELECT} WHERE id = ?1"), [id], song_from_row)
            .optional()?)
    }

    pub fn song_by_hash(&self, audio_hash: &str) -> Result<Option<Song>> {
        Ok(self
            .conn
            .query_row(
                &format!("{SONG_SELECT} WHERE audio_hash = ?1"),
                [audio_hash],
                song_from_row,
            )
            .optional()?)
    }

    /// Remove a song from the library (files on disk are untouched).
    /// Collection membership and queue entries cascade.
    pub fn delete_song(&self, id: i64) -> Result<bool> {
        let n = self.conn.execute("DELETE FROM songs WHERE id = ?1", [id])?;
        self.compact_queue()?;
        Ok(n > 0)
    }

    /// Song › Properties: title, artist, year, genre and (when given)
    /// language, as the person typed them. Blank text clears a field; the
    /// title may not be blank.
    pub fn update_song_details(&self, id: i64, d: &SongDetails) -> Result<Song> {
        let title = d.title.trim();
        if title.is_empty() {
            return Err(Error::InvalidInput("a song needs a title".into()));
        }
        let blank_none = |v: &Option<String>| v.as_deref().map(str::trim).filter(|t| !t.is_empty()).map(String::from);
        let n = self.conn.execute(
            "UPDATE songs SET title = ?2, artist = ?3, year = ?4, genre = ?5,
                              language_tag = COALESCE(?6, language_tag)
             WHERE id = ?1",
            params![
                id,
                title,
                blank_none(&d.artist),
                d.year,
                blank_none(&d.genre),
                blank_none(&d.language_tag),
            ],
        )?;
        if n == 0 {
            return Err(Error::InvalidInput(format!("no song {id}")));
        }
        self.song(id)?.ok_or_else(|| Error::Db(format!("song {id} vanished")))
    }

    /// Metadata an import brought (an UltraStar header's year, genre and
    /// language): each supplied value replaces the stored one.
    pub fn apply_imported_meta(
        &self,
        id: i64,
        year: Option<i32>,
        genre: Option<&str>,
        language_tag: Option<&str>,
    ) -> Result<()> {
        self.conn.execute(
            "UPDATE songs SET year = COALESCE(?2, year), genre = COALESCE(?3, genre),
                              language_tag = COALESCE(?4, language_tag)
             WHERE id = ?1",
            params![id, year, genre, language_tag],
        )?;
        Ok(())
    }

    /// Songs whose computed facts predate [`super::stats::META_VERSION`].
    pub fn songs_needing_meta(&self) -> Result<Vec<Song>> {
        let mut stmt = self
            .conn
            .prepare(&format!("{SONG_SELECT} WHERE s.meta_version < ?1 ORDER BY s.id"))?;
        let rows = stmt.query_map([super::stats::META_VERSION], song_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Store backfilled facts: year and genre only fill blanks (a person's
    /// edit wins); pace is replaced; the row is marked current.
    pub fn set_song_meta(&self, id: i64, year: Option<i32>, genre: Option<&str>, pace_wpm: Option<f64>) -> Result<()> {
        self.conn.execute(
            "UPDATE songs SET year = COALESCE(year, ?2), genre = COALESCE(genre, ?3),
                              pace_wpm = ?4, meta_version = ?5
             WHERE id = ?1",
            params![id, year, genre, pace_wpm, super::stats::META_VERSION],
        )?;
        Ok(())
    }

    /// Give a song cover art it doesn't have yet (a fetched song's thumbnail —
    /// art from the file's own tags, or set earlier, wins).
    pub fn set_cover_if_missing(&self, id: i64, cover_path: &Path) -> Result<()> {
        self.conn.execute(
            "UPDATE songs SET cover_path = ?2 WHERE id = ?1 AND cover_path IS NULL",
            params![id, path_str(cover_path)],
        )?;
        Ok(())
    }

    /// Song › Properties › Cover: the person's own picture replaces whatever
    /// the tags gave, and a later re-import keeps it (`cover_by_user`).
    /// `None` clears it and hands the cover back to the tags.
    pub fn set_cover(&self, id: i64, cover_path: Option<&Path>) -> Result<bool> {
        Ok(self.conn.execute(
            "UPDATE songs SET cover_path = ?2, cover_by_user = ?3 WHERE id = ?1",
            params![id, cover_path.map(path_str), cover_path.is_some()],
        )? > 0)
    }

    /// Set (or clear) the review timestamp — "Looks good" on the preview
    /// screen, or a timing-fix save.
    pub fn set_reviewed(&self, id: i64, reviewed: bool) -> Result<()> {
        let n = self.conn.execute(
            "UPDATE songs SET reviewed_at = ?2 WHERE id = ?1",
            params![id, if reviewed { Some(unix_now()) } else { None }],
        )?;
        if n == 0 {
            return Err(Error::InvalidInput(format!("no song {id}")));
        }
        Ok(())
    }

    pub fn record_played(&self, id: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE songs SET last_played = ?2, play_count = play_count + 1 WHERE id = ?1",
            params![id, unix_now()],
        )?;
        Ok(())
    }

    /// Search (title/artist LIKE, or exact language tag) + sort + optional
    /// collection filter.
    pub fn list_songs(&self, q: &SongQuery) -> Result<Vec<Song>> {
        let mut sql = String::new();
        let mut clauses: Vec<String> = Vec::new();
        let mut args: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        if let Some(cid) = q.collection {
            sql.push_str(&format!(
                "SELECT {SONG_COLS} FROM songs s
                 JOIN collection_songs cs ON cs.song_id = s.id"
            ));
            clauses.push(format!("cs.collection_id = ?{}", args.len() + 1));
            args.push(Box::new(cid));
        } else {
            sql.push_str(&format!("SELECT {SONG_COLS} FROM songs s"));
        }

        if let Some(term) = q.search.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
            let like = format!("%{}%", escape_like(term));
            let i = args.len() + 1;
            clauses.push(format!(
                "(s.title LIKE ?{i} ESCAPE '\\' OR s.artist LIKE ?{i} ESCAPE '\\' OR s.language_tag = ?{})",
                i + 1
            ));
            args.push(Box::new(like));
            args.push(Box::new(term.to_string()));
        }

        if !clauses.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&clauses.join(" AND "));
        }

        sql.push_str(match (q.sort, q.collection) {
            (SongSort::CollectionOrder, Some(_)) => " ORDER BY cs.position ASC, s.id ASC",
            (SongSort::RecentlyAdded, _) | (SongSort::CollectionOrder, None) => {
                " ORDER BY s.date_added DESC, s.id DESC"
            }
            (SongSort::RecentlyPlayed, _) => {
                " ORDER BY s.last_played IS NULL, s.last_played DESC, s.date_added DESC"
            }
            (SongSort::Title, _) => " ORDER BY s.title COLLATE NOCASE ASC",
        });

        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(
            rusqlite::params_from_iter(args.iter().map(|a| a.as_ref())),
            song_from_row,
        )?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    // -- collections ---------------------------------------------------------

    pub fn create_collection(&self, name: &str) -> Result<CollectionInfo> {
        let name = name.trim();
        if name.is_empty() {
            return Err(Error::InvalidInput("collection name is empty".into()));
        }
        self.conn.execute(
            "INSERT INTO collections (name, created) VALUES (?1, ?2)",
            params![name, unix_now()],
        )?;
        let id = self.conn.last_insert_rowid();
        Ok(CollectionInfo {
            id,
            name: name.to_string(),
            created: unix_now(),
            song_count: 0,
        })
    }

    pub fn rename_collection(&self, id: i64, name: &str) -> Result<()> {
        let name = name.trim();
        if name.is_empty() {
            return Err(Error::InvalidInput("collection name is empty".into()));
        }
        let n = self
            .conn
            .execute("UPDATE collections SET name = ?2 WHERE id = ?1", params![id, name])?;
        if n == 0 {
            return Err(Error::InvalidInput(format!("no collection {id}")));
        }
        Ok(())
    }

    /// Delete a collection; member songs stay in the library. Queue entries
    /// added from it keep playing (added_from_collection goes NULL).
    pub fn delete_collection(&self, id: i64) -> Result<bool> {
        Ok(self
            .conn
            .execute("DELETE FROM collections WHERE id = ?1", [id])?
            > 0)
    }

    /// Every song's collection names, by song id, in one query (party
    /// mode's song list).
    pub fn collection_names_by_song(&self) -> Result<std::collections::HashMap<i64, Vec<String>>> {
        let mut stmt = self.conn.prepare(
            "SELECT cs.song_id, c.name FROM collection_songs cs JOIN collections c ON c.id = cs.collection_id
             ORDER BY c.name COLLATE NOCASE",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
        let mut out: std::collections::HashMap<i64, Vec<String>> = std::collections::HashMap::new();
        for r in rows {
            let (song, name) = r?;
            out.entry(song).or_default().push(name);
        }
        Ok(out)
    }

    pub fn list_collections(&self) -> Result<Vec<CollectionInfo>> {
        let mut stmt = self.conn.prepare(
            "SELECT c.id, c.name, c.created,
                    (SELECT COUNT(*) FROM collection_songs cs WHERE cs.collection_id = c.id)
             FROM collections c ORDER BY c.name COLLATE NOCASE ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(CollectionInfo {
                id: r.get(0)?,
                name: r.get(1)?,
                created: r.get(2)?,
                song_count: r.get(3)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// Add a song to a collection (idempotent; appends at the end).
    pub fn add_to_collection(&self, collection_id: i64, song_id: i64) -> Result<()> {
        self.conn.execute(
            "INSERT OR IGNORE INTO collection_songs (collection_id, song_id, position)
             VALUES (?1, ?2,
                     (SELECT COALESCE(MAX(position) + 1, 0) FROM collection_songs
                      WHERE collection_id = ?1))",
            params![collection_id, song_id],
        )?;
        Ok(())
    }

    pub fn remove_from_collection(&self, collection_id: i64, song_id: i64) -> Result<bool> {
        Ok(self.conn.execute(
            "DELETE FROM collection_songs WHERE collection_id = ?1 AND song_id = ?2",
            params![collection_id, song_id],
        )? > 0)
    }

    /// Collection ids a song belongs to (for the "add to collection" menu).
    pub fn collections_of_song(&self, song_id: i64) -> Result<Vec<i64>> {
        let mut stmt = self
            .conn
            .prepare("SELECT collection_id FROM collection_songs WHERE song_id = ?1")?;
        let rows = stmt.query_map([song_id], |r| r.get(0))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    // -- up-next queue -------------------------------------------------------

    /// Queue contents, in play order. Positions are 0-based and dense.
    pub fn queue_list(&self) -> Result<Vec<QueueEntry>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT q.id, q.position, q.added_from_collection, q.singer, q.toad, q.guest, {SONG_COLS}
             FROM queue q JOIN songs s ON s.id = q.song_id
             ORDER BY q.position ASC"
        ))?;
        let rows = stmt.query_map([], |r| {
            let toad: Option<String> = r.get(4)?;
            Ok(QueueEntry {
                id: r.get(0)?,
                position: r.get(1)?,
                added_from_collection: r.get(2)?,
                singer: r.get(3)?,
                toad: toad.and_then(|t| serde_json::from_str(&t).ok()),
                guest: r.get(5)?,
                song: song_from_row_offset(r, 6)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// Append a song (the same song may appear multiple times — parties
    /// repeat crowd-pleasers).
    pub fn queue_add(&self, song_id: i64, from_collection: Option<i64>) -> Result<QueueEntry> {
        self.conn.execute(
            "INSERT INTO queue (song_id, position, added_from_collection)
             VALUES (?1, (SELECT COALESCE(MAX(position) + 1, 0) FROM queue), ?2)",
            params![song_id, from_collection],
        )?;
        let id = self.conn.last_insert_rowid();
        let entries = self.queue_list()?;
        entries
            .into_iter()
            .find(|e| e.id == id)
            .ok_or_else(|| Error::Db("queued entry not found after insert".into()))
    }

    /// Append a party guest's pick, with who's singing it. Checking the pick
    /// (per-guest limit, song ready) is the caller's — `party::check_request`.
    pub fn queue_add_guest(&self, song_id: i64, singer: &str, toad: &crate::party::Toad, guest: &str) -> Result<QueueEntry> {
        let toad = serde_json::to_string(toad).map_err(|e| Error::Db(e.to_string()))?;
        self.conn.execute(
            "INSERT INTO queue (song_id, position, singer, toad, guest)
             VALUES (?1, (SELECT COALESCE(MAX(position) + 1, 0) FROM queue), ?2, ?3, ?4)",
            params![song_id, singer, toad, guest],
        )?;
        let id = self.conn.last_insert_rowid();
        self.queue_list()?
            .into_iter()
            .find(|e| e.id == id)
            .ok_or_else(|| Error::Db("queued entry not found after insert".into()))
    }

    /// Take out a party guest's entries (the host kicked them), except the
    /// one being sung, if any; returns how many went.
    pub fn queue_remove_guest(&self, guest: &str, keep: Option<i64>) -> Result<usize> {
        let n = self
            .conn
            .execute("DELETE FROM queue WHERE guest = ?1 AND id IS NOT ?2", params![guest, keep])?;
        self.compact_queue()?;
        Ok(n)
    }

    /// Append several songs in the given order (a whole collection, or a
    /// shuffle of one) in one transaction. Songs without timings can't be
    /// sung yet and are skipped; returns how many were queued.
    pub fn queue_add_many(&mut self, song_ids: &[i64], from_collection: Option<i64>) -> Result<usize> {
        let tx = self.conn.transaction()?;
        let mut added = 0;
        for &id in song_ids {
            added += tx.execute(
                "INSERT INTO queue (song_id, position, added_from_collection)
                 SELECT s.id, (SELECT COALESCE(MAX(position) + 1, 0) FROM queue), ?2
                 FROM songs s WHERE s.id = ?1 AND s.timing_map_path IS NOT NULL",
                params![id, from_collection],
            )?;
        }
        tx.commit()?;
        Ok(added)
    }

    pub fn queue_remove(&self, entry_id: i64) -> Result<bool> {
        let n = self
            .conn
            .execute("DELETE FROM queue WHERE id = ?1", [entry_id])?;
        self.compact_queue()?;
        Ok(n > 0)
    }

    /// Move an entry to `to_index` (0-based, clamped); the rest shift.
    pub fn queue_move(&mut self, entry_id: i64, to_index: usize) -> Result<()> {
        let tx = self.conn.transaction()?;
        let mut ids: Vec<i64> = {
            let mut stmt = tx.prepare("SELECT id FROM queue ORDER BY position ASC")?;
            let rows = stmt.query_map([], |r| r.get(0))?;
            let mut v = Vec::new();
            for r in rows {
                v.push(r?);
            }
            v
        };
        let Some(from) = ids.iter().position(|&i| i == entry_id) else {
            return Err(Error::InvalidInput(format!("no queue entry {entry_id}")));
        };
        let id = ids.remove(from);
        let to = to_index.min(ids.len());
        ids.insert(to, id);
        for (pos, id) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE queue SET position = ?2 WHERE id = ?1",
                params![id, pos as i64],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn queue_clear(&self) -> Result<()> {
        self.conn.execute("DELETE FROM queue", [])?;
        Ok(())
    }

    /// Rewrite positions dense 0..n after removals. (Rust-side: a correlated
    /// UPDATE subquery over the same table observes its own writes mid-scan.)
    fn compact_queue(&self) -> Result<()> {
        let ids: Vec<i64> = {
            let mut stmt = self
                .conn
                .prepare("SELECT id FROM queue ORDER BY position ASC, id ASC")?;
            let rows = stmt.query_map([], |r| r.get(0))?;
            let mut v = Vec::new();
            for r in rows {
                v.push(r?);
            }
            v
        };
        for (pos, id) in ids.iter().enumerate() {
            self.conn.execute(
                "UPDATE queue SET position = ?2 WHERE id = ?1 AND position <> ?2",
                params![id, pos as i64],
            )?;
        }
        Ok(())
    }

    // -- settings ------------------------------------------------------------

    pub fn setting(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
                r.get(0)
            })
            .optional()?)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const SONG_COLS: &str = "s.id, s.title, s.artist, s.album, s.audio_path, s.audio_hash, s.job_dir,
     s.timing_map_path, s.vocals_path, s.instrumental_path, s.duration_s, s.cover_path,
     s.lyric_source, s.language_tag, s.date_added, s.last_played, s.play_count, s.reviewed_at,
     s.year, s.genre, s.pace_wpm";

const SONG_SELECT: &str = "SELECT s.id, s.title, s.artist, s.album, s.audio_path, s.audio_hash, s.job_dir,
     s.timing_map_path, s.vocals_path, s.instrumental_path, s.duration_s, s.cover_path,
     s.lyric_source, s.language_tag, s.date_added, s.last_played, s.play_count, s.reviewed_at,
     s.year, s.genre, s.pace_wpm
     FROM songs s";

fn song_from_row(r: &Row<'_>) -> rusqlite::Result<Song> {
    song_from_row_offset(r, 0)
}

fn song_from_row_offset(r: &Row<'_>, o: usize) -> rusqlite::Result<Song> {
    Ok(Song {
        id: r.get(o)?,
        title: r.get(o + 1)?,
        artist: r.get(o + 2)?,
        album: r.get(o + 3)?,
        audio_path: PathBuf::from(r.get::<_, String>(o + 4)?),
        audio_hash: r.get(o + 5)?,
        job_dir: PathBuf::from(r.get::<_, String>(o + 6)?),
        timing_map_path: r.get::<_, Option<String>>(o + 7)?.map(PathBuf::from),
        vocals_path: r.get::<_, Option<String>>(o + 8)?.map(PathBuf::from),
        instrumental_path: r.get::<_, Option<String>>(o + 9)?.map(PathBuf::from),
        duration_s: r.get(o + 10)?,
        cover_path: r.get::<_, Option<String>>(o + 11)?.map(PathBuf::from),
        lyric_source: r.get(o + 12)?,
        language_tag: r.get(o + 13)?,
        date_added: r.get(o + 14)?,
        last_played: r.get(o + 15)?,
        play_count: r.get(o + 16)?,
        reviewed_at: r.get(o + 17)?,
        year: r.get(o + 18)?,
        genre: r.get(o + 19)?,
        pace_wpm: r.get(o + 20)?,
    })
}

fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// Escape `%`/`_`/`\` for a LIKE pattern with `ESCAPE '\'`.
fn escape_like(term: &str) -> String {
    let mut out = String::with_capacity(term.len());
    for c in term.chars() {
        if c == '%' || c == '_' || c == '\\' {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
