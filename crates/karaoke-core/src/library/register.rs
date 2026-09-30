//! Register a completed generate job in the library — the golden path's
//! "Keep" step (PLAN.md §4 step 6): on pipeline completion the song lands in
//! the library marked ready.
//!
//! Idempotent by `audio_hash` (the manifest's sha256 of the audio file):
//! re-generating a song updates its library row, never duplicates it.

use std::path::Path;

use crate::error::{Error, Result};
use crate::pipeline::manifest::{JobManifest, StageId};
use crate::timing::WordTimingMap;

use super::store::{LibraryStore, Song, SongUpsert};
use super::tags;

/// Read the completed job in `out_dir` (manifest + timing map) and upsert it
/// into the library. `title`/`artist` come from the caller (the wizard's
/// user-editable fields); the audio file's tags supply album art and album
/// name, and duration comes from the timing map.
///
/// Tag reading is best-effort — a file whose tags can't be read still
/// registers (album/cover stay empty).
pub fn register_completed_job(
    store: &LibraryStore,
    out_dir: &Path,
    covers_dir: &Path,
    title: &str,
    artist: Option<&str>,
) -> Result<Song> {
    let manifest_path = JobManifest::manifest_path(out_dir);
    let man = JobManifest::load(&manifest_path)?;

    let map_path = man
        .artifact_path(StageId::Align, "map")
        .ok_or_else(|| {
            Error::InvalidInput(format!(
                "job in {} has no timing map — not a completed job",
                out_dir.display()
            ))
        })?
        .to_path_buf();
    let map_raw = std::fs::read_to_string(&map_path)?;
    let map = WordTimingMap::from_json(&map_raw)?;

    let vocals = man
        .artifact_path(StageId::Separate, "vocals")
        .map(Path::to_path_buf);
    let instrumental = man
        .artifact_path(StageId::Separate, "instrumental")
        .map(Path::to_path_buf);

    // Best-effort tag read: cover art + album (title/artist are the caller's).
    let file_tags = tags::read_tags(&man.audio.path).unwrap_or_default();
    let cover_path = match &file_tags.cover {
        Some(c) => Some(tags::save_cover(c, covers_dir)?),
        None => None,
    };

    let lyric_source = map.lyric_source.map(|s| {
        match s {
            crate::timing::LyricSource::Pasted => "pasted",
            crate::timing::LyricSource::Transcribed => "transcribed",
            crate::timing::LyricSource::Imported => "imported",
        }
        .to_string()
    });

    store.upsert_song(&SongUpsert {
        title: title.to_string(),
        artist: artist.map(String::from),
        album: file_tags.album,
        audio_path: man.audio.path.clone(),
        audio_hash: man.audio.sha256.clone(),
        job_dir: out_dir.to_path_buf(),
        timing_map_path: Some(map_path),
        vocals_path: vocals,
        instrumental_path: instrumental,
        duration_s: Some(map.duration).filter(|d| *d > 0.0),
        cover_path,
        lyric_source,
        language_tag: None, // English-first v1 (PLAN.md §1): default 'en'
    })
}
