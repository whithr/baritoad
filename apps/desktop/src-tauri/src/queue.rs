//! FIFO job queue for the generate pipeline.
//!
//! One worker thread feeds jobs, one at a time, to the import worker process
//! ([`crate::worker`]: below-normal priority, models kept loaded between
//! queued jobs; the pipeline is compute-bound). If the
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
//! overnight job): every queued or running job is mirrored to
//! [`queue_store_path`], and [`JobQueue::restore`] re-queues them at launch,
//! where each resumes from its manifest. A job carries [`PostImport`] steps
//! (collection, mark checked) that run once it registers in the library.
//!
//! Before the pipeline, a job can have [`Prep`] steps (Add from
//! URL / LRCLIB lookup): download its audio from a link with yt-dlp, then
//! look its lyrics up on LRCLIB when it has none. Each step's result is
//! written back to the saved job, so a restart neither downloads nor looks
//! up twice. Progress goes out as [`JobEventPayload::Prep`].
//!
//! A site that turns a download away for rate limiting (YouTube's bot
//! check, HTTP 429) would turn the next ones away too, and every request
//! stretches the block. So the queued songs still waiting to download from
//! that site fail with the same reason without asking it
//! ([`JobQueue::fail_waiting_on`]); Try again picks them up later. To keep
//! from getting there, downloads from one site start 10–20 s apart
//! ([`FETCH_GAP`]) — usually free, since processing a song takes longer.
//!
//! Last before the pipeline, gaming mode ([`crate::gaming`]): when the app in
//! front is a game using the graphics card, separation runs on the processor
//! (or the job waits, per the person's choice). The verdict is taken once per
//! song — a game started mid-separation doesn't move that song.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use karaoke_core::library::register_completed_job;
use karaoke_core::library::store::LibraryStore;
use karaoke_core::library::tags::{self, CoverArt};
use karaoke_core::lrclib;
use karaoke_core::pipeline::{self, manifest, GenerateRequest, PipelineEvent};

use crate::gaming::{GamePolicy, GameWatch};
use crate::library::LibraryHandle;
use crate::tools::{self, ToolsState};
use crate::worker::{JobEnd, Worker};

/// An idle worker process keeps its models loaded this long for the next
/// queued job, then exits and frees its RAM and VRAM.
const WORKER_IDLE: Duration = Duration::from_secs(90);

/// Single event channel the frontend subscribes to.
pub const JOB_EVENT: &str = "karaoke://job";

