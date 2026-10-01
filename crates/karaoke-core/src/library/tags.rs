//! Audio-file tag reading via lofty (MIT OR Apache-2.0, §6): title / artist /
//! album / embedded cover art / duration, at import time.
//!
//! Local-first hard rule (PLAN.md §2, CLAUDE.md): metadata and artwork come
//! from the user's file only — there is no network fetch of any kind here.
//! When a file has no usable tags, callers fall back to filename parsing
//! (the wizard already does).

use std::path::{Path, PathBuf};

use lofty::file::TaggedFileExt;
use lofty::picture::{MimeType, PictureType};
use lofty::prelude::*;
use lofty::probe::read_from_path;

use crate::error::{Error, Result};
use crate::pipeline::hash;

/// Embedded cover art, as found in the file's tags.
#[derive(Debug, Clone)]
pub struct CoverArt {
    pub data: Vec<u8>,
    /// MIME as recorded in the tag ("image/jpeg", "image/png", …) when known.
    pub mime: Option<String>,
}

/// What the file's tags say. Every field optional — dirty files are normal.
#[derive(Debug, Clone, Default)]
pub struct FileTags {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    /// Release year (from a year or recording-date tag), when plausible.
    pub year: Option<i32>,
    /// Genre text; ID3v1 numeric codes ("(17)", "17") are dropped.
    pub genre: Option<String>,
    pub duration_s: Option<f64>,
    pub cover: Option<CoverArt>,
}

/// A genre tag worth showing: trimmed, not an ID3v1 numeric code.
pub fn clean_genre(raw: &str) -> Option<String> {
    let g = raw.trim();
    let numeric = g.trim_start_matches('(').trim_end_matches(')').chars().all(|c| c.is_ascii_digit());
    (!g.is_empty() && !numeric).then(|| g.to_string())
}

/// A year worth trusting (recordings, not typos).
pub fn plausible_year(y: i64) -> Option<i32> {
    (1900..=2100).contains(&y).then_some(y as i32)
}

/// Read tags + duration from an audio file. Errors only on unreadable /
/// unrecognized files; a readable file with no tags returns all-`None`.
pub fn read_tags(path: &Path) -> Result<FileTags> {
    let tagged = read_from_path(path)
        .map_err(|e| Error::Decode(format!("tag read {}: {e}", path.display())))?;

    let duration = tagged.properties().duration();
    let duration_s = if duration.as_secs_f64() > 0.0 {
        Some(duration.as_secs_f64())
    } else {
        None
    };

    let mut out = FileTags {
        duration_s,
        ..FileTags::default()
    };

    if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
        out.title = tag.title().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        out.artist = tag.artist().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        out.album = tag.album().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        out.year = tag.year().and_then(|y| plausible_year(y as i64));
        out.genre = tag.genre().and_then(|g| clean_genre(&g));

        // Prefer the designated front cover; otherwise take the first picture.
        let pics = tag.pictures();
        let pic = pics
            .iter()
            .find(|p| p.pic_type() == PictureType::CoverFront)
            .or_else(|| pics.first());
        if let Some(p) = pic {
            if !p.data().is_empty() {
                out.cover = Some(CoverArt {
                    data: p.data().to_vec(),
                    mime: p.mime_type().map(mime_str),
                });
            }
        }
    }
    Ok(out)
}

fn mime_str(m: &MimeType) -> String {
    m.as_str().to_string()
}

/// File extension for a cover's MIME type (fallback "img" keeps unknown
/// formats round-trippable — the bytes are what matter).
pub fn cover_extension(mime: Option<&str>) -> &'static str {
    match mime {
        Some("image/jpeg") | Some("image/jpg") => "jpg",
        Some("image/png") => "png",
        Some("image/gif") => "gif",
        Some("image/bmp") => "bmp",
        Some("image/tiff") => "tiff",
        Some("image/webp") => "webp",
        _ => "img",
    }
}

/// Write cover bytes into `covers_dir`, named by content hash (first 16 hex
/// chars of sha256) — identical art across songs/re-imports shares one file,
/// and re-import never duplicates. Returns the cover path.
pub fn save_cover(cover: &CoverArt, covers_dir: &Path) -> Result<PathBuf> {
    std::fs::create_dir_all(covers_dir)?;
    let digest = hash::sha256_hex(&cover.data);
    let name = format!("{}.{}", &digest[..16], cover_extension(cover.mime.as_deref()));
    let path = covers_dir.join(name);
    if !path.exists() {
        crate::pipeline::manifest::write_atomic(&path, &cover.data)?;
    }
    Ok(path)
}
