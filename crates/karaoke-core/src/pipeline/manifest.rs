//! Persisted job manifest — the record that makes the pipeline resumable.
//!
//! One `job.json` lives **beside the outputs** (the manifest is authoritative);
//! a small pointer file per job lands in the jobs dir so `karaoke jobs list`
//! can enumerate every job without scanning the disk.
//!
//! ## Resume contract
//!
//! A stage may be skipped on a later run iff **all** of:
//! - its manifest entry says [`StageStatus::Complete`]
//! - its recorded `fingerprint` equals the fingerprint recomputed from the
//!   current inputs (content hashes of audio/lyrics, stage config, stage
//!   version, and upstream stages' `output_token`s)
//! - every recorded artifact still exists on disk with its recorded size
//!
//! ## Interrupted jobs
//!
//! Before a stage runs its entry is set to [`StageStatus::InFlight`] and the
//! manifest is saved **atomically** (temp file + rename). A process killed
//! mid-stage therefore leaves `in_flight` on disk — never `complete` — and the
//! stage reruns on resume. Artifacts possibly half-written by the killed run
//! are ignored because the skip rule above requires `Complete`.
//!
//! ## Cascading invalidation
//!
//! Each completed stage gets a fresh `output_token` (hash over its
//! fingerprint, artifacts, and completion time). Downstream fingerprints
//! include upstream tokens, so a rerun (forced or input-driven) of one stage
//! automatically invalidates everything after it, while unchanged upstream
//! stages keep their tokens and stay skippable — changed lyrics re-run
//! cleanup + align + export but reuse the stems.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

use super::hash;

pub const MANIFEST_VERSION: u32 = 1;
pub const MANIFEST_FILE_NAME: &str = "job.json";

/// The pipeline stages, in run order (separate → clean lyrics → align →
/// export).
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum StageId {
    Separate,
    CleanLyrics,
    Align,
    Export,
}

impl StageId {
    pub const ALL: [StageId; 4] = [
        StageId::Separate,
        StageId::CleanLyrics,
        StageId::Align,
        StageId::Export,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            StageId::Separate => "separate",
            StageId::CleanLyrics => "clean_lyrics",
            StageId::Align => "align",
            StageId::Export => "export",
        }
    }
}