/// What an LRCLIB lookup leaves in the job's folder: the lyrics the pipeline
/// aligns against, the line-timed LRC when LRCLIB has one, and which record
/// they came from.
pub const LRCLIB_LYRICS: &str = "lrclib.lyrics.txt";
const LRCLIB_SYNCED: &str = "lrclib.lrc";
const LRCLIB_RECORD: &str = "lrclib.json";
/// A fetched song's thumbnail, applied as cover art once it registers.
const FETCHED_COVER: &str = "fetched-cover";
/// Downloads from one site start at least this far apart, plus up to
/// [`FETCH_JITTER`] more: yt-dlp's `-t sleep` spacing (10–20 s), which its
/// wiki recommends for YouTube. Every site gets the same treatment.
const FETCH_GAP: Duration = Duration::from_secs(10);
const FETCH_JITTER: Duration = Duration::from_secs(10);

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
    /// The link the audio comes from (Add from URL).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
    /// The job looks its lyrics up on LRCLIB before the pipeline runs.
    pub lookup_lyrics: bool,
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
    /// Progress of a [`Prep`] step (before the pipeline starts).
    Prep {
        job_id: u64,
        step: PrepStep,
        #[serde(skip_serializing_if = "Option::is_none")]
        fraction: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PrepStep {
    Fetch,
    Lyrics,
    /// Gaming mode's "pause": waiting for the game to let go of the GPU.
    Wait,
}

/// Steps a job takes before the pipeline (module docs).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Prep {
    /// Download the audio from this link first.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<LinkPrep>,
    /// Look the lyrics up on LRCLIB when the job has none.
    #[serde(default)]
    pub lookup_lyrics: bool,
    /// The lookup ran (found or not) — a resumed job doesn't ask again.
    #[serde(default)]
    pub lyrics_looked_up: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkPrep {
    pub url: String,
    /// Where the audio goes, without its extension (yt-dlp picks it).
    pub stem_path: PathBuf,
    #[serde(default)]
    pub duration_s: Option<f64>,
    /// JPEG/PNG thumbnail for cover art.
    #[serde(default)]
    pub thumbnail: Option<String>,
    /// Download about as fast as the song plays (the person's choice).
    #[serde(default)]
    pub playback_speed: bool,
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
    #[serde(default)]
    prep: Prep,
}

/// `%LOCALAPPDATA%\baritoad\import-queue.json`, beside the library.
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
    /// When the last download from each site ([`site_of`]) ended.
    last_fetch: Mutex<HashMap<String, Instant>>,
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
            last_fetch: Mutex::new(HashMap::new()),
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
            // A link job whose download never finished fetches again.
            if j.request.audio.is_file() || j.prep.link.is_some() {
                self.enqueue(app, j.request, j.title, j.artist, j.out_dir, j.post, j.prep);
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
    #[allow(clippy::too_many_arguments)]
    pub fn enqueue(
        &self,
        app: &AppHandle,
        request: GenerateRequest,
        title: String,
        artist: Option<String>,
        out_dir: PathBuf,
        post: PostImport,
        prep: Prep,
    ) -> JobSnapshot {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let source_url = prep.link.as_ref().map(|l| l.url.clone());
        let lookup_lyrics = prep.lookup_lyrics;
        let saved = PersistedJob {
            request: request.clone(),
            title: title.clone(),
            artist: artist.clone(),
            out_dir: out_dir.clone(),
            post,
            prep,
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
            source_url,
            lookup_lyrics,
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

    /// Queue a failed or cancelled job again, as it was saved — a download or
    /// lyrics lookup that already finished isn't repeated, and the pipeline
    /// resumes from its manifest. `None` for a job that isn't finished.
    pub fn retry(&self, app: &AppHandle, id: u64) -> Option<JobSnapshot> {
        let saved = {
            let inner = self.inner.lock().unwrap();
            let e = inner.jobs.get(&id)?;
            if !matches!(e.snapshot.status, JobStatus::Failed | JobStatus::Cancelled) {
                return None;
            }
            e.saved.clone()
        };
        Some(self.enqueue(app, saved.request, saved.title, saved.artist, saved.out_dir, saved.post, saved.prep))
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
    /// On completion the job registers in the library, marked ready,
    /// *before* the completed
    /// lifecycle event fires, so a UI refetch on that event sees the row.
    pub fn run_worker(
        self: Arc<Self>,
        app: AppHandle,
        library: Arc<LibraryHandle>,
        tools: Arc<ToolsState>,
        game: Arc<GameWatch>,
    ) {
        let mut worker: Option<Worker> = None;
        // Held while there's anything to import, so a long batch survives
        // the computer's sleep timer (keep_awake.rs).
        let mut awake = crate::keep_awake::KeepAwake::new();
        loop {
            let (id, request, cancel, started, prep) = {
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
                        break (
                            id,
                            request,
                            entry.cancel.clone(),
                            entry.snapshot.clone(),
                            entry.saved.prep.clone(),
                        );
                    }
                    awake.release();
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
            awake.hold();
            emit_lifecycle(&app, &started);

            let outcome = match self
                .prepare(&app, &tools, id, request, &prep, &started, &cancel)
                .and_then(|request| mind_the_game(&app, &game, id, request, &cancel))
            {
                Ok(request) => run_one(&app, id, &request, &cancel, &mut worker),
                Err(end) => end,
            };
            let turned_away = match (&outcome, &prep.link) {
                (RunOutcome::RateLimited { message }, Some(link)) => {
                    site_of(&link.url).map(|site| (site, message.clone()))
                }
                _ => None,
            };

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
                        // A fetched song's thumbnail, when its file brought no art.
                        if let Some(cover) = fetched_cover(&out_dir) {
                            if let Err(e) = tags::save_cover(&cover, library.covers_dir())
                                .and_then(|p| store.set_cover_if_missing(song.id, &p))
                            {
                                eprintln!("import queue: cover art not applied: {e}");
                            }
                        }
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
                    RunOutcome::Failed { message } | RunOutcome::RateLimited { message } => {
                        entry.snapshot.status = JobStatus::Failed;
                        entry.snapshot.error = Some(message);
                    }
                }
                entry.snapshot.clone()
            };
            self.persist();
            emit_lifecycle(&app, &snapshot);
            if let Some((site, message)) = turned_away {
                for stopped in self.fail_waiting_on(&site, &message) {
                    emit_lifecycle(&app, &stopped);
                }
            }
        }
    }

    /// Fail the queued jobs that still have to download from `site`, without
    /// asking it — it just turned a download away (module docs). Each keeps
    /// its saved steps, so Try again picks it up once the site lets go.
    fn fail_waiting_on(&self, site: &str, message: &str) -> Vec<JobSnapshot> {
        let stopped: Vec<JobSnapshot> = {
            let mut guard = self.inner.lock().unwrap();
            let inner = &mut *guard;
            let waiting = |e: &JobEntry| {
                e.saved.prep.link.as_ref().is_some_and(|l| site_of(&l.url).as_deref() == Some(site))
                    && e.request.as_ref().is_some_and(|r| !r.audio.is_file())
            };
            let ids: Vec<u64> = inner
                .pending
                .iter()
                .copied()
                .filter(|id| inner.jobs.get(id).is_some_and(&waiting))
                .collect();
            inner.pending.retain(|id| !ids.contains(id));
            ids.iter()
                .filter_map(|id| {
                    let e = inner.jobs.get_mut(id)?;
                    e.request = None;
                    e.snapshot.status = JobStatus::Failed;
                    e.snapshot.error = Some(message.to_string());
                    Some(e.snapshot.clone())
                })
                .collect()
        };
        if !stopped.is_empty() {
            self.persist();
        }
        stopped
    }
}

/// The site a link asks: its host, lowercased, without "www.", "m." or
/// "music." — every YouTube link is "youtube.com" (youtu.be too).
fn site_of(url: &str) -> Option<String> {
    let (_, rest) = url.trim().split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let host = authority.rsplit('@').next()?.split(':').next()?.to_ascii_lowercase();
    let host = ["www.", "m.", "music."]
        .iter()
        .find_map(|p| host.strip_prefix(p))
        .unwrap_or(host.as_str());
    match host {
        "" => None,
        "youtu.be" => Some("youtube.com".into()),
        h => Some(h.to_string()),
    }
}

impl JobQueue {
    /// Change a job's entry (and its saved copy), then save the queue file.
    fn update_entry(&self, id: u64, f: impl FnOnce(&mut JobEntry)) -> Option<JobSnapshot> {
        let snap = {
            let mut inner = self.inner.lock().unwrap();
            let entry = inner.jobs.get_mut(&id)?;
            f(entry);
            entry.snapshot.clone()
        };
        self.persist();
        Some(snap)
    }

    /// Run a job's [`Prep`] steps; returns the request the pipeline should
    /// run, or how the job ended (failed download, cancel).
    #[allow(clippy::too_many_arguments)]
    fn prepare(
        &self,
        app: &AppHandle,
        tools: &ToolsState,
        id: u64,
        mut request: GenerateRequest,
        prep: &Prep,
        job: &JobSnapshot,
        cancel: &Arc<AtomicBool>,
    ) -> Result<GenerateRequest, RunOutcome> {
        let out_dir = job.out_dir.clone();
        if let Some(link) = prep.link.as_ref().filter(|_| !request.audio.is_file()) {
            emit_prep(app, id, PrepStep::Fetch, None, "Getting ready to download");
            let t = tools.get(app).map_err(|message| RunOutcome::Failed { message })?;
            if let Some(msg) = tools.update_if_due(&t) {
                emit_prep(app, id, PrepStep::Fetch, None, &format!("yt-dlp: {msg}"));
            }
            let site = site_of(&link.url);
            if let Some(site) = &site {
                self.space_out(app, id, site, cancel)?;
            }
            let mut on_progress =
                |fraction: Option<f64>, message: &str| emit_prep(app, id, PrepStep::Fetch, fraction, message);
            let fetched = t.download(&link.url, &link.stem_path, link.playback_speed, &mut on_progress, &|| {
                cancel.load(Ordering::Relaxed)
            });
            if let Some(site) = site {
                self.last_fetch.lock().unwrap().insert(site, Instant::now());
            }
            let audio = fetched
                .map_err(|e| match e {
                    karaoke_core::Error::Cancelled => RunOutcome::Cancelled,
                    karaoke_core::Error::RateLimited(message) => RunOutcome::RateLimited { message },
                    e => RunOutcome::Failed { message: e.to_string() },
                })?;
            if let Some(thumb) = &link.thumbnail {
                let png = thumb.split(['?', '#']).next().unwrap_or("").to_lowercase().ends_with(".png");
                let dest = out_dir.join(format!("{FETCHED_COVER}.{}", if png { "png" } else { "jpg" }));
                if !dest.exists() {
                    if let Err(e) = karaoke_core::fetch::download_small(thumb, &dest, &tools::user_agent(app)) {
                        eprintln!("import queue: no cover art: {e}");
                    }
                }
            }
            request.audio = audio.clone();
            if let Some(snap) = self.update_entry(id, |e| {
                e.saved.request.audio = audio.clone();
                e.snapshot.audio = audio.clone();
            }) {
                emit_lifecycle(app, &snap);
            }
        }
        if cancel.load(Ordering::Relaxed) {
            return Err(RunOutcome::Cancelled);
        }
        // A song fetched (or looked up) before keeps the lyrics LRCLIB gave it
        // then, rather than transcribing — the folder is ours, nothing is asked
        // online. (The wizard's own jobs have no prep: an empty box there
        // still means "transcribe".)
        let earlier = out_dir.join(LRCLIB_LYRICS);
        if (prep.link.is_some() || prep.lookup_lyrics)
            && request.lyrics.is_none()
            && request.timings.is_none()
            && earlier.is_file()
        {
            request.lyrics = Some(earlier.clone());
            emit_prep(app, id, PrepStep::Lyrics, Some(1.0), "Using the lyrics LRCLIB found for this song before");
            self.update_entry(id, |e| {
                e.saved.prep.lyrics_looked_up = true;
                e.saved.request.lyrics = Some(earlier.clone());
            });
        }
        if prep.lookup_lyrics && !prep.lyrics_looked_up && request.lyrics.is_none() && request.timings.is_none() {
            emit_prep(app, id, PrepStep::Lyrics, None, "Looking the lyrics up on LRCLIB");
            let query = lrclib::Query {
                title: job.title.clone(),
                artist: job.artist.clone(),
                album: None,
                duration_s: prep
                    .link
                    .as_ref()
                    .and_then(|l| l.duration_s)
                    .or_else(|| tags::read_tags(&request.audio).ok().and_then(|t| t.duration_s)),
            };
            let note = match tools::lyrics_client(app).lookup(&query) {
                Ok(Some(rec)) => match save_lrclib(&out_dir, &rec) {
                    Ok(path) => {
                        request.lyrics = Some(path);
                        format!("Lyrics from LRCLIB: \u{201c}{}\u{201d} by {}", rec.track_name, rec.artist_name)
                    }
                    Err(e) => format!("Found lyrics on LRCLIB but couldn't save them ({e}) — transcribing instead"),
                },
                Ok(None) => "LRCLIB has no lyrics for this song — transcribing them instead".to_string(),
                Err(e) => format!("Couldn't reach LRCLIB ({e}) — transcribing instead"),
            };
            emit_prep(app, id, PrepStep::Lyrics, Some(1.0), &note);
            let lyrics = request.lyrics.clone();
            self.update_entry(id, |e| {
                e.saved.prep.lyrics_looked_up = true;
                e.saved.request.lyrics = lyrics;
            });
        }
        Ok(request)
    }

    /// Wait out what's left of the gap since the last download from `site`
    /// ([`FETCH_GAP`]), counting down in the job's progress.
    fn space_out(&self, app: &AppHandle, id: u64, site: &str, cancel: &Arc<AtomicBool>) -> Result<(), RunOutcome> {
        let since = self.last_fetch.lock().unwrap().get(site).map(Instant::elapsed);
        let Some(left) = gap_left(since, fetch_gap()) else {
            return Ok(());
        };
        let until = Instant::now() + left;
        let mut told = None;
        while let Some(left) = until.checked_duration_since(Instant::now()).filter(|d| !d.is_zero()) {
            if cancel.load(Ordering::Relaxed) {
                return Err(RunOutcome::Cancelled);
            }
            let secs = left.as_secs() + 1;
            if told != Some(secs) {
                emit_prep(app, id, PrepStep::Fetch, None, &format!("Waiting {secs} s between downloads from {site}"));
                told = Some(secs);
            }
            std::thread::sleep(left.min(Duration::from_millis(200)));
        }
        Ok(())
    }
}

/// This download's gap: [`FETCH_GAP`] plus a random part of
/// [`FETCH_JITTER`] (the standard library's randomly keyed hasher).
fn fetch_gap() -> Duration {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(unix_nanos());
    FETCH_GAP + FETCH_JITTER.mul_f64((h.finish() % 1000) as f64 / 1000.0)
}

/// How long to wait before downloading again, `since` the last download
/// from the same site; `None` when it's been long enough (or never).
fn gap_left(since: Option<Duration>, gap: Duration) -> Option<Duration> {
    gap.checked_sub(since?).filter(|d| !d.is_zero())
}

/// Gaming mode, just before the pipeline: with a game using the graphics
/// card, separate on the processor or wait, per the person's choice.
fn mind_the_game(
    app: &AppHandle,
    game: &GameWatch,
    id: u64,
    mut request: GenerateRequest,
    cancel: &Arc<AtomicBool>,
) -> Result<GenerateRequest, RunOutcome> {
    if request.ep == karaoke_core::separation::EpChoice::Cpu {
        return Ok(request); // already off the graphics card
    }
    let who = |st: &crate::gaming::GameStatus| st.app.clone().unwrap_or_else(|| "A game".into());
    match game.policy() {
        GamePolicy::Gpu => {}
        GamePolicy::Cpu => {
            let st = game.status();
            if st.gaming {
                request.sep_run_on = Some(karaoke_core::separation::EpChoice::Cpu);
                let _ = app.emit(
                    JOB_EVENT,
                    JobEventPayload::Pipeline {
                        job_id: id,
                        event: PipelineEvent::Note {
                            message: format!(
                                "{} is using the graphics card, so this song separates on the processor (slower; keeps the game smooth)",
                                who(&st)
                            ),
                        },
                    },
                );
            }
        }
        GamePolicy::Pause => {
            let mut told = false;
            loop {
                let st = game.status();
                if !st.gaming {
                    break;
                }
                if cancel.load(Ordering::Relaxed) {
                    return Err(RunOutcome::Cancelled);
                }
                if !told {
                    emit_prep(app, id, PrepStep::Wait, None, &format!("Paused while {} is using the graphics card", who(&st)));
                    told = true;
                }
                std::thread::sleep(Duration::from_millis(500));
            }
        }
    }
    Ok(request)
}

/// Write an LRCLIB record's lyrics (and synced LRC, and provenance) into the
/// job folder; returns the lyrics file the pipeline aligns against.
fn save_lrclib(out_dir: &Path, rec: &lrclib::Record) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(out_dir)?;
    let text = rec.lyrics_text().unwrap_or_default();
    let path = out_dir.join(LRCLIB_LYRICS);
    std::fs::write(&path, text)?;
    if let Some(synced) = rec.synced_lyrics.as_deref().filter(|s| !s.trim().is_empty()) {
        std::fs::write(out_dir.join(LRCLIB_SYNCED), synced)?;
    }
    let provenance = serde_json::json!({
        "source": "lrclib.net",
        "id": rec.id,
        "track_name": rec.track_name,
        "artist_name": rec.artist_name,
        "album_name": rec.album_name,
        "duration": rec.duration,
    });
    std::fs::write(out_dir.join(LRCLIB_RECORD), serde_json::to_vec_pretty(&provenance).unwrap_or_default())?;
    Ok(path)
}

/// The thumbnail a link job saved in its folder, as cover art.
fn fetched_cover(out_dir: &Path) -> Option<CoverArt> {
    ["jpg", "png"].iter().find_map(|ext| {
        let data = std::fs::read(out_dir.join(format!("{FETCHED_COVER}.{ext}"))).ok()?;
        let mime = if *ext == "png" { "image/png" } else { "image/jpeg" };
        (!data.is_empty()).then(|| CoverArt { data, mime: Some(mime.into()) })
    })
}

fn emit_prep(app: &AppHandle, job_id: u64, step: PrepStep, fraction: Option<f64>, message: &str) {
    let _ = app.emit(
        JOB_EVENT,
        JobEventPayload::Prep {
            job_id,
            step,
            fraction,
            message: Some(message.to_string()),
        },
    );
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
    /// The download's site is turning this network away (module docs).
    RateLimited { message: String },
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
    (unix_nanos() / 1_000_000_000) as u64
}

fn unix_nanos() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
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
            prep: Prep::default(),
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

    /// A queued job straight into the queue's state (no app to emit to).
    fn queued(q: &JobQueue, url: Option<&str>, audio: PathBuf) -> u64 {
        let id = q.next_id.fetch_add(1, Ordering::Relaxed);
        let request = GenerateRequest::new(audio);
        let prep = Prep {
            link: url.map(|u| LinkPrep {
                url: u.into(),
                stem_path: request.audio.clone(),
                duration_s: None,
                thumbnail: None,
                playback_speed: false,
            }),
            ..Prep::default()
        };
        let snapshot = JobSnapshot {
            id,
            audio: request.audio.clone(),
            title: format!("song {id}"),
            artist: None,
            out_dir: PathBuf::new(),
            map_path: None,
            library_song_id: None,
            status: JobStatus::Queued,
            error: None,
            cancel_requested: false,
            queued_unix: 0,
            source_url: url.map(Into::into),
            lookup_lyrics: false,
        };
        let saved = PersistedJob {
            request: request.clone(),
            title: snapshot.title.clone(),
            artist: None,
            out_dir: PathBuf::new(),
            post: PostImport::default(),
            prep,
        };
        let mut inner = q.inner.lock().unwrap();
        inner.jobs.insert(
            id,
            JobEntry { snapshot, request: Some(request), saved, cancel: Arc::new(AtomicBool::new(false)) },
        );
        inner.order.push(id);
        inner.pending.push_back(id);
        id
    }

    #[test]
    fn a_rate_limited_site_fails_its_waiting_downloads_and_nothing_else() {
        let q = JobQueue::new();
        let nowhere = || PathBuf::from(r"C:\nowhere\not-downloaded-yet");
        let watch = queued(&q, Some("https://www.youtube.com/watch?v=a1&list=PL1"), nowhere());
        let short = queued(&q, Some("https://youtu.be/b2"), nowhere());
        let other = queued(&q, Some("https://archive.org/details/x"), nowhere());
        let file = queued(&q, None, nowhere());
        // Already downloaded: what's left doesn't ask YouTube.
        let fetched = queued(&q, Some("https://youtube.com/watch?v=c3"), std::env::current_exe().unwrap());
        let music = queued(&q, Some("https://music.youtube.com/watch?v=d4"), nowhere());

        let stopped = q.fail_waiting_on("youtube.com", "turned away");
        assert_eq!(stopped.iter().map(|s| s.id).collect::<Vec<_>>(), [watch, short, music]);
        assert!(stopped.iter().all(|s| s.status == JobStatus::Failed && s.error.as_deref() == Some("turned away")));
        let inner = q.inner.lock().unwrap();
        assert_eq!(inner.pending.iter().copied().collect::<Vec<_>>(), [other, file, fetched]);
        // Try again needs the saved link.
        assert!(inner.jobs[&watch].saved.prep.link.is_some());
    }

    #[test]
    fn downloads_from_one_site_wait_out_the_gap() {
        let gap = Duration::from_secs(15);
        assert_eq!(gap_left(None, gap), None, "first download from a site");
        assert_eq!(gap_left(Some(Duration::from_secs(4)), gap), Some(Duration::from_secs(11)));
        assert_eq!(gap_left(Some(gap), gap), None);
        assert_eq!(gap_left(Some(Duration::from_secs(60)), gap), None, "processing took longer");
        for _ in 0..50 {
            let g = fetch_gap();
            assert!(g >= FETCH_GAP && g <= FETCH_GAP + FETCH_JITTER, "{g:?}");
        }
    }

    #[test]
    fn links_name_their_site() {
        let site = |u: &str| site_of(u);
        assert_eq!(site("https://www.youtube.com/watch?v=a").as_deref(), Some("youtube.com"));
        assert_eq!(site("https://m.youtube.com/watch?v=a").as_deref(), Some("youtube.com"));
        assert_eq!(site("https://music.youtube.com/playlist?list=a").as_deref(), Some("youtube.com"));
        assert_eq!(site("https://youtu.be/a?t=3").as_deref(), Some("youtube.com"));
        assert_eq!(site("https://ARCHIVE.org/details/x").as_deref(), Some("archive.org"));
        assert_eq!(site("https://artist.bandcamp.com:443/track/x").as_deref(), Some("artist.bandcamp.com"));
        assert_eq!(site("not a link"), None);
        assert_eq!(site("https:///nohost"), None);
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
