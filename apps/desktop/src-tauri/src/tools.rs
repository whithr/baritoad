//! The external programs Add from URL runs — yt-dlp, Deno, and an ffmpeg
//! when there is one — and keeping yt-dlp current (docs/DEPENDENCIES.md).
//!
//! Search order for each program: the app's data folder
//! (`%LOCALAPPDATA%\baritoad\tools\`), the `tools\` bundled beside the app,
//! the dev checkout's `src-tauri\tools\` (debug builds; `pnpm fetch-tools`
//! fills it), then PATH.
//!
//! yt-dlp runs from the data folder so it can update itself: on first use
//! the bundled copy is copied there, and a newer bundled copy (after an app
//! update) replaces an older one. At most once a day, before a download, the
//! data-folder copy runs `yt-dlp -U` — sites change often enough that a
//! pinned copy stops working within weeks. A yt-dlp the user installed
//! themselves (PATH) is used as it is and never updated by us.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

use karaoke_core::fetch::{exe_name, Tools};
use karaoke_core::lrclib;

const UPDATE_EVERY_S: u64 = 24 * 60 * 60;
const LAST_UPDATE_FILE: &str = "last-update-check";

/// `%LOCALAPPDATA%\baritoad\tools\`, beside the library.
pub fn data_dir() -> PathBuf {
    karaoke_core::library::store::default_library_path().with_file_name("tools")
}

#[derive(Default)]
pub struct ToolsState {
    resolved: Mutex<Option<Tools>>,
    /// Serializes the daily update check (two downloads must not race it).
    update_lock: Mutex<()>,
}

impl ToolsState {
    /// The tools, found (and yt-dlp installed into the data folder) on first
    /// call, cached after. A missing yt-dlp is the error.
    pub fn get(&self, app: &AppHandle) -> Result<Tools, String> {
        let mut cached = self.resolved.lock().unwrap();
        if let Some(t) = cached.as_ref().filter(|t| t.ytdlp.is_file()) {
            return Ok(t.clone());
        }
        let bundled = bundled_dirs(app);
        if let Err(e) = install_ytdlp(&bundled, &data_dir()) {
            eprintln!("tools: couldn't install the bundled yt-dlp: {e}");
        }
        let mut dirs = vec![data_dir()];
        dirs.extend(bundled);
        let tools = Tools::locate(&dirs).ok_or_else(|| {
            "Add from URL needs yt-dlp, and baritoad couldn't find it. Reinstalling the app puts it back \
             (in a dev checkout: run `pnpm fetch-tools` in apps/desktop)."
                .to_string()
        })?;
        *cached = Some(tools.clone());
        Ok(tools)
    }

    /// Run `yt-dlp -U` on the data-folder copy if the last check was more
    /// than a day ago. Best effort: a failed update leaves the old copy.
    pub fn update_if_due(&self, tools: &Tools) -> Option<String> {
        if !tools.ytdlp.starts_with(data_dir()) {
            return None;
        }
        let _one = self.update_lock.lock().unwrap();
        let stamp = data_dir().join(LAST_UPDATE_FILE);
        let last = std::fs::read_to_string(&stamp).ok().and_then(|s| s.trim().parse::<u64>().ok()).unwrap_or(0);
        let now = unix_now();
        if now.saturating_sub(last) < UPDATE_EVERY_S {
            return None;
        }
        let _ = std::fs::write(&stamp, now.to_string());
        match tools.update() {
            Ok(msg) => Some(msg),
            Err(e) => {
                eprintln!("tools: {e}");
                None
            }
        }
    }
}

/// Where a bundled `tools\` folder can be: the app's resource dir, next to
/// the executable, and (debug builds) the dev checkout.
fn bundled_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(r) = app.path().resource_dir() {
        dirs.push(r.join("tools"));
    }
    if let Some(exe_dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)) {
        dirs.push(exe_dir.join("tools"));
    }
    #[cfg(debug_assertions)]
    dirs.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tools"));
    dirs.dedup();
    dirs
}

