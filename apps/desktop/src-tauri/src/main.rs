// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Song import runs in a child copy of this executable (worker.rs).
    if std::env::args().nth(1).as_deref() == Some(karaoke_desktop::WORKER_ARG) {
        std::process::exit(karaoke_desktop::serve_worker());
    }
    karaoke_desktop::run();
}
