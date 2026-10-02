//! The model manager (PLAN.md §3 "Model manager", §5 "Model mirror"): which
//! weights the pipeline needs, whether they're on disk, and downloading them
//! from our mirror with resume and a checksum check.
//!
//! The weights come in packs:
//! - **core** — separation (htdemucs) and word timing (wav2vec2): every song.
//! - **transcription** — whisper-small, only for songs with no lyrics.
//! - **high_quality** — the htdemucs_ft vocals model for the "High-quality
//!   separation" box (the app's HQ mode loads only that one, separation docs).
//!
//! What's in each pack — path under the models folder, size, sha256 — is
//! data ([`manifest.json`](manifest.json)), checked against MODEL_LICENSES.md.
//! The mirror lays files out exactly as the models folder does, under the
//! manifest's `mirror_path`, so a download is `<base>/<mirror_path>/<path>`.
//!
//! A download writes `<file>.part`, resumes it with an HTTP Range request,
//! checks the sha256 of the whole file, then renames it into place — a file
//! is either complete and verified or absent. Network calls happen only when
//! the person starts a download (PLAN.md §2).

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{Error, Result};

/// Built-in mirror address: our Cloudflare R2 bucket on its custom domain
/// (PLAN.md §5), live 2026-10-02. Files sit at `<mirror>/v1/<manifest path>`
/// with each model's license beside it. `KARAOKE_MODEL_MIRROR` overrides it
/// (dev and tests).
pub const DEFAULT_MIRROR: &str = "https://models.baritoad.com";
pub const MIRROR_ENV: &str = "KARAOKE_MODEL_MIRROR";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Pack {
    Core,
    Transcription,
    HighQuality,
}

impl Pack {
    pub const ALL: [Pack; 3] = [Pack::Core, Pack::Transcription, Pack::HighQuality];
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ModelFile {
    pub pack: Pack,
    /// Under the models folder, forward slashes ("wav2vec2/vocab.json").
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Manifest {
    /// Folder on the mirror these files sit under ("v1").
    pub mirror_path: String,
    pub files: Vec<ModelFile>,
}

static MANIFEST: OnceLock<Manifest> = OnceLock::new();

/// The manifest built into this version of baritoad.
pub fn manifest() -> &'static Manifest {
    MANIFEST.get_or_init(|| serde_json::from_str(include_str!("manifest.json")).expect("models/manifest.json parses"))
}

/// Where downloads come from: the env override, else [`DEFAULT_MIRROR`].
pub fn mirror_base() -> String {
    std::env::var(MIRROR_ENV)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_MIRROR.to_string())
        .trim_end_matches('/')
        .to_string()
}

pub fn url_for(base: &str, m: &Manifest, f: &ModelFile) -> String {
    format!("{}/{}/{}", base.trim_end_matches('/'), m.mirror_path.trim_matches('/'), f.path)
}

fn local_path(models_dir: &Path, f: &ModelFile) -> PathBuf {
    f.path.split('/').fold(models_dir.to_path_buf(), |p, seg| p.join(seg))
}

fn part_path(final_path: &Path) -> PathBuf {
    let mut s = final_path.as_os_str().to_owned();
    s.push(".part");
    PathBuf::from(s)
}

// ---------------------------------------------------------------- status

#[derive(Debug, Clone, Serialize)]
pub struct PackStatus {
    pub pack: Pack,
    /// Every file is there at its full size.
    pub installed: bool,
    /// Every file is there, maybe an older version (a different size) —
    /// enough to run; `outdated` lists what an update would replace.
    pub usable: bool,
    pub outdated: Vec<String>,
    pub bytes_total: u64,
    /// On disk already, counting partial downloads.
    pub bytes_present: u64,
    /// Files not on disk at all (manifest paths).
    pub missing: Vec<String>,
}

/// What's on disk for each pack. A file counts when it exists at its
/// manifest size; its checksum was checked when it was downloaded. (A
/// models folder set up by hand — the dev setup — passes on size alone.)
pub fn status(models_dir: &Path) -> Vec<PackStatus> {
    status_of(models_dir, manifest())
}