impl std::fmt::Display for StageId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for StageId {
    type Err = String;
    fn from_str(s: &str) -> std::result::Result<Self, String> {
        match s {
            "separate" => Ok(StageId::Separate),
            "clean_lyrics" | "clean-lyrics" | "lyrics" | "clean" => Ok(StageId::CleanLyrics),
            "align" => Ok(StageId::Align),
            "export" => Ok(StageId::Export),
            other => Err(format!(
                "unknown stage '{other}' (stages: separate, clean_lyrics, align, export)"
            )),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StageStatus {
    /// Never run (or invalidated implicitly by a fingerprint change).
    Pending,
    /// Marked before the stage runs; still on disk after a crash/kill —
    /// never trusted as complete.
    InFlight,
    Complete,
    Failed,
    /// The stage does not apply to this job (e.g. lyric cleanup with no
    /// pasted lyrics — the align stage auto-transcribes instead).
    NotApplicable,
}

/// One file a stage produced. Size is recorded so resume can cheaply detect
/// deleted/replaced artifacts (content re-hashing every resume would cost
/// seconds on multi-hundred-MB stems; a mid-write kill is already covered by
/// the in-flight status, not by artifact checks).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Artifact {
    pub name: String,
    pub path: PathBuf,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StageEntry {
    pub status: StageStatus,
    pub stage_version: u32,
    /// Hash of everything that determines this stage's output (module docs).
    #[serde(default)]
    pub fingerprint: String,
    /// Identity of this stage's completed output; downstream fingerprints
    /// include it (module docs: cascading invalidation).
    #[serde(default)]
    pub output_token: String,
    #[serde(default)]
    pub artifacts: Vec<Artifact>,
    #[serde(default)]
    pub started_unix: Option<u64>,
    #[serde(default)]
    pub seconds: Option<f64>,
    #[serde(default)]
    pub error: Option<String>,
    /// Stage-specific diagnostics (substage timings, EP used, counters).
    /// Informational only — never part of fingerprints or output tokens.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

impl StageEntry {
    fn new(stage_version: u32) -> Self {
        Self {
            status: StageStatus::Pending,
            stage_version,
            fingerprint: String::new(),
            output_token: String::new(),
            artifacts: Vec::new(),
            started_unix: None,
            seconds: None,
            error: None,
            details: None,
        }
    }
}

/// A content-hashed input file reference.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InputRef {
    pub path: PathBuf,
    pub sha256: String,
    pub bytes: u64,
}

impl InputRef {
    pub fn from_file(path: &Path) -> Result<Self> {
        let meta = std::fs::metadata(path)
            .map_err(|e| Error::InvalidInput(format!("cannot stat {}: {e}", path.display())))?;
        Ok(Self {
            path: path.to_path_buf(),
            sha256: hash::sha256_file(path)?,
            bytes: meta.len(),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobManifest {
    pub version: u32,
    pub job_id: String,
    pub audio: InputRef,
    /// Present iff the user passed lyrics for this run.
    #[serde(default)]
    pub lyrics: Option<InputRef>,
    pub out_dir: PathBuf,
    pub created_unix: u64,
    pub updated_unix: u64,
    pub stages: BTreeMap<StageId, StageEntry>,
}

impl JobManifest {
    pub fn new(job_id: String, audio: InputRef, lyrics: Option<InputRef>, out_dir: &Path) -> Self {
        let now = unix_now();
        Self {
            version: MANIFEST_VERSION,
            job_id,
            audio,
            lyrics,
            out_dir: out_dir.to_path_buf(),
            created_unix: now,
            updated_unix: now,
            stages: BTreeMap::new(),
        }
    }

    pub fn manifest_path(out_dir: &Path) -> PathBuf {
        out_dir.join(MANIFEST_FILE_NAME)
    }

    pub fn load(path: &Path) -> Result<Self> {
        let raw = std::fs::read_to_string(path)?;
        let man: Self = serde_json::from_str(&raw)
            .map_err(|e| Error::InvalidInput(format!("manifest parse {}: {e}", path.display())))?;
        if man.version != MANIFEST_VERSION {
            return Err(Error::InvalidInput(format!(
                "manifest {} has version {} (expected {MANIFEST_VERSION})",
                path.display(),
                man.version
            )));
        }
        Ok(man)
    }

    /// Atomic save: write to `<path>.tmp`, then rename over the target.
    /// A kill at any point leaves either the old manifest or the new one on
    /// disk — never a torn file (module docs: interrupted jobs).
    pub fn save_atomic(&mut self, path: &Path) -> Result<()> {
        self.updated_unix = unix_now();
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| Error::Encode(format!("manifest: {e}")))?;
        write_atomic(path, json.as_bytes())
    }

    pub fn stage(&self, id: StageId) -> Option<&StageEntry> {
        self.stages.get(&id)
    }

    pub fn stage_mut(&mut self, id: StageId, stage_version: u32) -> &mut StageEntry {
        self.stages
            .entry(id)
            .or_insert_with(|| StageEntry::new(stage_version))
    }

    /// The resume decision (module docs): complete + fingerprint match +
    /// artifacts present at recorded sizes.
    pub fn stage_up_to_date(&self, id: StageId, fingerprint: &str) -> bool {
        let Some(e) = self.stages.get(&id) else {
            return false;
        };
        e.status == StageStatus::Complete
            && e.fingerprint == fingerprint
            && e.artifacts.iter().all(|a| {
                std::fs::metadata(&a.path)
                    .map(|m| m.len() == a.bytes)
                    .unwrap_or(false)
            })
    }

    /// Mark a stage as running and record its fingerprint. The caller must
    /// save the manifest before starting real work.
    pub fn mark_in_flight(&mut self, id: StageId, stage_version: u32, fingerprint: &str) {
        let e = self.stage_mut(id, stage_version);
        e.status = StageStatus::InFlight;
        e.stage_version = stage_version;
        e.fingerprint = fingerprint.to_string();
        e.output_token = String::new(); // stale output identity dies with the rerun
        e.artifacts.clear();
        e.started_unix = Some(unix_now());
        e.seconds = None;
        e.error = None;
        e.details = None;
    }

    /// Mark a stage complete and mint its fresh `output_token`.
    pub fn mark_complete(
        &mut self,
        id: StageId,
        stage_version: u32,
        artifacts: Vec<Artifact>,
        seconds: f64,
    ) {
        let now = unix_now();
        let fp = self
            .stages
            .get(&id)
            .map(|e| e.fingerprint.clone())
            .unwrap_or_default();
        let mut token_src = format!("{fp}|{now}|{seconds}");
        for a in &artifacts {
            token_src.push_str(&format!("|{}:{}", a.path.display(), a.bytes));
        }
        let e = self.stage_mut(id, stage_version);
        e.status = StageStatus::Complete;
        e.stage_version = stage_version;
        e.artifacts = artifacts;
        e.seconds = Some(seconds);
        e.error = None;
        e.output_token = hash::sha256_hex(token_src.as_bytes());
    }

    /// Attach diagnostic details to a stage entry (call after
    /// [`Self::mark_complete`], before saving). No-op if the stage was never
    /// touched this run.
    pub fn set_details(&mut self, id: StageId, details: serde_json::Value) {
        if let Some(e) = self.stages.get_mut(&id) {
            e.details = Some(details);
        }
    }

    pub fn mark_failed(&mut self, id: StageId, stage_version: u32, message: &str) {
        let e = self.stage_mut(id, stage_version);
        e.status = StageStatus::Failed;
        e.error = Some(message.to_string());
    }

    pub fn mark_not_applicable(&mut self, id: StageId, stage_version: u32, fingerprint: &str) {
        let e = self.stage_mut(id, stage_version);
        e.status = StageStatus::NotApplicable;
        e.stage_version = stage_version;
        e.fingerprint = fingerprint.to_string();
        // stable token so downstream fingerprints don't churn while the
        // stage stays not-applicable
        e.output_token = hash::sha256_hex(format!("n/a|{fingerprint}").as_bytes());
        e.artifacts.clear();
        e.seconds = None;
        e.error = None;
    }

    /// Token of a completed (or not-applicable) upstream stage, for
    /// downstream fingerprints.
    pub fn output_token(&self, id: StageId) -> Option<&str> {
        self.stages.get(&id).and_then(|e| {
            matches!(e.status, StageStatus::Complete | StageStatus::NotApplicable)
                .then_some(e.output_token.as_str())
        })
    }

    /// Artifact path by stage + name (e.g. the align stage's "map").
    pub fn artifact_path(&self, id: StageId, name: &str) -> Option<&Path> {
        self.stages.get(&id).and_then(|e| {
            e.artifacts
                .iter()
                .find(|a| a.name == name)
                .map(|a| a.path.as_path())
        })
    }

    /// One-word job status for listings: `failed@stage`, `interrupted@stage`,
    /// `complete`, or `partial`.
    pub fn summary_status(&self) -> String {
        for id in StageId::ALL {
            if let Some(e) = self.stages.get(&id) {
                if e.status == StageStatus::Failed {
                    return format!("failed@{id}");
                }
            }
        }
        for id in StageId::ALL {
            if let Some(e) = self.stages.get(&id) {
                if e.status == StageStatus::InFlight {
                    return format!("interrupted@{id}");
                }
            }
        }
        let all_done = StageId::ALL.iter().all(|id| {
            self.stages
                .get(id)
                .map(|e| matches!(e.status, StageStatus::Complete | StageStatus::NotApplicable))
                .unwrap_or(false)
        });
        if all_done {
            "complete".into()
        } else {
            "partial".into()
        }
    }
}

/// Stable job identity: where the audio lives + where the outputs go. Content
/// changes do **not** change the id — they invalidate stages via fingerprints,
/// which is the correct granularity ("same job, new input").
pub fn job_id(audio: &Path, out_dir: &Path) -> String {
    let key = format!("{}\n{}", audio.display(), out_dir.display());
    hash::sha256_hex(key.as_bytes())[..12].to_string()
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Write bytes atomically: temp file in the same directory, then rename
/// (std's rename replaces the destination on Windows and POSIX alike).
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension(match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => format!("{ext}.tmp"),
        None => "tmp".into(),
    });
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// jobs registry (pointer files for `karaoke jobs list`)
// ---------------------------------------------------------------------------

/// Pointer from the jobs dir to a job's manifest. The manifest is the truth;
/// the pointer only makes jobs enumerable.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobPointer {
    pub job_id: String,
    pub manifest: PathBuf,
    pub audio: PathBuf,
    pub out_dir: PathBuf,
    pub updated_unix: u64,
}

/// Default jobs dir: `%LOCALAPPDATA%\baritoad\jobs` (in the data folder).
pub fn default_jobs_dir() -> PathBuf {
    crate::paths::data_dir().join("jobs")
}

pub fn write_pointer(jobs_dir: &Path, ptr: &JobPointer) -> Result<()> {
    std::fs::create_dir_all(jobs_dir)?;
    let json = serde_json::to_string_pretty(ptr)
        .map_err(|e| Error::Encode(format!("job pointer: {e}")))?;
    write_atomic(&jobs_dir.join(format!("{}.json", ptr.job_id)), json.as_bytes())
}

/// Every job the registry knows, newest-updated first. The manifest slot is
/// `None` when the pointed-to manifest is missing/unreadable (outputs deleted).
pub fn list_jobs(jobs_dir: &Path) -> Result<Vec<(JobPointer, Option<JobManifest>)>> {
    let mut out = Vec::new();
    let rd = match std::fs::read_dir(jobs_dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(e.into()),
    };
    for entry in rd {
        let path = entry?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(ptr) = serde_json::from_str::<JobPointer>(&raw) else {
            continue; // foreign json in the jobs dir: not ours, skip
        };
        let man = JobManifest::load(&ptr.manifest).ok();
        out.push((ptr, man));
    }
    out.sort_by(|a, b| b.0.updated_unix.cmp(&a.0.updated_unix));
    Ok(out)
}

// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "karaoke-manifest-test-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn input_ref(dir: &Path, name: &str, content: &[u8]) -> InputRef {
        let p = dir.join(name);
        std::fs::write(&p, content).unwrap();
        InputRef::from_file(&p).unwrap()
    }

    #[test]
    fn save_load_round_trip_and_atomicity() {
        let dir = tmp_dir("roundtrip");
        let audio = input_ref(&dir, "song.bin", b"pretend audio");
        let mut man = JobManifest::new(job_id(&dir.join("song.bin"), &dir), audio, None, &dir);
        man.mark_in_flight(StageId::Separate, 1, "fp1");
        let path = JobManifest::manifest_path(&dir);
        man.save_atomic(&path).unwrap();
        // no temp residue after a clean save
        assert!(!path.with_extension("json.tmp").exists());

        let back = JobManifest::load(&path).unwrap();
        assert_eq!(back.job_id, man.job_id);
        assert_eq!(back.stage(StageId::Separate).unwrap().status, StageStatus::InFlight);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn in_flight_never_counts_as_up_to_date() {
        let dir = tmp_dir("inflight");
        let audio = input_ref(&dir, "a.bin", b"x");
        let mut man = JobManifest::new("j".into(), audio, None, &dir);
        man.mark_in_flight(StageId::Align, 1, "fp");
        assert!(!man.stage_up_to_date(StageId::Align, "fp"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn complete_stage_with_artifacts_resumes_until_inputs_change() {
        let dir = tmp_dir("resume");
        let audio = input_ref(&dir, "a.bin", b"x");
        let art_path = dir.join("vocals.wav");
        std::fs::write(&art_path, b"stem bytes").unwrap();
        let mut man = JobManifest::new("j".into(), audio, None, &dir);
        man.mark_in_flight(StageId::Separate, 1, "fp");
        man.mark_complete(
            StageId::Separate,
            1,
            vec![Artifact {
                name: "vocals".into(),
                path: art_path.clone(),
                bytes: 10,
            }],
            1.0,
        );
        assert!(man.stage_up_to_date(StageId::Separate, "fp"));
        // fingerprint change (new input content / config) invalidates
        assert!(!man.stage_up_to_date(StageId::Separate, "fp2"));
        // artifact size drift invalidates
        std::fs::write(&art_path, b"tampered!").unwrap();
        assert!(!man.stage_up_to_date(StageId::Separate, "fp"));
        // artifact deletion invalidates
        std::fs::remove_file(&art_path).unwrap();
        assert!(!man.stage_up_to_date(StageId::Separate, "fp"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn output_token_changes_on_rerun_but_not_on_skip() {
        let dir = tmp_dir("token");
        let audio = input_ref(&dir, "a.bin", b"x");
        let mut man = JobManifest::new("j".into(), audio, None, &dir);
        man.mark_in_flight(StageId::Separate, 1, "fp");
        man.mark_complete(StageId::Separate, 1, vec![], 1.0);
        let t1 = man.output_token(StageId::Separate).unwrap().to_string();
        // skip: token untouched
        assert_eq!(man.output_token(StageId::Separate).unwrap(), t1);
        // rerun: fresh token (completion time and/or artifacts differ)
        std::thread::sleep(std::time::Duration::from_millis(1100));
        man.mark_in_flight(StageId::Separate, 1, "fp");
        assert!(man.output_token(StageId::Separate).is_none()); // in-flight has no output
        man.mark_complete(StageId::Separate, 1, vec![], 2.0);
        assert_ne!(man.output_token(StageId::Separate).unwrap(), t1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn summary_status_reads_naturally() {
        let dir = tmp_dir("summary");
        let audio = input_ref(&dir, "a.bin", b"x");
        let mut man = JobManifest::new("j".into(), audio, None, &dir);
        assert_eq!(man.summary_status(), "partial");
        man.mark_in_flight(StageId::Separate, 1, "fp");
        assert_eq!(man.summary_status(), "interrupted@separate");
        man.mark_complete(StageId::Separate, 1, vec![], 1.0);
        man.mark_not_applicable(StageId::CleanLyrics, 1, "fp");
        man.mark_in_flight(StageId::Align, 1, "fp");
        man.mark_failed(StageId::Align, 1, "boom");
        assert_eq!(man.summary_status(), "failed@align");
        man.mark_in_flight(StageId::Align, 1, "fp");
        man.mark_complete(StageId::Align, 1, vec![], 1.0);
        man.mark_in_flight(StageId::Export, 1, "fp");
        man.mark_complete(StageId::Export, 1, vec![], 1.0);
        assert_eq!(man.summary_status(), "complete");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn registry_lists_jobs_and_tolerates_missing_manifests() {
        let dir = tmp_dir("registry");
        let jobs = dir.join("jobs");
        let audio = input_ref(&dir, "a.bin", b"x");
        let mut man = JobManifest::new("abc123".into(), audio, None, &dir);
        let man_path = JobManifest::manifest_path(&dir);
        man.save_atomic(&man_path).unwrap();
        write_pointer(
            &jobs,
            &JobPointer {
                job_id: "abc123".into(),
                manifest: man_path.clone(),
                audio: dir.join("a.bin"),
                out_dir: dir.clone(),
                updated_unix: 10,
            },
        )
        .unwrap();
        write_pointer(
            &jobs,
            &JobPointer {
                job_id: "gone00".into(),
                manifest: dir.join("nope").join("job.json"),
                audio: dir.join("b.bin"),
                out_dir: dir.join("nope"),
                updated_unix: 20,
            },
        )
        .unwrap();
        let listed = list_jobs(&jobs).unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].0.job_id, "gone00"); // newest first
        assert!(listed[0].1.is_none()); // manifest missing -> None
        assert!(listed[1].1.is_some());
        // empty/missing dir is not an error
        assert!(list_jobs(&dir.join("no-such")).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn job_id_is_stable_and_path_sensitive() {
        let a = job_id(Path::new("C:/x/song.mp3"), Path::new("C:/x/out"));
        assert_eq!(a, job_id(Path::new("C:/x/song.mp3"), Path::new("C:/x/out")));
        assert_ne!(a, job_id(Path::new("C:/x/song.mp3"), Path::new("C:/y/out")));
        assert_eq!(a.len(), 12);
    }
}
