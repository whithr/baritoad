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
use tauri::{AppHandle, Emitter, State};

use karaoke_core::library::{self, CollectionInfo, LibraryStore, QueueEntry, Song, SongDetails, SongQuery};

/// Emitted when library rows change outside a command the webview made
/// (the startup backfill) — the Library refetches.
pub const LIBRARY_EVENT: &str = "karaoke://library";

/// Emitted with the whole [`QueueState`] after every up-next change, from
/// any window or command — the Library and the Stage both follow it.
pub const QUEUE_EVENT: &str = "karaoke://queue";

use crate::queue::meta_from_filename;

pub struct LibraryHandle {
    store: Mutex<LibraryStore>,
    covers_dir: PathBuf,
    /// The queue entry being sung right now. In memory only: after a restart
    /// nothing is playing, and the unfinished entry is simply first in line.
    playing: Mutex<Option<i64>>,
}

/// The up-next list plus which entry is on the Stage. An entry stays in the
/// list while it's sung and leaves when its song finishes or is skipped, so
/// a restart mid-song still has it.
#[derive(Debug, Clone, Serialize)]
pub struct QueueState {
    pub entries: Vec<QueueEntry>,
    pub playing: Option<i64>,
}

impl LibraryHandle {
    pub fn new(store: LibraryStore, covers_dir: PathBuf) -> Self {
        Self {
            store: Mutex::new(store),
            covers_dir,
            playing: Mutex::new(None),
        }
    }

    fn playing(&self) -> Result<MutexGuard<'_, Option<i64>>, String> {
        self.playing.lock().map_err(|_| "queue state poisoned".into())
    }

    /// The queue as the windows show it. A playing mark whose entry is gone
    /// (removed, or its song deleted) is dropped here.
    pub fn queue_state(&self, store: &LibraryStore) -> Result<QueueState, String> {
        let entries = store.queue_list().map_err(|e| e.to_string())?;
        let mut playing = self.playing()?;
        if playing.is_some_and(|id| !entries.iter().any(|e| e.id == id)) {
            *playing = None;
        }
        Ok(QueueState { entries, playing: *playing })
    }

    /// Clear the playing mark (the entry stays queued): the Stage closed or
    /// loaded something else. Returns whether anything changed.
    pub fn stop_playing(&self) -> bool {
        self.playing.lock().map(|mut p| p.take().is_some()).unwrap_or(false)
    }

    /// Mark `entry_id` as the one being sung. An entry that was playing
    /// before it (skipped for this one) leaves the list.
    pub fn play_entry(&self, entry_id: i64) -> Result<QueueEntry, String> {
        let store = self.lock()?;
        let entry = store
            .queue_list()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|e| e.id == entry_id)
            .ok_or_else(|| "that song isn't in Up next anymore".to_string())?;
        let mut playing = self.playing()?;
        if let Some(prev) = playing.filter(|&p| p != entry_id) {
            store.queue_remove(prev).map_err(|e| e.to_string())?;
        }
        *playing = Some(entry_id);
        Ok(entry)
    }

    /// `song_id` reached its end. If it was the marked entry's song, that
    /// entry has been sung and leaves the list. Returns the queue after.
    pub fn finish_song(&self, song_id: i64) -> Result<QueueState, String> {
        let store = self.lock()?;
        let before = self.queue_state(&store)?;
        let sung = before
            .playing
            .and_then(|id| before.entries.iter().find(|e| e.id == id))
            .filter(|e| e.song.id == song_id)
            .map(|e| e.id);
        if let Some(id) = sung {
            store.queue_remove(id).map_err(|e| e.to_string())?;
            *self.playing()? = None;
        }
        self.queue_state(&store)
    }

    /// Clear the mark unless `song_id` is the marked entry's song.
    pub fn stop_playing_unless(&self, song_id: Option<i64>) -> bool {
        let Ok(store) = self.lock() else { return false };
        let Ok(mut playing) = self.playing() else { return false };
        let Some(entry) = *playing else { return false };
        let same = song_id.is_some()
            && store
                .queue_list()
                .map(|q| q.iter().any(|e| e.id == entry && Some(e.song.id) == song_id))
                .unwrap_or(false);
        if same {
            return false;
        }
        *playing = None;
        true
    }
}

