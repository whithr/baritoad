//! Song import in a separate process, at below-normal priority.
//!
//! The app re-launches its own executable with [`WORKER_ARG`]; that process
//! reads [`GenerateRequest`]s (one JSON line each) from stdin, runs them with
//! a [`ModelCache`] kept across jobs, and answers with [`WorkerMsg`] JSON
//! lines on stdout. Running apart from the UI process means:
//! - Windows schedules every inference thread below the UI, the player and
//!   the user's other apps (the priority class is inherited by the ORT pools);
//! - cancel is a kill — the job manifest is resumable after a kill at any
//!   point (pipeline::manifest docs), so no cooperative hook is needed;
//! - a GPU driver reset or crash takes down the worker, not the app.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use karaoke_core::pipeline::{self, GenerateRequest, ModelCache, PipelineEvent};

/// argv[1] that turns the desktop executable into an import worker.
pub const WORKER_ARG: &str = "--pipeline-worker";

/// One stdout line from the worker.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerMsg {
    Event(PipelineEvent),
    Done { map_path: PathBuf },
    Failed { message: String },
}

/// Worker-process entry point: serve jobs until stdin closes. Returns the
/// process exit code.
pub fn serve() -> i32 {
    let stdin = std::io::stdin();
    let mut cache = ModelCache::default();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let msg = match serde_json::from_str::<GenerateRequest>(&line) {
            Ok(req) => {
                let mut on_event = |e: &PipelineEvent| send(&WorkerMsg::Event(e.clone()));
                match pipeline::generate_with(&req, &mut cache, &mut on_event) {
                    Ok(out) => WorkerMsg::Done {
                        map_path: out.map_path,
                    },
                    Err(e) => WorkerMsg::Failed {
                        message: e.to_string(),
                    },
                }
            }
            Err(e) => WorkerMsg::Failed {
                message: format!("bad job request: {e}"),
            },
        };
        send(&msg);
    }
    0
}

/// Write one message line. The app went away if stdout is closed: stop
/// now — the manifest already holds a resumable record.
fn send(msg: &WorkerMsg) {
    let mut out = std::io::stdout().lock();
    let ok = serde_json::to_writer(&mut out, msg).is_ok() && out.write_all(b"\n").is_ok() && out.flush().is_ok();
    if !ok {
        std::process::exit(0);
    }
}

// ------------------------------------------------------------------ parent

const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// Stderr lines kept for a crash report.
const STDERR_TAIL: usize = 20;

enum Line {
    Msg(WorkerMsg),
    Closed,
}

/// How a job sent to the worker ended.
pub enum JobEnd {
    Done { map_path: PathBuf },
    Failed { message: String },
    /// Killed on request; the worker is gone.
    Cancelled,
    /// The worker exited mid-job (crash, driver reset); it is gone.
    Died { message: String },
}

/// The app's handle on a running worker process.
pub struct Worker {
    child: Child,
    stdin: Option<ChildStdin>,
    rx: Receiver<Line>,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
}

