//! The one-time data-folder move (karaoke → baritoad, paths.rs) on a
//! made-up old folder: library with a live WAL, covers, a job manifest, the
//! import queue, the models, and the old webview's storage.

use std::path::{Path, PathBuf};

use karaoke_core::paths::{migrate, MOVED_NOTE};
use rusqlite::Connection;

fn tmp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("baritoad-move-test-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn write(p: &Path, bytes: &[u8]) {
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, bytes).unwrap();
}

/// The old folder; the returned connection keeps the WAL un-checkpointed.
fn old_folder(root: &Path) -> (PathBuf, PathBuf, Connection) {
    let old = root.join("karaoke");
    let webview = root.join("dev.karaoke.desktop").join("EBWebView").join("Default").join("Local Storage");
    write(&webview.join("leveldb").join("000003.log"), b"settings");
    write(&old.join("covers").join("abc.png"), b"png");
    write(&old.join("models").join("htdemucs.onnx"), b"weights");
    write(&old.join("tools").join("yt-dlp.exe"), b"exe");
    let s = |p: PathBuf| p.to_string_lossy().into_owned();
    let job = old.join("downloads").join("Song-karaoke");
    write(
        &job.join("manifest.json"),
        serde_json::json!({ "audio": s(old.join("downloads").join("Song.flac")), "out_dir": s(job.clone()), "title": "karaoke night" })
            .to_string()
            .as_bytes(),
    );
    write(&old.join("import-queue.json"), serde_json::json!([{ "audio": s(old.join("downloads").join("Song.flac")) }]).to_string().as_bytes());

    let db = Connection::open(old.join("library.db")).unwrap();
    db.pragma_update(None, "journal_mode", "WAL").unwrap();
    db.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
    db.execute_batch(
        "CREATE TABLE songs (id INTEGER PRIMARY KEY, title TEXT, audio_path TEXT, job_dir TEXT, cover_path TEXT);
         CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);",
    )
    .unwrap();
    db.execute(
        "INSERT INTO songs (title, audio_path, job_dir, cover_path) VALUES ('karaoke', ?1, ?2, ?3)",
        [s(old.join("downloads").join("Song.flac")), s(job), s(old.join("covers").join("abc.png"))],
    )
    .unwrap();
    // A song that lives outside the data folder keeps its paths.
    db.execute(
        "INSERT INTO songs (title, audio_path, job_dir) VALUES ('mine', ?1, ?2)",
        [s(root.join("Music").join("mine.mp3")), s(root.join("Music").join("mine-karaoke"))],
    )
    .unwrap();
    (old, root.join("dev.karaoke.desktop").join("EBWebView").join("Default").join("Local Storage"), db)
}

#[test]
fn moves_once_and_points_everything_at_the_new_folder() {
    let root = tmp_dir("full");
    let (old, webview, live) = old_folder(&root);
    let new = root.join("baritoad");
    assert!(old.join("library.db-wal").exists(), "the WAL holds the rows");

    let moved = migrate(&old, &new, Some(&webview)).unwrap().expect("moved");
    drop(live);
    assert!(moved.settings && moved.models);
    assert_eq!(moved.paths_rewritten, 3 + 3, "3 library paths + 3 in JSON files");

    // The library, WAL rows included, now names the new folder.
    let db = Connection::open(new.join("library.db")).unwrap();
    let rows: Vec<(String, String, String, Option<String>)> = db
        .prepare("SELECT title, audio_path, job_dir, cover_path FROM songs ORDER BY id")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].0, "karaoke", "titles aren't paths");
    assert_eq!(PathBuf::from(&rows[0].1), new.join("downloads").join("Song.flac"));
    assert_eq!(PathBuf::from(&rows[0].2), new.join("downloads").join("Song-karaoke"));
    assert_eq!(PathBuf::from(rows[0].3.as_ref().unwrap()), new.join("covers").join("abc.png"));
    assert_eq!(PathBuf::from(&rows[1].1), root.join("Music").join("mine.mp3"));

    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(new.join("downloads").join("Song-karaoke").join("manifest.json")).unwrap()).unwrap();
    assert_eq!(PathBuf::from(manifest["audio"].as_str().unwrap()), new.join("downloads").join("Song.flac"));
    assert_eq!(manifest["title"], "karaoke night");
    let queue = std::fs::read_to_string(new.join("import-queue.json")).unwrap();
    assert!(!queue.contains("karaoke\\\\downloads") && !queue.contains("karaoke/downloads"), "{queue}");

    // Files came along; the models moved; the settings came along.
    assert_eq!(std::fs::read(new.join("covers").join("abc.png")).unwrap(), b"png");
    assert_eq!(std::fs::read(new.join("tools").join("yt-dlp.exe")).unwrap(), b"exe");
    assert_eq!(std::fs::read(new.join("models").join("htdemucs.onnx")).unwrap(), b"weights");
    assert_eq!(
        std::fs::read(new.join("webview").join("EBWebView").join("Default").join("Local Storage").join("leveldb").join("000003.log")).unwrap(),
        b"settings"
    );
    assert!(!new.with_file_name("baritoad.moving").exists(), "staging folder gone");

    // The old folder stays (but for its models), with a note.
    assert!(old.join("library.db").exists() && old.join("covers").join("abc.png").exists());
    assert!(!old.join("models").exists());
    assert!(std::fs::read_to_string(old.join(MOVED_NOTE)).unwrap().contains(&new.display().to_string()));

    // Once only.
    assert_eq!(migrate(&old, &new, Some(&webview)).unwrap(), None);
    drop(db);
    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn nothing_to_move_on_a_fresh_install() {
    let root = tmp_dir("fresh");
    assert_eq!(migrate(&root.join("karaoke"), &root.join("baritoad"), None).unwrap(), None);
    assert!(!root.join("baritoad").exists());
    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn a_cut_off_move_starts_over() {
    let root = tmp_dir("cutoff");
    let (old, webview, live) = old_folder(&root);
    drop(live);
    let new = root.join("baritoad");
    // A previous try died while copying: only the staging folder exists.
    write(&root.join("baritoad.moving").join("covers").join("half.png"), b"half");
    let moved = migrate(&old, &new, Some(&webview)).unwrap().expect("moved");
    assert!(moved.files_copied > 0);
    assert!(!new.join("covers").join("half.png").exists(), "leftovers thrown away");
    assert!(new.join("library.db").exists());
    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn models_follow_on_a_later_start_if_they_were_in_use() {
    let root = tmp_dir("models-later");
    let (old, webview, live) = old_folder(&root);
    drop(live);
    let new = root.join("baritoad");
    // Simulate the models step failing the first time: hide them, move, put back.
    std::fs::rename(old.join("models"), root.join("models-aside")).unwrap();
    let first = migrate(&old, &new, Some(&webview)).unwrap().expect("moved");
    assert!(!first.models);
    std::fs::rename(root.join("models-aside"), old.join("models")).unwrap();
    // Next start: no copying, but the models move.
    assert_eq!(migrate(&old, &new, Some(&webview)).unwrap(), None);
    assert!(new.join("models").join("htdemucs.onnx").exists());
    assert!(!old.join("models").exists());
    std::fs::remove_dir_all(&root).unwrap();
}
