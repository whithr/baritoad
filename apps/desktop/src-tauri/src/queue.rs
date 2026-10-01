//! FIFO job queue for the generate pipeline.
//!
//! One worker thread feeds jobs, one at a time, to the import worker process
//! ([`crate::worker`]: below-normal priority, models kept loaded between
//! queued jobs; the pipeline is compute-bound — PLAN.md §5 job queue). If the
//! worker process cannot start, the job runs in this process instead.
//! Queueing and the UI never block: `generate_song` returns immediately with
//! a snapshot and every state change is pushed to the webview as a
//! `karaoke://job` event.
//!
//! Durable state (the resumable manifest + jobs-dir pointer) is karaoke-core's
//! job — this queue only tracks *this process's* work. A job killed mid-stage
//! resumes from its manifest on the next run, so cancellation is allowed to be
//! coarse (see [`CancelledMarker`]).
//!
//! The *list* of unfinished jobs is durable too (a bulk import is an
//! overnight job — PLAN.md §3): every queued or running job is mirrored to
//! [`queue_store_path`], and [`JobQueue::restore`] re-queues them at launch,
//! where each resumes from its manifest. A job carries [`PostImport`] steps
//! (collection, mark checked) that run once it registers in the library.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use karaoke_core::library::register_completed_job;
use karaoke_core::library::store::LibraryStore;
use karaoke_core::pipeline::{self, manifest, GenerateRequest, PipelineEvent};

use crate::library::LibraryHandle;
use crate::worker::{JobEnd, Worker};

/// An idle worker process keeps its models loaded this long for the next
/// queued job, then exits and frees its RAM and VRAM.
const WORKER_IDLE: Duration = Duration::from_secs(90);

/// Single event channel the frontend subscribes to.
pub const JOB_EVENT: &str = "karaoke://job";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

/// UI-facing view of one queued/running/finished job in this process.
#[derive(Debug, Clone, Serialize)]
pub struct JobSnapshot {
    pub id: u64,
    pub audio: PathBuf,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artist: Option<String>,
    pub out_dir: PathBuf,
    /// Set when the job completed (points at the timing map).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub map_path: Option<PathBuf>,
    /// Library row id once the completed job registered (idempotent by
    /// audio hash — regenerating updates the same song).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub library_song_id: Option<i64>,
    pub status: JobStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// True once `cancel_job` was called on a running job; the worker process
    /// is stopped (the manifest stays resumable).
    pub cancel_requested: bool,
    pub queued_unix: u64,
}

/// Everything emitted on [`JOB_EVENT`].
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum JobEventPayload {
    /// Status change (queued / running / completed / failed / cancelled).
    Lifecycle { job: JobSnapshot },
    /// A pipeline event, tagged with the job it belongs to. `event` is the
    /// serde-tagged JSON karaoke-core already defines.
    Pipeline { job_id: u64, event: PipelineEvent },
}

/// Library steps a job takes once its song registers (bulk import).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PostImport {
    /// Add the song to the collection with this name (created if missing,
    /// matched case-insensitively).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collection: Option<String>,
    /// Mark the song checked (imported hand-made timings need no review).
    #[serde(default)]
    pub mark_checked: bool,
    /// Metadata the import brought (UltraStar `#YEAR`/`#GENRE`/`#LANGUAGE`);
    /// replaces what the audio's tags said.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub year: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub genre: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
}

/// One unfinished job as saved in [`queue_store_path`].
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedJob {
    request: GenerateRequest,
    title: String,
    #[serde(default)]
    artist: Option<String>,
    out_dir: PathBuf,
    #[serde(default)]
    post: PostImport,
}

/// `%LOCALAPPDATA%\karaoke\import-queue.json`, beside the library.
pub fn queue_store_path() -> PathBuf {
    karaoke_core::library::store::default_library_path().with_file_name("import-queue.json")
}