/// Tell both windows (and, later, a party) what the queue looks like now.
/// Best-effort: a queue change never fails because nobody was listening.
pub fn emit_queue<R: tauri::Runtime>(app: &AppHandle<R>, library: &LibraryHandle) {
    let state = library.lock().and_then(|store| library.queue_state(&store));
    match state {
        Ok(state) => {
            let _ = app.emit(QUEUE_EVENT, state);
        }
        Err(e) => eprintln!("queue event: {e}"),
    }
}

impl LibraryHandle {

    /// Open the per-user library (`%LOCALAPPDATA%\baritoad\library.db`).
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
    // Refuse what can't be decoded now, not at the separation stage.
    karaoke_core::audio::check_decodable(&p).map_err(|e| unreadable_audio_message(&e.to_string()))?;
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

/// What the wizard says about a file Symphonia can't decode (WMA, Opus…).
pub(crate) fn unreadable_audio_message(reason: &str) -> String {
    format!(
        "This file's audio can't be read ({reason}). MP3, FLAC, WAV, AIFF, M4A, OGG \
         and the sound of MP4, MOV and MKV videos work; WMA and Opus don't yet."
    )
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

/// Song › Properties: the details a person edits (title, artist, year,
/// genre, language).
#[tauri::command]
pub async fn song_update_details(
    library: State<'_, Arc<LibraryHandle>>,
    song_id: i64,
    details: SongDetails,
) -> Result<Song, String> {
    let store = library.lock()?;
    store.update_song_details(song_id, &details).map_err(|e| e.to_string())
}

/// Fill in year, genre and singing pace for songs imported before those
/// existed (or before the facts' version changed). Runs once per launch on
/// its own thread; the store is locked per song, never across the file
/// reads, so the Library stays responsive.
pub fn spawn_meta_backfill(app: AppHandle, library: Arc<LibraryHandle>) {
    let _ = std::thread::Builder::new()
        .name("library-backfill".into())
        .spawn(move || {
            let pending = match library.lock().and_then(|s| s.songs_needing_meta().map_err(|e| e.to_string())) {
                Ok(p) => p,
                Err(e) => {
                    eprintln!("library backfill: {e}");
                    return;
                }
            };
            let mut done = 0usize;
            for song in &pending {
                let meta = library::compute_meta(song);
                let stored = library.lock().and_then(|s| {
                    s.set_song_meta(song.id, meta.year, meta.genre.as_deref(), meta.pace_wpm)
                        .map_err(|e| e.to_string())
                });
                match stored {
                    Ok(()) => done += 1,
                    Err(e) => eprintln!("library backfill: song {}: {e}", song.id),
                }
            }
            if done > 0 {
                let _ = app.emit(LIBRARY_EVENT, done);
            }
        });
}

#[tauri::command]
pub async fn library_delete_song(
    app: AppHandle,
    library: State<'_, Arc<LibraryHandle>>,
    song_id: i64,
) -> Result<bool, String> {
    let deleted = library.lock()?.delete_song(song_id).map_err(|e| e.to_string())?;
    // Deleting a song takes its queue entries with it.
    emit_queue(&app, &library);
    Ok(deleted)
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
// up-next queue (PLAN.md §3). Every change emits QUEUE_EVENT. The Stage marks
// the entry it sings (queue_play) and finishes it (queue_finish); the entry
// leaves the list then, not when it starts.
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn queue_list(
    library: State<'_, Arc<LibraryHandle>>,
) -> Result<Vec<QueueEntry>, String> {
    library.lock()?.queue_list().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn queue_state(library: State<'_, Arc<LibraryHandle>>) -> Result<QueueState, String> {
    let store = library.lock()?;
    library.queue_state(&store)
}

#[tauri::command]
pub async fn queue_add(
    app: AppHandle,
    library: State<'_, Arc<LibraryHandle>>,
    song_id: i64,
    from_collection: Option<i64>,
) -> Result<QueueEntry, String> {
    let entry = library
        .lock()?
        .queue_add(song_id, from_collection)
        .map_err(|e| e.to_string())?;
    emit_queue(&app, &library);
    Ok(entry)
}

/// Collection › Add all / Shuffle into Up next: the songs in the order the
/// UI chose; songs without timings are skipped. Returns how many were queued.
#[tauri::command]
pub async fn queue_add_many(
    app: AppHandle,
    library: State<'_, Arc<LibraryHandle>>,
    song_ids: Vec<i64>,
    from_collection: Option<i64>,
) -> Result<usize, String> {
    let n = library
        .lock()?
        .queue_add_many(&song_ids, from_collection)
        .map_err(|e| e.to_string())?;
    emit_queue(&app, &library);
    Ok(n)
}

#[tauri::command]
pub async fn queue_remove(
    app: AppHandle,
    library: State<'_, Arc<LibraryHandle>>,
    entry_id: i64,
) -> Result<bool, String> {
    let removed = library.lock()?.queue_remove(entry_id).map_err(|e| e.to_string())?;
    emit_queue(&app, &library);
    Ok(removed)
}

#[tauri::command]
pub async fn queue_move(
    app: AppHandle,
    library: State<'_, Arc<LibraryHandle>>,
    entry_id: i64,
    to_index: usize,
) -> Result<(), String> {
    library
        .lock()?
        .queue_move(entry_id, to_index)
        .map_err(|e| e.to_string())?;
    emit_queue(&app, &library);
    Ok(())
}

#[tauri::command]
pub async fn queue_clear(app: AppHandle, library: State<'_, Arc<LibraryHandle>>) -> Result<(), String> {
    library.lock()?.queue_clear().map_err(|e| e.to_string())?;
    emit_queue(&app, &library);
    Ok(())
}

/// The Stage is about to sing `entry_id`. An entry that was playing before
/// it (skipped for this one) leaves the list. Returns the entry to sing.
#[tauri::command]
pub async fn queue_play(
    app: AppHandle,
    library: State<'_, Arc<LibraryHandle>>,
    entry_id: i64,
) -> Result<QueueEntry, String> {
    let entry = library.play_entry(entry_id)?;
    emit_queue(&app, &library);
    Ok(entry)
}

/// The person left the player mid-song: nothing is being sung, and the
/// unfinished entry stays first in Up next. (Closing the Stage does the same
/// in stage.rs.)
#[tauri::command]
pub async fn queue_stop(app: AppHandle, library: State<'_, Arc<LibraryHandle>>) -> Result<(), String> {
    if library.stop_playing() {
        emit_queue(&app, &library);
    }
    Ok(())
}

/// A song reached its end. If it was the queued entry being sung, that entry
/// has been sung and leaves the list. Returns the queue as it is now.
#[tauri::command]
pub async fn queue_finish(
    app: AppHandle,
    library: State<'_, Arc<LibraryHandle>>,
    song_id: i64,
) -> Result<QueueState, String> {
    let state = library.finish_song(song_id)?;
    let _ = app.emit(QUEUE_EVENT, state.clone());
    Ok(state)
}

// ---------------------------------------------------------------------------
// cover art
// ---------------------------------------------------------------------------

const MAX_COVER_BYTES: u64 = 25 * 1024 * 1024;

/// Song › Properties › Change…: copy the picture the person picked into the
/// covers folder (named by content hash, like tag art) so the dialog can
/// preview it through `read_cover`. Nothing changes until `song_set_cover`.
#[tauri::command]
pub async fn cover_import_image(
    library: State<'_, Arc<LibraryHandle>>,
    src_path: String,
) -> Result<String, String> {
    let src = PathBuf::from(&src_path);
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    let mime = match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "webp" => "image/webp",
        _ => return Err(format!("not a picture baritoad can show: .{ext}")),
    };
    let meta = std::fs::metadata(&src).map_err(|e| format!("picture not readable: {e}"))?;
    if meta.len() > MAX_COVER_BYTES {
        return Err("that picture is larger than 25 MB — pick a smaller one".into());
    }
    let data = std::fs::read(&src).map_err(|e| format!("picture not readable: {e}"))?;
    let art = library::tags::CoverArt { data, mime: Some(mime.into()) };
    let stored = library::tags::save_cover(&art, library.covers_dir()).map_err(|e| e.to_string())?;
    Ok(stored.to_string_lossy().into_owned())
}

/// Song › Properties OK: use a cover from the covers folder (from
/// `cover_import_image`), or `None` to clear it. A cover set here survives
/// re-imports (store `cover_by_user`).
#[tauri::command]
pub async fn song_set_cover(
    library: State<'_, Arc<LibraryHandle>>,
    song_id: i64,
    cover_path: Option<String>,
) -> Result<Song, String> {
    let path = match cover_path {
        Some(p) => {
            let canon = PathBuf::from(&p).canonicalize().map_err(|e| format!("cover not found: {e}"))?;
            let covers = library.covers_dir().canonicalize().map_err(|e| format!("covers dir missing: {e}"))?;
            if !canon.starts_with(&covers) {
                return Err("cover path outside the covers directory".into());
            }
            Some(PathBuf::from(p))
        }
        None => None,
    };
    let store = library.lock()?;
    if !store.set_cover(song_id, path.as_deref()).map_err(|e| e.to_string())? {
        return Err("that song isn't in the library anymore".into());
    }
    store
        .song(song_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "that song isn't in the library anymore".into())
}

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

pub(crate) fn data_url(bytes: &[u8], mime: Option<&str>) -> String {
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
mod queue_tests {
    use std::path::PathBuf;

    use karaoke_core::library::{LibraryStore, SongUpsert};

    use super::LibraryHandle;

    fn handle_with(titles: &[&str]) -> (LibraryHandle, Vec<i64>) {
        let store = LibraryStore::open_in_memory().unwrap();
        let mut ids = Vec::new();
        for (i, t) in titles.iter().enumerate() {
            let s = store
                .upsert_song(&SongUpsert {
                    title: (*t).into(),
                    audio_path: PathBuf::from(format!("C:/music/{t}.mp3")),
                    audio_hash: format!("h{i}"),
                    job_dir: PathBuf::from(format!("C:/music/{t}-karaoke")),
                    timing_map_path: Some(PathBuf::from(format!("C:/music/{t}-karaoke/map.json"))),
                    ..SongUpsert::default()
                })
                .unwrap();
            ids.push(s.id);
        }
        (LibraryHandle::new(store, PathBuf::from("covers")), ids)
    }

    fn titles(h: &LibraryHandle) -> Vec<String> {
        let store = h.lock().unwrap();
        h.queue_state(&store).unwrap().entries.into_iter().map(|e| e.song.title).collect()
    }

    #[test]
    fn an_entry_leaves_when_its_song_finishes_not_when_it_starts() {
        let (h, songs) = handle_with(&["A", "B"]);
        let (a, _b) = {
            let s = h.lock().unwrap();
            (s.queue_add(songs[0], None).unwrap(), s.queue_add(songs[1], None).unwrap())
        };
        h.play_entry(a.id).unwrap();
        assert_eq!(titles(&h), ["A", "B"], "still listed while it's sung");
        assert_eq!(h.queue_state(&h.lock().unwrap()).unwrap().playing, Some(a.id));

        // Another song finishing doesn't touch it.
        let st = h.finish_song(songs[1]).unwrap();
        assert_eq!(st.playing, Some(a.id));

        let st = h.finish_song(songs[0]).unwrap();
        assert_eq!(st.playing, None);
        assert_eq!(titles(&h), ["B"]);
    }

    #[test]
    fn jumping_to_another_entry_drops_the_skipped_one() {
        let (h, songs) = handle_with(&["A", "B", "C"]);
        let ids: Vec<i64> = {
            let s = h.lock().unwrap();
            songs.iter().map(|&id| s.queue_add(id, None).unwrap().id).collect()
        };
        h.play_entry(ids[0]).unwrap();
        h.play_entry(ids[2]).unwrap();
        assert_eq!(titles(&h), ["B", "C"]);
        assert!(h.play_entry(9999).is_err());
    }

    #[test]
    fn stopping_keeps_the_unfinished_entry_first_in_line() {
        let (h, songs) = handle_with(&["A", "B"]);
        let a = h.lock().unwrap().queue_add(songs[0], None).unwrap();
        h.play_entry(a.id).unwrap();

        // Loading the same song again keeps the mark; anything else clears it.
        assert!(!h.stop_playing_unless(Some(songs[0])));
        assert!(h.stop_playing_unless(Some(songs[1])));
        assert_eq!(titles(&h), ["A"]);

        h.play_entry(a.id).unwrap();
        assert!(h.stop_playing());
        assert!(!h.stop_playing());
        assert_eq!(titles(&h), ["A"]);
    }

    #[test]
    fn a_mark_whose_entry_is_gone_is_dropped() {
        let (h, songs) = handle_with(&["A"]);
        let a = h.lock().unwrap().queue_add(songs[0], None).unwrap();
        h.play_entry(a.id).unwrap();
        h.lock().unwrap().queue_remove(a.id).unwrap();
        assert_eq!(h.queue_state(&h.lock().unwrap()).unwrap().playing, None);
    }
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