impl Worker {
    pub fn spawn() -> std::io::Result<Self> {
        let exe = std::env::current_exe()?;
        let mut cmd = Command::new(exe);
        cmd.arg(WORKER_ARG)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(BELOW_NORMAL_PRIORITY_CLASS | CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn()?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");

        let (tx, rx) = mpsc::channel();
        std::thread::Builder::new()
            .name("pipeline-worker-out".into())
            .spawn(move || {
                for line in BufReader::new(stdout).lines() {
                    let Ok(line) = line else { break };
                    // Anything that isn't a protocol line (a library printing
                    // to stdout) is ignored rather than failing the job.
                    if let Ok(msg) = serde_json::from_str::<WorkerMsg>(&line) {
                        if tx.send(Line::Msg(msg)).is_err() {
                            return;
                        }
                    }
                }
                let _ = tx.send(Line::Closed);
            })?;
        let stderr_tail = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_TAIL)));
        let tail = stderr_tail.clone();
        std::thread::Builder::new()
            .name("pipeline-worker-err".into())
            .spawn(move || {
                for line in BufReader::new(stderr).lines() {
                    let Ok(line) = line else { break };
                    let mut t = tail.lock().unwrap();
                    if t.len() == STDERR_TAIL {
                        t.pop_front();
                    }
                    t.push_back(line);
                }
            })?;
        Ok(Self {
            child,
            stdin,
            rx,
            stderr_tail,
        })
    }

    /// Run one job to its end, forwarding events. `cancelled` is polled a
    /// few times a second; when it turns true the worker is killed.
    pub fn run(
        &mut self,
        request: &GenerateRequest,
        on_event: &mut dyn FnMut(&PipelineEvent),
        cancelled: &dyn Fn() -> bool,
    ) -> JobEnd {
        let line = match serde_json::to_string(request) {
            Ok(l) => l,
            Err(e) => {
                return JobEnd::Failed {
                    message: format!("cannot encode job request: {e}"),
                }
            }
        };
        let sent = self
            .stdin
            .as_mut()
            .map(|s| s.write_all(line.as_bytes()).and_then(|_| s.write_all(b"\n")).and_then(|_| s.flush()));
        if !matches!(sent, Some(Ok(()))) {
            return JobEnd::Died {
                message: self.death_report("the import worker is not accepting jobs"),
            };
        }
        loop {
            match self.rx.recv_timeout(Duration::from_millis(200)) {
                Ok(Line::Msg(WorkerMsg::Event(e))) => on_event(&e),
                Ok(Line::Msg(WorkerMsg::Done { map_path })) => return JobEnd::Done { map_path },
                Ok(Line::Msg(WorkerMsg::Failed { message })) => return JobEnd::Failed { message },
                Ok(Line::Closed) | Err(RecvTimeoutError::Disconnected) => {
                    return JobEnd::Died {
                        message: self.death_report("the import worker stopped unexpectedly"),
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    if cancelled() {
                        let _ = self.child.kill();
                        let _ = self.child.wait();
                        return JobEnd::Cancelled;
                    }
                }
            }
        }
    }

    fn death_report(&mut self, what: &str) -> String {
        let status = self.child.wait().ok().and_then(|s| s.code());
        // Give the stderr reader a moment to drain the last lines.
        std::thread::sleep(Duration::from_millis(100));
        let tail = self.stderr_tail.lock().unwrap();
        let last: Vec<&str> = tail.iter().rev().take(4).rev().map(|s| s.as_str()).collect();
        let code = status.map(|c| format!(" (exit code {c})")).unwrap_or_default();
        if last.is_empty() {
            format!("{what}{code}")
        } else {
            format!("{what}{code}: {}", last.join(" | "))
        }
    }
}

impl Drop for Worker {
    /// Closing stdin lets an idle worker exit on its own; one still busy
    /// (only possible if the app is going away) is killed.
    fn drop(&mut self) {
        self.stdin = None;
        for _ in 0..20 {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use karaoke_core::pipeline::manifest::StageId;

    #[test]
    fn messages_round_trip_as_single_lines() {
        let msgs = [
            WorkerMsg::Event(PipelineEvent::StageProgress {
                stage: StageId::Separate,
                fraction: Some(0.5),
                message: Some("separating: 47/94 segments".into()),
            }),
            WorkerMsg::Done {
                map_path: PathBuf::from(r"C:\music\song-karaoke\song.align.json"),
            },
            WorkerMsg::Failed {
                message: "vocal stem not found".into(),
            },
        ];
        for m in &msgs {
            let line = serde_json::to_string(m).unwrap();
            assert!(!line.contains('\n'));
            let back: WorkerMsg = serde_json::from_str(&line).unwrap();
            assert_eq!(format!("{back:?}"), format!("{m:?}"));
        }
    }

    #[test]
    fn requests_round_trip() {
        let mut req = GenerateRequest::new(PathBuf::from(r"C:\music\song.mp3"));
        req.lyrics = Some(PathBuf::from(r"C:\music\song.txt"));
        req.sep_options.overlap = 0.5;
        req.sep_options.shifts = 2;
        req.sep_model = karaoke_core::separation::ModelKind::HtdemucsFt;
        let line = serde_json::to_string(&req).unwrap();
        let back: GenerateRequest = serde_json::from_str(&line).unwrap();
        assert_eq!(format!("{back:?}"), format!("{req:?}"));
    }
}