struct JobEntry {
    snapshot: JobSnapshot,
    /// Present until the worker takes the job.
    request: Option<GenerateRequest>,
    /// What the queue file records while the job is unfinished.
    saved: PersistedJob,
    cancel: Arc<AtomicBool>,
}

#[derive(Default)]
struct Inner {
    pending: VecDeque<u64>,
    jobs: HashMap<u64, JobEntry>,
    /// Insertion order, for stable listing.
    order: Vec<u64>,
}

pub struct JobQueue {
    inner: Mutex<Inner>,
    cv: Condvar,
    next_id: AtomicU64,
    /// Where unfinished jobs are mirrored; None keeps the queue in memory.
    store: Option<PathBuf>,
    /// Serializes queue-file writes (outside the `inner` lock).
    store_lock: Mutex<()>,
}

/// Panic payload used to unwind out of `pipeline::generate` on cancel. The
/// pipeline has no cancellation hook (Phase 1 API); unwinding from the
/// progress callback leaves the manifest `in_flight` — exactly the state a
/// killed process leaves, which the manifest contract defines as resumable.
struct CancelledMarker;

impl JobQueue {
    /// An in-memory queue (nothing survives a restart).
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            cv: Condvar::new(),
            next_id: AtomicU64::new(1),
            store: None,
            store_lock: Mutex::new(()),
        }
    }

    /// A queue that mirrors its unfinished jobs to `path` (see module docs).
    pub fn with_store(path: PathBuf) -> Self {
        Self {
            store: Some(path),
            ..Self::new()
        }
    }

    /// Re-queue the jobs a previous run left unfinished. Each resumes from
    /// its manifest (finished stages are skipped). A missing or unreadable
    /// file restores nothing.
    pub fn restore(&self, app: &AppHandle) -> usize {
        let Some(path) = &self.store else { return 0 };
        let Ok(raw) = std::fs::read_to_string(path) else { return 0 };
        let Ok(jobs) = serde_json::from_str::<Vec<PersistedJob>>(&raw) else { return 0 };
        let n = jobs.len();
        for j in jobs {
            if j.request.audio.is_file() {
                self.enqueue(app, j.request, j.title, j.artist, j.out_dir, j.post);
            }
        }
        self.persist(); // drops entries whose audio has gone
        n
    }

    /// Mirror every queued/running job to the queue file. Takes `store_lock`
    /// *then* `inner` (never the reverse), so writes land in order.
    fn persist(&self) {
        let Some(path) = &self.store else { return };
        let _write = self.store_lock.lock().unwrap();
        let unfinished: Vec<PersistedJob> = {
            let inner = self.inner.lock().unwrap();
            inner
                .order
                .iter()
                .filter_map(|id| inner.jobs.get(id))
                .filter(|e| matches!(e.snapshot.status, JobStatus::Queued | JobStatus::Running))
                .filter(|e| !e.snapshot.cancel_requested)
                .map(|e| e.saved.clone())
                .collect()
        };
        let result = if unfinished.is_empty() {
            match std::fs::remove_file(path) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
                _ => Ok(()),
            }
        } else {
            serde_json::to_vec_pretty(&unfinished)
                .map_err(|e| e.to_string())
                .and_then(|bytes| {
                    if let Some(dir) = path.parent() {
                        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
                    }
                    manifest::write_atomic(path, &bytes).map_err(|e| e.to_string())
                })
        };
        if let Err(e) = result {
            eprintln!("import queue: cannot save {}: {e}", path.display());
        }
    }

    /// Enqueue a job; returns the queued snapshot and emits its lifecycle
    /// event. Never blocks on pipeline work.
    pub fn enqueue(
        &self,
        app: &AppHandle,
        request: GenerateRequest,
        title: String,
        artist: Option<String>,
        out_dir: PathBuf,
        post: PostImport,
    ) -> JobSnapshot {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let saved = PersistedJob {
            request: request.clone(),
            title: title.clone(),
            artist: artist.clone(),
            out_dir: out_dir.clone(),
            post,
        };
        let snapshot = JobSnapshot {
            id,
            audio: request.audio.clone(),
            title,
            artist,
            out_dir,
            map_path: None,
            library_song_id: None,
            status: JobStatus::Queued,
            error: None,
            cancel_requested: false,
            queued_unix: unix_now(),
        };
        {
            let mut inner = self.inner.lock().unwrap();
            inner.jobs.insert(
                id,
                JobEntry {
                    snapshot: snapshot.clone(),
                    request: Some(request),
                    saved,
                    cancel: Arc::new(AtomicBool::new(false)),
                },
            );
            inner.order.push(id);
        }
        self.persist();
        // Emit Queued BEFORE the job becomes takeable: the worker emits
        // Running from its own thread, and on an idle queue it used to win
        // the race — the webview saw Running then Queued and the UI sat on
        // "standby" for the whole run. (The frontend reducer is also
        // monotonic now; this keeps the channel well-ordered at the source.)
        emit_lifecycle(app, &snapshot);
        {
            let mut inner = self.inner.lock().unwrap();
            // A cancel may have landed in the emit window — a cancelled job
            // must not become runnable.
            let still_queued = inner
                .jobs
                .get(&id)
                .map(|e| e.snapshot.status == JobStatus::Queued && e.request.is_some())
                .unwrap_or(false);
            if still_queued {
                inner.pending.push_back(id);
            }
        }
        self.cv.notify_one();
        snapshot
    }

    /// Cancel a job. Queued jobs are removed immediately; the running job gets
    /// its cancel flag set and stops at the next progress tick. Finished jobs
    /// are returned unchanged.
    pub fn cancel(&self, app: &AppHandle, id: u64) -> Option<JobSnapshot> {
        let snapshot = {
            let mut inner = self.inner.lock().unwrap();
            inner.pending.retain(|&p| p != id);
            let entry = inner.jobs.get_mut(&id)?;
            match entry.snapshot.status {
                // A queued job cancels whether or not it reached `pending`
                // yet (enqueue publishes Queued before making it takeable —
                // this closes that window).
                JobStatus::Queued => {
                    entry.snapshot.status = JobStatus::Cancelled;
                    entry.request = None;
                }
                JobStatus::Running => {
                    entry.snapshot.cancel_requested = true;
                    entry.cancel.store(true, Ordering::Relaxed);
                }
                _ => {}
            }
            entry.snapshot.clone()
        };
        self.persist();
        emit_lifecycle(app, &snapshot);
        Some(snapshot)
    }

    /// Snapshots of every job this process knows, oldest first.
    pub fn snapshots(&self) -> Vec<JobSnapshot> {
        let inner = self.inner.lock().unwrap();
        inner
            .order
            .iter()
            .filter_map(|id| inner.jobs.get(id).map(|e| e.snapshot.clone()))
            .collect()
    }

    /// Worker loop body — spawn on a dedicated thread with the app handle.
    /// On completion the job registers in the library (PLAN.md §4 step 6:
    /// the song lands in the library marked ready) *before* the completed
    /// lifecycle event fires, so a UI refetch on that event sees the row.
    pub fn run_worker(self: Arc<Self>, app: AppHandle, library: Arc<LibraryHandle>) {
        let mut worker: Option<Worker> = None;
        loop {
            let (id, request, cancel, started) = {
                let mut inner = self.inner.lock().unwrap();
                loop {
                    if let Some(id) = inner.pending.pop_front() {
                        let entry = match inner.jobs.get_mut(&id) {
                            Some(e) => e,
                            None => continue,
                        };
                        let Some(request) = entry.request.take() else {
                            continue; // cancelled while queued
                        };
                        entry.snapshot.status = JobStatus::Running;
                        break (id, request, entry.cancel.clone(), entry.snapshot.clone());
                    }
                    if worker.is_none() {
                        inner = self.cv.wait(inner).unwrap();
                        continue;
                    }
                    let (guard, wait) = self.cv.wait_timeout(inner, WORKER_IDLE).unwrap();
                    if wait.timed_out() && guard.pending.is_empty() {
                        // Retire the idle worker outside the lock (its drop
                        // waits briefly for the process to exit).
                        drop(guard);
                        worker = None;
                        inner = self.inner.lock().unwrap();
                    } else {
                        inner = guard;
                    }
                }
            };
            emit_lifecycle(&app, &started);

            let outcome = run_one(&app, id, &request, &cancel, &mut worker);

            // Library registration happens outside the queue lock (it reads
            // the manifest + tags from disk) and must not fail the job — the
            // song outputs exist regardless.
            let registered = match &outcome {
                RunOutcome::Completed { .. } => {
                    let (title, artist, out_dir, post) = {
                        let inner = self.inner.lock().unwrap();
                        let e = inner.jobs.get(&id).expect("job entry vanished");
                        (
                            e.snapshot.title.clone(),
                            e.snapshot.artist.clone(),
                            e.snapshot.out_dir.clone(),
                            e.saved.post.clone(),
                        )
                    };
                    // A failed post-import step (collection, checked) is a
                    // note, not a lost song: the registration stands.
                    let mut post_error: Option<String> = None;
                    let result = library.lock().and_then(|store| {
                        let song = register_completed_job(
                            &store,
                            &out_dir,
                            library.covers_dir(),
                            &title,
                            artist.as_deref(),
                        )
                        .map_err(|e| e.to_string())?;
                        post_error = apply_post_import(&store, song.id, &post).err();
                        Ok(song)
                    });
                    if let Some(msg) = post_error {
                        let _ = app.emit(
                            JOB_EVENT,
                            JobEventPayload::Pipeline {
                                job_id: id,
                                event: PipelineEvent::Note {
                                    message: format!("song added, but its import settings failed: {msg}"),
                                },
                            },
                        );
                    }
                    match result {
                        Ok(song) => Some(song.id),
                        Err(msg) => {
                            let _ = app.emit(
                                JOB_EVENT,
                                JobEventPayload::Pipeline {
                                    job_id: id,
                                    event: PipelineEvent::Note {
                                        message: format!(
                                            "song finished but library registration failed: {msg}"
                                        ),
                                    },
                                },
                            );
                            None
                        }
                    }
                }
                _ => None,
            };

            let snapshot = {
                let mut inner = self.inner.lock().unwrap();
                let entry = inner.jobs.get_mut(&id).expect("job entry vanished");
                match outcome {
                    RunOutcome::Completed { map_path } => {
                        entry.snapshot.status = JobStatus::Completed;
                        entry.snapshot.map_path = Some(map_path);
                        entry.snapshot.library_song_id = registered;
                    }
                    RunOutcome::Cancelled => {
                        entry.snapshot.status = JobStatus::Cancelled;
                    }
                    RunOutcome::Failed { message } => {
                        entry.snapshot.status = JobStatus::Failed;
                        entry.snapshot.error = Some(message);
                    }
                }
                entry.snapshot.clone()
            };
            self.persist();
            emit_lifecycle(&app, &snapshot);
        }
    }
}

