//! Library commands — the webview's surface over karaoke-core's SQLite
//! library store (PLAN.md §3 "Library & collections", §5 "library store").
//!
//! One [`LibraryHandle`] is managed at startup: the store behind a `Mutex`
//! (rusqlite connections are single-threaded) shared between commands and the
//! pipeline worker's completion hook. Everything here is local metadata —
//! cover art and tags come from the user's files, never the network
//! (CLAUDE.md hard rules).

use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Serialize;
use tauri::State;

use karaoke_core::library::{self, CollectionInfo, LibraryStore, QueueEntry, Song, SongQuery};

use crate::queue::meta_from_filename;

pub struct LibraryHandle {
    store: Mutex<LibraryStore>,
    covers_dir: PathBuf,
}

impl LibraryHandle {
    pub fn new(store: LibraryStore, covers_dir: PathBuf) -> Self {
        Self {
            store: Mutex::new(store),
            covers_dir,
        }
    }

    /// Open the per-user library (`%LOCALAPPDATA%\karaoke\library.db`).
    pub fn open_default() -> Result<Arc<Self>, String> {
        let store = LibraryStore::open_default().map_err(|e| e.to_string())?;
        Ok(Arc::new(Self::new(store, library::default_covers_dir())))
    }

    pub fn covers_dir(&self) -> &PathBuf {
        &self.covers_dir
    }

    pub fn lock(&self) -> Result<MutexGuard<'_, LibraryStore>, String> {
        self.store.lock().map_err(|_| "library store poisoned".into())
    }
}

// ---------------------------------------------------------------------------
// probe (wizard step 1 — PLAN.md §4: "App reads tags → shows
// title/artist/cover, asks nothing else")
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct ProbeResult {
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artist: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_s: Option<f64>,
    /// Embedded cover as a data URL, ready for an <img> src.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover_data_url: Option<String>,
    /// True when title came from tags (false ⇒ filename parsing fallback).
    pub from_tags: bool,
}

#[tauri::command]
pub async fn probe_audio(path: String) -> Result<ProbeResult, String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("file not found: {path}"));
    }
    let (fallback_title, fallback_artist) = meta_from_filename(&p);
    // Tag read is best-effort: unreadable tags fall back to the filename.
    let tags = library::read_tags(&p).unwrap_or_default();
    let from_tags = tags.title.is_some();
    Ok(ProbeResult {
        title: tags.title.unwrap_or(fallback_title),
        artist: tags.artist.or(fallback_artist),
        album: tags.album,
        duration_s: tags.duration_s,
        cover_data_url: tags
            .cover
            .as_ref()
            .map(|c| data_url(&c.data, c.mime.as_deref())),
        from_tags,
    })
}

// ---------------------------------------------------------------------------
// songs
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn library_songs(
    library: State<'_, Arc<LibraryHandle>>,
    query: Option<SongQuery>,
) -> Result<Vec<Song>, String> {
    let store = library.lock()?;
    store
        .list_songs(&query.unwrap_or_default())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn library_delete_song(
    library: State<'_, Arc<LibraryHandle>>,
    song_id: i64,
) -> Result<bool, String> {
    let store = library.lock()?;
    store.delete_song(song_id).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// collections
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn library_collections(
    library: State<'_, Arc<LibraryHandle>>,
) -> Result<Vec<CollectionInfo>, String> {
    library.lock()?.list_collections().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn collection_create(
    library: State<'_, Arc<LibraryHandle>>,
    name: String,
) -> Result<CollectionInfo, String> {
    library.lock()?.create_collection(&name).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn collection_rename(
    library: State<'_, Arc<LibraryHandle>>,
    collection_id: i64,
    name: String,
) -> Result<(), String> {
    library
        .lock()?
        .rename_collection(collection_id, &name)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn collection_delete(
    library: State<'_, Arc<LibraryHandle>>,
    collection_id: i64,
) -> Result<bool, String> {
    library
        .lock()?
        .delete_collection(collection_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn collection_add_song(
    library: State<'_, Arc<LibraryHandle>>,
    collection_id: i64,
    song_id: i64,
) -> Result<(), String> {
    library
        .lock()?
        .add_to_collection(collection_id, song_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn collection_remove_song(
    library: State<'_, Arc<LibraryHandle>>,
    collection_id: i64,
    song_id: i64,
) -> Result<bool, String> {
    library
        .lock()?
        .remove_from_collection(collection_id, song_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn song_collections(
    library: State<'_, Arc<LibraryHandle>>,
    song_id: i64,
) -> Result<Vec<i64>, String> {
    library
        .lock()?
        .collections_of_song(song_id)
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// up-next queue (PLAN.md §3 — order only; playing arrives with the Phase 3
// player)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn queue_list(
    library: State<'_, Arc<LibraryHandle>>,
) -> Result<Vec<QueueEntry>, String> {
    library.lock()?.queue_list().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn queue_add(
    library: State<'_, Arc<LibraryHandle>>,
    song_id: i64,
    from_collection: Option<i64>,
) -> Result<QueueEntry, String> {
    library
        .lock()?
        .queue_add(song_id, from_collection)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn queue_remove(
    library: State<'_, Arc<LibraryHandle>>,
    entry_id: i64,
) -> Result<bool, String> {
    library.lock()?.queue_remove(entry_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn queue_move(
    library: State<'_, Arc<LibraryHandle>>,
    entry_id: i64,
    to_index: usize,
) -> Result<(), String> {
    library
        .lock()?
        .queue_move(entry_id, to_index)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn queue_clear(library: State<'_, Arc<LibraryHandle>>) -> Result<(), String> {
    library.lock()?.queue_clear().map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// cover art
// ---------------------------------------------------------------------------

/// Read an extracted cover as a data URL. Restricted to the covers dir —
/// the webview never gets arbitrary-file read through this.
#[tauri::command]
pub async fn read_cover(
    library: State<'_, Arc<LibraryHandle>>,
    path: String,
) -> Result<String, String> {
    let p = PathBuf::from(&path);
    let canon = p
        .canonicalize()
        .map_err(|e| format!("cover not found: {e}"))?;
    let covers_canon = library
        .covers_dir()
        .canonicalize()
        .map_err(|e| format!("covers dir missing: {e}"))?;
    if !canon.starts_with(&covers_canon) {
        return Err("cover path outside the covers directory".into());
    }
    let bytes = std::fs::read(&canon).map_err(|e| e.to_string())?;
    let mime = match canon.extension().and_then(|e| e.to_str()) {
        Some("png") => Some("image/png"),
        Some("jpg") | Some("jpeg") => Some("image/jpeg"),
        Some("gif") => Some("image/gif"),
        Some("bmp") => Some("image/bmp"),
        Some("webp") => Some("image/webp"),
        _ => None,
    };
    Ok(data_url(&bytes, mime))
}

// ---------------------------------------------------------------------------
// base64 data URL (hand-rolled: ~20 lines beats a new §6 dependency row)
// ---------------------------------------------------------------------------

fn data_url(bytes: &[u8], mime: Option<&str>) -> String {
    format!(
        "data:{};base64,{}",
        mime.unwrap_or("application/octet-stream"),
        base64(bytes)
    )
}

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::base64;

    #[test]
    fn base64_matches_rfc4648_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }
}
