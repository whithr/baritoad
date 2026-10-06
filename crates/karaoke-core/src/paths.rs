//! Where baritoad keeps its per-user data, and the one-time move from the
//! folder it used before the rename.
//!
//! `%LOCALAPPDATA%\baritoad` on Windows (elsewhere, for now,
//! `~/.local/share/baritoad`). Everything lives under it: `library.db`,
//! `covers`, `jobs`, `downloads`, `tools`, `themes`, `models`, and the
//! webview's own profile (`webview` — so settings don't depend on the app
//! identifier).
//!
//! Until the move has happened (or if it failed), [`data_dir`] keeps
//! answering with the old `karaoke` folder, so nothing ever opens an empty
//! library while the old one sits next to it — the CLI included, which never
//! moves anything itself.

use std::path::{Path, PathBuf};

use crate::{Error, Result};

pub const DATA_DIR_NAME: &str = "baritoad";
/// The data folder's name before the rename.
pub const LEGACY_DATA_DIR_NAME: &str = "karaoke";
/// The Tauri identifier before the rename; its webview profile held the
/// settings (Windows: `%LOCALAPPDATA%\dev.karaoke.desktop\EBWebView`).
pub const LEGACY_IDENTIFIER: &str = "dev.karaoke.desktop";
/// Left in the old folder after the move.
pub const MOVED_NOTE: &str = "MOVED.txt";

const LIBRARY_DB: &str = "library.db";
const MODELS: &str = "models";
const WEBVIEW: &str = "webview";

/// `%LOCALAPPDATA%` (POSIX: `~/.local/share`).
fn local_root() -> PathBuf {
    if let Ok(lad) = std::env::var("LOCALAPPDATA") {
        return PathBuf::from(lad);
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join(".local").join("share");
    }
    PathBuf::from(".")
}

/// The data folder after the rename, whether or not anything is in it yet.
pub fn new_data_dir() -> PathBuf {
    local_root().join(DATA_DIR_NAME)
}

pub fn legacy_data_dir() -> PathBuf {
    local_root().join(LEGACY_DATA_DIR_NAME)
}

/// The per-user data root: the new folder, unless the old one still holds
/// the only library (before the move, or after a failed one).
pub fn data_dir() -> PathBuf {
    pick(&new_data_dir(), &legacy_data_dir())
}

fn pick(new: &Path, old: &Path) -> PathBuf {
    if !new.join(LIBRARY_DB).exists() && old.join(LIBRARY_DB).exists() {
        old.to_path_buf()
    } else {
        new.to_path_buf()
    }
}

/// The models folder — the old one while the move hasn't reached it.
pub fn models_dir() -> PathBuf {
    let dir = data_dir().join(MODELS);
    let old = legacy_data_dir().join(MODELS);
    if !dir.exists() && old.exists() {
        old
    } else {
        dir
    }
}

/// The webview profile's folder (WebView2's user data folder on Windows):
/// in the data folder — or, while the old folder is still the one in use,
/// the old identifier's profile, where the settings still are.
pub fn webview_dir() -> PathBuf {
    let dir = data_dir();
    if dir == legacy_data_dir() {
        local_root().join(LEGACY_IDENTIFIER)
    } else {
        dir.join(WEBVIEW)
    }
}

/// The settings' old home: WebView2 keeps localStorage under
/// `<profile>\EBWebView\Default\Local Storage`.
pub fn legacy_webview_storage() -> PathBuf {
    local_root().join(LEGACY_IDENTIFIER).join(webview_storage_rel())
}

fn webview_storage_rel() -> PathBuf {
    Path::new("EBWebView").join("Default").join("Local Storage")
}

/// What the move did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Moved {
    pub files_copied: u64,
    pub bytes_copied: u64,
    /// Paths in the library and in job files changed to the new folder.
    pub paths_rewritten: u64,
    /// The webview's storage (the settings) came along.
    pub settings: bool,
    /// The models folder moved too (it isn't copied — see [`migrate`]).
    pub models: bool,
    /// Links (junctions) outside the models folder aren't copied.
    pub skipped_links: Vec<PathBuf>,
}

/// The move at startup, between the default folders.
pub fn migrate_default() -> Result<Option<Moved>> {
    migrate(&legacy_data_dir(), &new_data_dir(), Some(&legacy_webview_storage()))
}