/// A registered song's [`PostImport`] steps.
fn apply_post_import(store: &LibraryStore, song_id: i64, post: &PostImport) -> Result<(), String> {
    if let Some(name) = post.collection.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
        let existing = store
            .list_collections()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|c| c.name.eq_ignore_ascii_case(name));
        let collection_id = match existing {
            Some(c) => c.id,
            None => store.create_collection(name).map_err(|e| e.to_string())?.id,
        };
        store.add_to_collection(collection_id, song_id).map_err(|e| e.to_string())?;
    }
    if post.mark_checked {
        store.set_reviewed(song_id, true).map_err(|e| e.to_string())?;
    }
    if post.year.is_some() || post.genre.is_some() || post.language.is_some() {
        store
            .apply_imported_meta(song_id, post.year, post.genre.as_deref(), post.language.as_deref())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

enum RunOutcome {
    Completed { map_path: PathBuf },
    Cancelled,
    Failed { message: String },
}

/// Run one job in the worker process, starting it if needed; falls back to
/// this process when it cannot start. A cancelled or crashed worker is
/// discarded (the next job starts a fresh one).
fn run_one(
    app: &AppHandle,
    id: u64,
    request: &GenerateRequest,
    cancel: &Arc<AtomicBool>,
    worker: &mut Option<Worker>,
) -> RunOutcome {
    if worker.is_none() {
        match Worker::spawn() {
            Ok(w) => *worker = Some(w),
            Err(e) => {
                let _ = app.emit(
                    JOB_EVENT,
                    JobEventPayload::Pipeline {
                        job_id: id,
                        event: PipelineEvent::Note {
                            message: format!("import worker unavailable ({e}) — importing in the app process"),
                        },
                    },
                );
                return run_in_process(app, id, request, cancel);
            }
        }
    }
    let w = worker.as_mut().expect("started above");
    let app_events = app.clone();
    let mut on_event = move |e: &PipelineEvent| {
        let _ = app_events.emit(
            JOB_EVENT,
            JobEventPayload::Pipeline {
                job_id: id,
                event: e.clone(),
            },
        );
    };
    match w.run(request, &mut on_event, &|| cancel.load(Ordering::Relaxed)) {
        JobEnd::Done { map_path } => RunOutcome::Completed { map_path },
        JobEnd::Failed { message } => RunOutcome::Failed { message },
        JobEnd::Cancelled => {
            *worker = None;
            RunOutcome::Cancelled
        }
        JobEnd::Died { message } => {
            *worker = None;
            RunOutcome::Failed { message }
        }
    }
}

/// The pre-worker path: run the pipeline on this thread, cancelling by
/// unwinding out of the progress callback ([`CancelledMarker`]).
fn run_in_process(
    app: &AppHandle,
    id: u64,
    request: &GenerateRequest,
    cancel: &Arc<AtomicBool>,
) -> RunOutcome {
    let app_events = app.clone();
    let cancel = cancel.clone();
    let mut on_event = move |e: &PipelineEvent| {
        if cancel.load(Ordering::Relaxed) {
            std::panic::panic_any(CancelledMarker);
        }
        let _ = app_events.emit(
            JOB_EVENT,
            JobEventPayload::Pipeline {
                job_id: id,
                event: e.clone(),
            },
        );
    };
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        pipeline::generate(request, &mut on_event)
    }));
    match result {
        Ok(Ok(outcome)) => RunOutcome::Completed {
            map_path: outcome.map_path,
        },
        Ok(Err(e)) => RunOutcome::Failed {
            message: e.to_string(),
        },
        Err(payload) => {
            if payload.downcast_ref::<CancelledMarker>().is_some() {
                RunOutcome::Cancelled
            } else {
                let msg = payload
                    .downcast_ref::<&str>()
                    .map(|s| s.to_string())
                    .or_else(|| payload.downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "pipeline panicked".into());
                RunOutcome::Failed { message: msg }
            }
        }
    }
}

