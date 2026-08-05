//! karaoke-desktop — Tauri 2 shell over karaoke-core (PLAN.md §5, §9 Phase 2).
//!
//! Source-available (PLAN.md §1 terminology rule). All processing is local;
//! no downloader, no cloud, no telemetry (CLAUDE.md hard rules).

mod commands;
mod queue;

use std::sync::Arc;

use queue::JobQueue;

pub fn run() {
    let job_queue = Arc::new(JobQueue::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(job_queue.clone())
        .setup(move |app| {
            // One worker: pipeline stages are compute-bound (GPU/CPU saturating)
            // — jobs queue FIFO and run strictly one at a time (PLAN.md §5).
            let handle = app.handle().clone();
            let worker_queue = job_queue.clone();
            std::thread::Builder::new()
                .name("pipeline-worker".into())
                .spawn(move || worker_queue.run_worker(handle))
                .expect("spawn pipeline worker");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::generate_song,
            commands::cancel_job,
            commands::list_jobs,
            commands::read_timing_map,
            commands::clean_lyrics_preview,
            commands::export_song,
        ])
        .run(tauri::generate_context!())
        .expect("error while running karaoke desktop app");
}