/// Move `old` to `new` once: copy everything but the models into a staging
/// folder (the library through SQLite, so a live WAL comes along),
/// point every stored path at the new folder, bring the webview's storage
/// (the settings), then rename the staging folder into place — the step
/// that makes the move count. The models folder is renamed rather than
/// copied: it's most of the bytes, it can be downloaded again, and a rename
/// keeps any links inside it. The old folder stays as it was, apart from
/// its models, with a note saying where everything went.
///
/// Nothing to do (`Ok(None)`) when `new` already has a library or `old`
/// never had one. A move cut off before the rename leaves only the staging
/// folder, which the next try throws away.
pub fn migrate(old: &Path, new: &Path, old_webview_storage: Option<&Path>) -> Result<Option<Moved>> {
    let mut moved = None;
    if !new.join(LIBRARY_DB).exists() && old.join(LIBRARY_DB).exists() {
        moved = Some(copy_over(old, new, old_webview_storage)?);
    }
    // Also on later starts: the models step can fail on its own (a file in
    // use) and gets another go each launch.
    let models = move_models(old, new);
    if let Some(m) = moved.as_mut() {
        m.models = models;
        let note = format!(
            "baritoad keeps its data in {} now (moved {}).\r\n\r\n\
             This folder is the copy it left behind: safe to delete once baritoad \
             shows your library. The models moved rather than copied.\r\n",
            new.display(),
            unix_date(),
        );
        let _ = std::fs::write(old.join(MOVED_NOTE), note);
    }
    Ok(moved)
}

fn copy_over(old: &Path, new: &Path, old_webview_storage: Option<&Path>) -> Result<Moved> {
    let name = new
        .file_name()
        .ok_or_else(|| Error::InvalidInput(format!("not a data folder: {}", new.display())))?;
    let staging = new.with_file_name(format!("{}.moving", name.to_string_lossy()));
    if staging.exists() {
        std::fs::remove_dir_all(&staging)?;
    }
    std::fs::create_dir_all(&staging)?;
    let mut m = Moved::default();

    for entry in std::fs::read_dir(old)? {
        let entry = entry?;
        let n = entry.file_name();
        let n = n.to_string_lossy();
        if n == MODELS || n == MOVED_NOTE || n.starts_with(LIBRARY_DB) {
            continue;
        }
        copy_tree(&entry.path(), &staging.join(entry.file_name()), &mut m)?;
    }

    // The library: a consistent copy, WAL included.
    let db = staging.join(LIBRARY_DB);
    {
        let src = rusqlite::Connection::open_with_flags(
            old.join(LIBRARY_DB),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| Error::Db(format!("couldn't open the old library: {e}")))?;
        src.execute("VACUUM INTO ?1", [db.to_string_lossy().as_ref()])
            .map_err(|e| Error::Db(format!("couldn't copy the library: {e}")))?;
    }
    m.files_copied += 1;
    m.bytes_copied += std::fs::metadata(&db).map(|x| x.len()).unwrap_or(0);
    m.paths_rewritten += rewrite_db(&db, old, new)?;
    m.paths_rewritten += rewrite_json_tree(&staging, old, new)?;

    if let Some(src) = old_webview_storage.filter(|p| p.is_dir()) {
        copy_tree(src, &staging.join(WEBVIEW).join(webview_storage_rel()), &mut m)?;
        m.settings = true;
    }

    if new.exists() {
        // Something made the folder already (but no library): fold in.
        for entry in std::fs::read_dir(&staging)? {
            let entry = entry?;
            let dest = new.join(entry.file_name());
            if !dest.exists() {
                std::fs::rename(entry.path(), dest)?;
            }
        }
        std::fs::remove_dir_all(&staging)?;
    } else {
        std::fs::rename(&staging, new)?;
    }
    Ok(m)
}

fn move_models(old: &Path, new: &Path) -> bool {
    let (from, to) = (old.join(MODELS), new.join(MODELS));
    if !from.exists() || to.exists() || !new.join(LIBRARY_DB).exists() {
        return false;
    }
    match std::fs::rename(&from, &to) {
        Ok(()) => true,
        Err(e) => {
            // models_dir() keeps using the old one; next start tries again.
            eprintln!("data folder: the models stay in {} for now: {e}", from.display());
            false
        }
    }
}

fn copy_tree(src: &Path, dest: &Path, m: &mut Moved) -> Result<()> {
    let meta = std::fs::symlink_metadata(src)?;
    if meta.file_type().is_symlink() {
        m.skipped_links.push(src.to_path_buf());
        return Ok(());
    }
    if meta.is_dir() {
        std::fs::create_dir_all(dest)?;
        for entry in std::fs::read_dir(src)? {
            let entry = entry?;
            copy_tree(&entry.path(), &dest.join(entry.file_name()), m)?;
        }
    } else {
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        m.bytes_copied += std::fs::copy(src, dest)?;
        m.files_copied += 1;
    }
    Ok(())
}