pub fn status_of(models_dir: &Path, m: &Manifest) -> Vec<PackStatus> {
    Pack::ALL
        .iter()
        .map(|&pack| {
            let files: Vec<&ModelFile> = m.files.iter().filter(|f| f.pack == pack).collect();
            let mut present = 0u64;
            let mut missing = Vec::new();
            let mut outdated = Vec::new();
            for f in &files {
                let p = local_path(models_dir, f);
                match std::fs::metadata(&p) {
                    Ok(md) if md.len() == f.size => present += f.size,
                    Ok(md) if md.is_file() => {
                        outdated.push(f.path.clone());
                        present += std::fs::metadata(part_path(&p)).map(|m| m.len().min(f.size)).unwrap_or(0);
                    }
                    _ => {
                        missing.push(f.path.clone());
                        present += std::fs::metadata(part_path(&p)).map(|m| m.len().min(f.size)).unwrap_or(0);
                    }
                }
            }
            PackStatus {
                pack,
                installed: missing.is_empty() && outdated.is_empty(),
                usable: missing.is_empty(),
                outdated,
                bytes_total: files.iter().map(|f| f.size).sum(),
                bytes_present: present,
                missing,
            }
        })
        .collect()
}

/// Every file of `pack` is on disk (an older version counts — it runs).
pub fn pack_usable(models_dir: &Path, pack: Pack) -> bool {
    status(models_dir).iter().any(|s| s.pack == pack && s.usable)
}

// -------------------------------------------------------------- download

#[derive(Debug, Clone, Serialize)]
pub struct Progress {
    pub pack: Pack,
    /// The file being fetched (manifest path).
    pub file: String,
    /// Bytes of the whole pack on disk so far, and the pack's size.
    pub done: u64,
    pub total: u64,
}

/// Free space where `dir` lives, when the OS says.
pub fn free_space(dir: &Path) -> Option<u64> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        extern "system" {
            fn GetDiskFreeSpaceExW(dir: *const u16, avail: *mut u64, total: *mut u64, free: *mut u64) -> i32;
        }
        // The folder may not exist yet: ask about its nearest existing parent.
        let mut probe = dir.to_path_buf();
        while !probe.exists() {
            probe = probe.parent()?.to_path_buf();
        }
        let wide: Vec<u16> = probe.as_os_str().encode_wide().chain(Some(0)).collect();
        let (mut avail, mut total, mut free) = (0u64, 0u64, 0u64);
        // SAFETY: a NUL-terminated wide path and three out-params.
        let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut avail, &mut total, &mut free) };
        (ok != 0).then_some(avail)
    }
    #[cfg(not(windows))]
    {
        let _ = dir;
        None
    }
}

fn agent(user_agent: &str) -> ureq::Agent {
    let tls = ureq::tls::TlsConfig::builder()
        .provider(ureq::tls::TlsProvider::NativeTls)
        .root_certs(ureq::tls::RootCerts::PlatformVerifier)
        .build();
    ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .timeout_connect(Some(Duration::from_secs(20)))
            .timeout_recv_response(Some(Duration::from_secs(30)))
            .user_agent(user_agent)
            .tls_config(tls)
            .http_status_as_error(false)
            .build(),
    )
}

/// Fetch every missing file of `pack` into `models_dir`. Resumes partial
/// files, checks each one's sha256, and stops (keeping the partial file for
/// next time) when `cancel` is set. Refuses to start without room for it.
pub fn download_pack(
    models_dir: &Path,
    pack: Pack,
    base: &str,
    user_agent: &str,
    cancel: &AtomicBool,
    on_progress: &mut dyn FnMut(&Progress),
) -> Result<()> {
    download_pack_from(models_dir, manifest(), pack, base, user_agent, cancel, on_progress)
}

pub fn download_pack_from(
    models_dir: &Path,
    m: &Manifest,
    pack: Pack,
    base: &str,
    user_agent: &str,
    cancel: &AtomicBool,
    on_progress: &mut dyn FnMut(&Progress),
) -> Result<()> {
    let st = status_of(models_dir, m)
        .into_iter()
        .find(|s| s.pack == pack)
        .expect("every pack has a status");
    if st.installed {
        return Ok(());
    }
    let needed = st.bytes_total - st.bytes_present;
    if let Some(avail) = free_space(models_dir) {
        // Room for the rest, plus a little to spare.
        if avail < needed + 64 * 1024 * 1024 {
            return Err(Error::InvalidInput(format!(
                "not enough disk space: the download needs {} MB more and {} MB is free",
                needed / 1_000_000,
                avail / 1_000_000
            )));
        }
    }
    let agent = agent(user_agent);
    let mut done = st.bytes_present;
    for f in m.files.iter().filter(|f| f.pack == pack) {
        let dest = local_path(models_dir, f);
        if std::fs::metadata(&dest).map(|md| md.len() == f.size).unwrap_or(false) {
            continue;
        }
        let part = part_path(&dest);
        let had = std::fs::metadata(&part).map(|md| md.len()).unwrap_or(0).min(f.size);
        done -= had; // fetch_file reports this file's bytes from zero
        fetch_file(&agent, &url_for(base, m, f), f, &dest, cancel, &mut |file_bytes| {
            on_progress(&Progress { pack, file: f.path.clone(), done: done + file_bytes, total: st.bytes_total });
        })?;
        done += f.size;
    }
    Ok(())
}