/// Copy the bundled yt-dlp into `data` when the data copy is missing, or
/// older than the bundled one (yt-dlp versions are dates, so they sort as
/// strings).
fn install_ytdlp(bundled: &[PathBuf], data: &Path) -> std::io::Result<()> {
    let name = exe_name("yt-dlp");
    let Some(src) = bundled.iter().map(|d| d.join(&name)).find(|p| p.is_file()) else {
        return Ok(());
    };
    let dest = data.join(&name);
    let replace = if dest.is_file() {
        let bundled_version = bundled_ytdlp_version(&src);
        let data_version = Tools { ytdlp: dest.clone(), deno: None, ffmpeg: None }.version().unwrap_or_default();
        !bundled_version.is_empty() && bundled_version > data_version
    } else {
        true
    };
    if replace {
        std::fs::create_dir_all(data)?;
        let tmp = data.join(format!("{name}.new"));
        copy_contents(&src, &tmp)?;
        std::fs::rename(&tmp, &dest)?;
    }
    Ok(())
}

/// The bundled yt-dlp's version, from the VERSIONS.json `pnpm fetch-tools`
/// wrote beside it, without running it — on macOS the bundled copy carries
/// the download's quarantine flag, and yt-dlp isn't notarized. Asks the
/// program itself only when the file isn't there (a dev checkout's tools).
fn bundled_ytdlp_version(src: &Path) -> String {
    let listed = src
        .parent()
        .and_then(|d| std::fs::read_to_string(d.join("VERSIONS.json")).ok())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v["yt-dlp"]["version"].as_str().map(str::to_string));
    listed.unwrap_or_else(|| Tools { ytdlp: src.to_path_buf(), deno: None, ffmpeg: None }.version().unwrap_or_default())
}

/// Copy the bytes only. `fs::copy` brings the extended attributes too, and
/// on macOS those include the quarantine flag every file of a downloaded app
/// carries: Gatekeeper would then refuse to run this copy, which sits outside
/// the app the person approved.
fn copy_contents(src: &Path, dest: &Path) -> std::io::Result<()> {
    let mut from = std::fs::File::open(src)?;
    let mut to = std::fs::File::create(dest)?;
    std::io::copy(&mut from, &mut to)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dest, std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(())
}

/// The LRCLIB client, identifying this app as LRCLIB asks.
pub fn lyrics_client(app: &AppHandle) -> lrclib::Client {
    lrclib::Client::new(&user_agent(app))
}

pub fn user_agent(app: &AppHandle) -> String {
    format!("baritoad/{} (desktop karaoke app)", app.package_info().version)
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    /// A stand-in yt-dlp: a script that prints `version`, beside a
    /// VERSIONS.json that lists `listed`.
    fn fake_bundle(dir: &Path, version: &str, listed: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(dir).unwrap();
        let exe = dir.join("yt-dlp");
        std::fs::write(&exe, format!("#!/bin/sh\necho {version}\n")).unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(dir.join("VERSIONS.json"), format!(r#"{{"yt-dlp": {{"version": "{listed}"}}}}"#)).unwrap();
        exe
    }

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("baritoad-tools-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn installs_a_runnable_copy_without_the_quarantine_flag() {
        use std::os::unix::fs::PermissionsExt;
        let root = scratch("install");
        let src = fake_bundle(&root.join("bundled"), "2026.08.19", "2026.08.19");
        #[cfg(target_os = "macos")]
        assert!(std::process::Command::new("xattr")
            .args(["-w", "com.apple.quarantine", "0081;00000000;Safari;"])
            .arg(&src)
            .status()
            .unwrap()
            .success());
        let data = root.join("data");
        install_ytdlp(&[root.join("bundled")], &data).unwrap();
        let dest = data.join("yt-dlp");
        assert_eq!(std::fs::read(&dest).unwrap(), std::fs::read(&src).unwrap());
        assert_eq!(std::fs::metadata(&dest).unwrap().permissions().mode() & 0o777, 0o755);
        #[cfg(target_os = "macos")]
        assert!(!std::process::Command::new("xattr")
            .args(["-p", "com.apple.quarantine"])
            .arg(&dest)
            .output()
            .unwrap()
            .status
            .success());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_newer_bundled_copy_replaces_the_data_copy_going_by_versions_json() {
        let root = scratch("update");
        // The bundled program would say an old version if it were run; the
        // listed one is what counts.
        fake_bundle(&root.join("bundled"), "2000.01.01", "2026.08.19");
        let data = root.join("data");
        fake_bundle(&data, "2026.01.01", "unused");
        install_ytdlp(&[root.join("bundled")], &data).unwrap();
        let installed = Tools { ytdlp: data.join("yt-dlp"), deno: None, ffmpeg: None }.version().unwrap();
        assert_eq!(installed, "2000.01.01", "the bundled copy should have replaced the older data copy");
        let _ = std::fs::remove_dir_all(&root);
    }
}