/// `old` in the spellings a stored path can start with: either separator,
/// any letter case (Windows paths are case-blind).
fn prefixes(old: &Path) -> Vec<String> {
    let s = old.to_string_lossy().trim_end_matches(['\\', '/']).to_string();
    let mut v = vec![format!("{s}\\"), format!("{s}/"), s.replace('\\', "/") + "/"];
    v.sort();
    v.dedup();
    v
}

/// `value` with an `old` prefix swapped for `new`, keeping the separator
/// that followed it.
fn swap_prefix(value: &str, old: &Path, new: &Path) -> Option<String> {
    let new_s = new.to_string_lossy().trim_end_matches(['\\', '/']).to_string();
    for p in prefixes(old) {
        if value.len() >= p.len() && value.is_char_boundary(p.len()) && value[..p.len()].eq_ignore_ascii_case(&p) {
            let sep = &p[p.len() - 1..];
            let base = if sep == "/" { new_s.replace('\\', "/") } else { new_s.clone() };
            return Some(format!("{base}{sep}{}", &value[p.len()..]));
        }
    }
    // The folder itself, with nothing after it.
    let bare = old.to_string_lossy().trim_end_matches(['\\', '/']).to_string();
    if value.eq_ignore_ascii_case(&bare) {
        return Some(new_s);
    }
    None
}

/// Every text value in every table that names something under `old`.
fn rewrite_db(db: &Path, old: &Path, new: &Path) -> Result<u64> {
    let fail = |e: rusqlite::Error| Error::Db(format!("couldn't update the library's paths: {e}"));
    let mut conn = rusqlite::Connection::open(db).map_err(fail)?;
    let tx = conn.transaction().map_err(fail)?;
    let tables: Vec<String> = {
        let mut st = tx
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
            .map_err(fail)?;
        let rows = st.query_map([], |r| r.get::<_, String>(0)).map_err(fail)?;
        rows.collect::<std::result::Result<_, _>>().map_err(fail)?
    };
    let mut changed = 0u64;
    for t in tables {
        let cols: Vec<String> = {
            let mut st = tx.prepare(&format!("PRAGMA table_info(\"{t}\")")).map_err(fail)?;
            let rows = st.query_map([], |r| r.get::<_, String>(1)).map_err(fail)?;
            rows.collect::<std::result::Result<_, _>>().map_err(fail)?
        };
        for c in cols {
            let hits: Vec<(i64, String)> = {
                let mut st = tx
                    .prepare(&format!("SELECT rowid, \"{c}\" FROM \"{t}\" WHERE typeof(\"{c}\") = 'text'"))
                    .map_err(fail)?;
                let rows = st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))).map_err(fail)?;
                rows.filter_map(|r| r.ok())
                    .filter_map(|(id, v)| swap_prefix(&v, old, new).map(|s| (id, s)))
                    .collect()
            };
            for (id, v) in hits {
                tx.execute(&format!("UPDATE \"{t}\" SET \"{c}\" = ?1 WHERE rowid = ?2"), rusqlite::params![v, id])
                    .map_err(fail)?;
                changed += 1;
            }
        }
    }
    tx.commit().map_err(fail)?;
    Ok(changed)
}

/// Job manifests, the import queue and the like store absolute paths as
/// JSON strings; swap the old folder for the new in each `.json` under `dir`.
fn rewrite_json_tree(dir: &Path, old: &Path, new: &Path) -> Result<u64> {
    let mut changed = 0u64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for entry in std::fs::read_dir(&d)? {
            let entry = entry?;
            let p = entry.path();
            let ft = entry.file_type()?;
            if ft.is_dir() {
                stack.push(p);
            } else if ft.is_file()
                && p.extension().is_some_and(|e| e.eq_ignore_ascii_case("json"))
                && entry.metadata().map(|x| x.len() < 64 * 1024 * 1024).unwrap_or(false)
            {
                let Ok(text) = std::fs::read_to_string(&p) else { continue };
                let (out, n) = rewrite_json_text(&text, old, new);
                if n > 0 {
                    std::fs::write(&p, out)?;
                    changed += n;
                }
            }
        }
    }
    Ok(changed)
}