fn emit_lifecycle(app: &AppHandle, snapshot: &JobSnapshot) {
    let _ = app.emit(
        JOB_EVENT,
        JobEventPayload::Lifecycle {
            job: snapshot.clone(),
        },
    );
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Derive title/artist from a file name when tags/user input are absent —
/// "Artist - Title.mp3" or the bare stem (shared with the folder scan).
pub fn meta_from_filename(path: &Path) -> (String, Option<String>) {
    karaoke_core::import::meta_from_filename(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use karaoke_core::library::store::SongUpsert;

    fn store_with_song() -> (LibraryStore, i64) {
        let store = LibraryStore::open_in_memory().unwrap();
        let song = store
            .upsert_song(&SongUpsert {
                title: "Waterloo".into(),
                audio_path: PathBuf::from(r"D:\Karaoke\Party\ABBA - Waterloo.flac"),
                audio_hash: "h1".into(),
                job_dir: PathBuf::from(r"D:\Karaoke\Party\ABBA - Waterloo-karaoke"),
                ..SongUpsert::default()
            })
            .unwrap();
        (store, song.id)
    }

    #[test]
    fn post_import_files_the_song_and_reuses_collections_by_name() {
        let (store, id) = store_with_song();
        let existing = store.create_collection("Christmas").unwrap();
        let post = PostImport {
            collection: Some("christmas".into()),
            mark_checked: true,
            year: Some(1984),
            genre: Some("Pop".into()),
            language: Some("en".into()),
        };
        apply_post_import(&store, id, &post).unwrap();
        assert_eq!(store.list_collections().unwrap().len(), 1, "matched case-insensitively");
        assert_eq!(store.collections_of_song(id).unwrap(), vec![existing.id]);
        let song = store.song(id).unwrap().unwrap();
        assert!(song.reviewed_at.is_some());
        assert_eq!((song.year, song.genre.as_deref()), (Some(1984), Some("Pop")));
    }

    #[test]
    fn post_import_creates_a_missing_collection_and_leaves_review_alone() {
        let (store, id) = store_with_song();
        let post = PostImport {
            collection: Some("Party".into()),
            ..PostImport::default()
        };
        apply_post_import(&store, id, &post).unwrap();
        let colls = store.list_collections().unwrap();
        assert_eq!(colls.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["Party"]);
        assert!(store.song(id).unwrap().unwrap().reviewed_at.is_none());
    }

    #[test]
    fn saved_jobs_round_trip_and_tolerate_missing_post_steps() {
        let mut req = GenerateRequest::new(PathBuf::from(r"D:\a.mp3"));
        req.timings = Some(PathBuf::from(r"D:\a.txt"));
        let saved = PersistedJob {
            request: req,
            title: "A".into(),
            artist: None,
            out_dir: PathBuf::from(r"D:\a-karaoke"),
            post: PostImport {
                collection: Some("Party".into()),
                mark_checked: true,
                ..PostImport::default()
            },
        };
        let json = serde_json::to_string(&vec![saved]).unwrap();
        let back: Vec<PersistedJob> = serde_json::from_str(&json).unwrap();
        assert_eq!(back[0].request.timings.as_deref(), Some(Path::new(r"D:\a.txt")));
        assert_eq!(back[0].post.collection.as_deref(), Some("Party"));
        // A file written without post steps still loads.
        let bare = json.replace(r#","post":{"collection":"Party","mark_checked":true}"#, "");
        let back: Vec<PersistedJob> = serde_json::from_str(&bare).unwrap();
        assert!(back[0].post.collection.is_none() && !back[0].post.mark_checked);
    }

    #[test]
    fn meta_artist_title() {
        let (t, a) = meta_from_filename(Path::new(r"C:\music\Robyn - Dancing On My Own.mp3"));
        assert_eq!(t, "Dancing On My Own");
        assert_eq!(a.as_deref(), Some("Robyn"));
    }

    #[test]
    fn meta_bare_stem_with_underscores() {
        let (t, a) = meta_from_filename(Path::new("back_on_my_bs.mp3"));
        assert_eq!(t, "back on my bs");
        assert_eq!(a, None);
    }

    #[test]
    fn meta_hyphen_without_spaces_is_not_a_split() {
        let (t, a) = meta_from_filename(Path::new("semi-charmed.flac"));
        assert_eq!(t, "semi-charmed");
        assert_eq!(a, None);
    }
}
