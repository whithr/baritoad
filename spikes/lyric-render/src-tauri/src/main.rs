// Lyric-render spike: minimal Tauri shell around an instrumented lyric-player
// scene (see ../ui/index.html). The frontend runs the benchmark and calls
// `report_results` with a JSON payload, which we write to ../results/.
// Console subsystem kept on purpose: this is a benchmark harness and we want
// panics/errors visible on stderr.

use std::path::PathBuf;

fn results_dir() -> PathBuf {
    // CARGO_MANIFEST_DIR = .../spikes/lyric-render/src-tauri
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../results")
}

#[tauri::command]
fn report_results(json: String) -> Result<String, String> {
    let dir = results_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    let path = dir.join(format!("run-{ts}.json"));
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn quit(app: tauri::AppHandle) {
    app.exit(0);
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![report_results, quit])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