/// One file: resume `<dest>.part`, verify, rename. `on_bytes` gets this
/// file's bytes on disk.
fn fetch_file(
    agent: &ureq::Agent,
    url: &str,
    f: &ModelFile,
    dest: &Path,
    cancel: &AtomicBool,
    on_bytes: &mut dyn FnMut(u64),
) -> Result<()> {
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let part = part_path(dest);
    let mut have = std::fs::metadata(&part).map(|md| md.len()).unwrap_or(0);
    if have > f.size {
        std::fs::remove_file(&part)?;
        have = 0;
    }
    if have < f.size {
        let mut req = agent.get(url);
        if have > 0 {
            req = req.header("Range", format!("bytes={have}-"));
        }
        let net = |e: ureq::Error| Error::Network(format!("{url}: {e}"));
        let mut resp = req.call().map_err(net)?;
        let status = resp.status().as_u16();
        let resumed = match status {
            206 => true,
            200 => false, // the server sent the whole file: start over
            _ => return Err(Error::Network(format!("{url}: the mirror answered {status}"))),
        };
        let mut out = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(resumed)
            .truncate(!resumed)
            .open(&part)?;
        if !resumed {
            have = 0;
        }
        on_bytes(have);
        let mut body = resp.body_mut().as_reader();
        let mut buf = vec![0u8; 256 * 1024];
        loop {
            if cancel.load(Ordering::Relaxed) {
                out.flush()?;
                return Err(Error::Cancelled);
            }
            let n = body.read(&mut buf).map_err(|e| Error::Network(format!("{url}: {e}")))?;
            if n == 0 {
                break;
            }
            if have + n as u64 > f.size {
                return Err(Error::Network(format!("{url}: the mirror sent more than {} bytes", f.size)));
            }
            out.write_all(&buf[..n])?;
            have += n as u64;
            on_bytes(have);
        }
        out.flush()?;
        drop(out);
        if have != f.size {
            return Err(Error::Network(format!(
                "{url}: the download stopped at {have} of {} bytes — it picks up from there next time",
                f.size
            )));
        }
    }
    let got = sha256_file(&part)?;
    if !got.eq_ignore_ascii_case(&f.sha256) {
        std::fs::remove_file(&part)?;
        return Err(Error::Model(format!(
            "{} didn't match its checksum (got {got}); it was removed — try again",
            f.path
        )));
    }
    if dest.exists() {
        std::fs::remove_file(dest)?;
    }
    std::fs::rename(&part, dest)?;
    Ok(())
}

pub fn sha256_file(path: &Path) -> Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_built_in_manifest_is_complete() {
        let m = manifest();
        for pack in Pack::ALL {
            assert!(m.files.iter().any(|f| f.pack == pack), "{pack:?} has files");
        }
        for f in &m.files {
            assert_eq!(f.sha256.len(), 64, "{} sha256", f.path);
            assert!(f.size > 0, "{} size", f.path);
            assert!(!f.path.contains('\\') && !f.path.starts_with('/'), "{} is relative", f.path);
        }
        // Exactly what the loaders open.
        let core: Vec<&str> = m.files.iter().filter(|f| f.pack == Pack::Core).map(|f| f.path.as_str()).collect();
        assert!(core.contains(&crate::separation::MODEL_FILE_NAME));
        assert!(core.contains(&"wav2vec2/wav2vec2-base-960h.onnx"));
    }

    #[test]
    fn urls_follow_the_models_folder() {
        let m = Manifest {
            mirror_path: "v1".into(),
            files: vec![ModelFile { pack: Pack::Core, path: "wav2vec2/vocab.json".into(), size: 1, sha256: "0".repeat(64) }],
        };
        assert_eq!(url_for("https://m.example/", &m, &m.files[0]), "https://m.example/v1/wav2vec2/vocab.json");
    }
}