/// Swap the old folder inside JSON string values (where `\` is `\\`).
fn rewrite_json_text(text: &str, old: &Path, new: &Path) -> (String, u64) {
    let old_s = old.to_string_lossy().trim_end_matches(['\\', '/']).to_string();
    let new_s = new.to_string_lossy().trim_end_matches(['\\', '/']).to_string();
    let pairs = [
        (format!("\"{}\\\\", old_s.replace('\\', "\\\\")), format!("\"{}\\\\", new_s.replace('\\', "\\\\"))),
        (format!("\"{}/", old_s.replace('\\', "/")), format!("\"{}/", new_s.replace('\\', "/"))),
        (format!("\"{}\"", old_s.replace('\\', "\\\\")), format!("\"{}\"", new_s.replace('\\', "\\\\"))),
    ];
    let mut out = text.to_string();
    let mut n = 0u64;
    for (from, to) in pairs {
        let (o, k) = replace_ignore_case(&out, &from, &to);
        out = o;
        n += k;
    }
    (out, n)
}

fn replace_ignore_case(hay: &str, needle: &str, with: &str) -> (String, u64) {
    let lower_hay = hay.to_ascii_lowercase();
    let lower_needle = needle.to_ascii_lowercase();
    let mut out = String::with_capacity(hay.len());
    let mut last = 0;
    let mut n = 0;
    let mut from = 0;
    while let Some(i) = lower_hay[from..].find(&lower_needle) {
        let at = from + i;
        out.push_str(&hay[last..at]);
        out.push_str(with);
        last = at + needle.len();
        from = last;
        n += 1;
    }
    out.push_str(&hay[last..]);
    (out, n)
}

fn unix_date() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = (secs / 86_400) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(mo <= 2);
    format!("{y:04}-{mo:02}-{d:02}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn swaps_either_separator_and_case() {
        let old = Path::new(r"C:\Users\h\AppData\Local\karaoke");
        let new = Path::new(r"C:\Users\h\AppData\Local\baritoad");
        assert_eq!(
            swap_prefix(r"C:\Users\h\AppData\Local\karaoke\covers\a.png", old, new).as_deref(),
            Some(r"C:\Users\h\AppData\Local\baritoad\covers\a.png")
        );
        assert_eq!(
            swap_prefix(r"c:\users\h\appdata\local\KARAOKE\jobs\x", old, new).as_deref(),
            Some(r"C:\Users\h\AppData\Local\baritoad\jobs\x")
        );
        assert_eq!(
            swap_prefix("C:/Users/h/AppData/Local/karaoke/downloads/s.mp3", old, new).as_deref(),
            Some("C:/Users/h/AppData/Local/baritoad/downloads/s.mp3")
        );
        // Not under it: a sibling with the same start, a song's own folder.
        assert_eq!(swap_prefix(r"C:\Users\h\AppData\Local\karaoke-lab\x", old, new), None);
        assert_eq!(swap_prefix(r"C:\Users\h\Music\karaoke\x.mp3", old, new), None);
    }

    #[test]
    fn json_paths_swap_inside_strings_only() {
        let old = Path::new(r"C:\L\karaoke");
        let new = Path::new(r"C:\L\baritoad");
        let text = r#"{"audio":"C:\\L\\karaoke\\downloads\\a.mp3","out":"C:\\L\\karaoke","other":"C:\\L\\karaoke-lab\\b","title":"karaoke"}"#;
        let (out, n) = rewrite_json_text(text, old, new);
        assert_eq!(n, 2);
        assert_eq!(
            out,
            r#"{"audio":"C:\\L\\baritoad\\downloads\\a.mp3","out":"C:\\L\\baritoad","other":"C:\\L\\karaoke-lab\\b","title":"karaoke"}"#
        );
    }

    #[test]
    fn picks_the_old_folder_until_the_move() {
        let t = std::env::temp_dir().join(format!("bt-pick-{}", std::process::id()));
        let (old, new) = (t.join("karaoke"), t.join("baritoad"));
        std::fs::create_dir_all(&old).unwrap();
        assert_eq!(pick(&new, &old), new, "fresh install");
        std::fs::write(old.join(LIBRARY_DB), b"").unwrap();
        assert_eq!(pick(&new, &old), old, "not moved yet");
        std::fs::create_dir_all(&new).unwrap();
        std::fs::write(new.join(LIBRARY_DB), b"").unwrap();
        assert_eq!(pick(&new, &old), new, "moved");
        std::fs::remove_dir_all(&t).unwrap();
    }

    #[test]
    fn date_is_civil() {
        let d = unix_date();
        assert_eq!(d.len(), 10);
        assert!(d.starts_with("20"));
    }
}
