//! Library store: SQLite — songs, collections, queue.
//!
//! Lives in karaoke-core (not the app crate) so the CLI can grow library
//! commands later. SQLite via rusqlite with the `bundled` feature — SQLite is
//! public domain and compiling it in avoids a system dependency
//! (docs/DEPENDENCIES.md).
//!
//! Design points:
//! - **Path-injectable store** ([`LibraryStore::open`]) so tests run against a
//!   temp DB; the app uses [`default_library_path`]
//!   (`%LOCALAPPDATA%\baritoad\library.db`).
//! - **Versioned forward-only migrations** via `PRAGMA user_version`.
//! - **Songs are identified by `audio_hash`** (the pipeline manifest's sha256
//!   of the audio file), so re-generating a song *updates* its row instead of
//!   duplicating it ([`LibraryStore::upsert_song`]).
//! - **Collections are just names** — a song can live in any number of them;
//!   singer profiles are collections, so there is no account system.
//! - **The up-next queue persists in the DB** so it survives app restarts
//!   mid-party. Playing is Phase 3; v1 milestone 2 only manages order.
//! - Metadata comes from the audio file's tags ([`tags`]) or the user —
//!   never from the network (local-first).

pub mod register;
pub mod stats;
pub mod store;
pub mod tags;

pub use register::register_completed_job;
pub use store::{
    default_covers_dir, default_library_path, CollectionInfo, LibraryStore, QueueEntry, Song,
    SongDetails, SongQuery, SongSort, SongUpsert,
};
pub use tags::{read_tags, save_cover, CoverArt, FileTags};

/// Facts a library row carries beyond what the user typed.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SongMeta {
    pub year: Option<i32>,
    pub genre: Option<String>,
    pub pace_wpm: Option<f64>,
}

/// Recompute a song's facts from its files (tags + timing map) — the
/// backfill for rows older than [`stats::META_VERSION`]. Reads files only;
/// the caller stores the result ([`LibraryStore::set_song_meta`]) so a
/// store lock needn't be held during the I/O.
pub fn compute_meta(song: &Song) -> SongMeta {
    let tags = read_tags(&song.audio_path).unwrap_or_default();
    let pace_wpm = song
        .timing_map_path
        .as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|raw| crate::timing::WordTimingMap::from_json(&raw).ok())
        .and_then(|map| stats::singing_pace(&map));
    SongMeta {
        year: tags.year,
        genre: tags.genre,
        pace_wpm,
    }
}
