//! In-process FIFO job queue for the generate pipeline.
//!
//! One worker thread executes [`karaoke_core::pipeline::generate`] jobs one at
//! a time (the pipeline is compute-bound; PLAN.md §5 job queue). Queueing and
//! the UI never block: `generate_song` returns immediately with a snapshot and
//! every state change is pushed to the webview as a `karaoke://job` event.
//!
//! Durable state (the resumable manifest + jobs-dir pointer) is karaoke-core's
//! job — this queue only tracks *this process's* work. A job killed mid-stage
//! resumes from its manifest on the next run, so cancellation is allowed to be
//! coarse (see [`CancelledMarker`]).

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use karaoke_core::library::register_completed_job;
use karaoke_core::pipeline::{self, GenerateRequest, PipelineEvent};

use crate::library::LibraryHandle;

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
    /// True once `cancel_job` was called on a running job; the worker stops at
    /// the next pipeline progress tick (the manifest stays resumable).
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

struct JobEntry {
    snapshot: JobSnapshot,
    /// Present until the worker takes the job.
    request: Option<GenerateRequest>,
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
}

/// Panic payload used to unwind out of `pipeline::generate` on cancel. The
/// pipeline has no cancellation hook (Phase 1 API); unwinding from the
/// progress callback leaves the manifest `in_flight` — exactly the state a
/// killed process leaves, which the manifest contract defines as resumable.
struct CancelledMarker;

impl JobQueue {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            cv: Condvar::new(),
            next_id: AtomicU64::new(1),
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
    ) -> JobSnapshot {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
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
                    cancel: Arc::new(AtomicBool::new(false)),
                },
            );
            inner.order.push(id);
            inner.pending.push_back(id);
        }
        self.cv.notify_one();
        emit_lifecycle(app, &snapshot);
        snapshot
    }

    /// Cancel a job. Queued jobs are removed immediately; the running job gets
    /// its cancel flag set and stops at the next progress tick. Finished jobs
    /// are returned unchanged.
    pub fn cancel(&self, app: &AppHandle, id: u64) -> Option<JobSnapshot> {
        let snapshot = {
            let mut inner = self.inner.lock().unwrap();
            let was_pending = inner.pending.iter().any(|&p| p == id);
            if was_pending {
                inner.pending.retain(|&p| p != id);
            }
            let entry = inner.jobs.get_mut(&id)?;
            match entry.snapshot.status {
                JobStatus::Queued if was_pending => {
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
                    inner = self.cv.wait(inner).unwrap();
                }
            };
            emit_lifecycle(&app, &started);

            let outcome = run_one(&app, id, &request, &cancel);

            // Library registration happens outside the queue lock (it reads
            // the manifest + tags from disk) and must not fail the job — the
            // song outputs exist regardless.
            let registered = match &outcome {
                RunOutcome::Completed { .. } => {
                    let (title, artist, out_dir) = {
                        let inner = self.inner.lock().unwrap();
                        let e = inner.jobs.get(&id).expect("job entry vanished");
                        (
                            e.snapshot.title.clone(),
                            e.snapshot.artist.clone(),
                            e.snapshot.out_dir.clone(),
                        )
                    };
                    let result = library.lock().and_then(|store| {
                        register_completed_job(
                            &store,
                            &out_dir,
                            library.covers_dir(),
                            &title,
                            artist.as_deref(),
                        )
                        .map_err(|e| e.to_string())
                    });
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
            emit_lifecycle(&app, &snapshot);
        }
    }
}

enum RunOutcome {
    Completed { map_path: PathBuf },
    Cancelled,
    Failed { message: String },
}

fn run_one(
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

/// Derive title/artist from a file name when tags/user input are absent
/// (milestone 1: no tag reader yet — "Artist - Title.mp3" or the bare stem).
pub fn meta_from_filename(path: &Path) -> (String, Option<String>) {
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Untitled".into());
    let cleaned = stem.replace('_', " ");
    let cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if let Some((artist, title)) = cleaned.split_once(" - ") {
        let artist = artist.trim();
        let title = title.trim();
        if !artist.is_empty() && !title.is_empty() {
            return (title.to_string(), Some(artist.to_string()));
        }
    }
    (cleaned, None)
}

#[cfg(test)]
mod tests {
    use super::*;

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
