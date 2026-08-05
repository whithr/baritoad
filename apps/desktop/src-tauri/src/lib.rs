//! karaoke-desktop — Tauri 2 shell over karaoke-core (PLAN.md §5, §9 Phase 2).
//!
//! Source-available (PLAN.md §1 terminology rule). All processing is local;
//! no downloader, no cloud, no telemetry (CLAUDE.md hard rules).

mod commands;
mod library;
mod player;
mod queue;
mod review;

use std::sync::Arc;

use library::LibraryHandle;
use queue::JobQueue;
use tauri::Manager;

pub fn run() {
    let job_queue = Arc::new(JobQueue::new());
    // The library store opens (and migrates) before anything can enqueue —
    // a failure here is unrecoverable-by-design (the DB lives in our own
    // %LOCALAPPDATA% dir).
    let library_handle = LibraryHandle::open_default().expect("open library store");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(job_queue.clone())
        .manage(library_handle.clone())
        // Windowed re-aligner (review screen): lazy-loaded wav2vec2 session,
        // CPU EP only (review.rs).
        .manage(review::RealignState::default())
        .setup(move |app| {
            // One worker: pipeline stages are compute-bound (GPU/CPU saturating)
            // — jobs queue FIFO and run strictly one at a time (PLAN.md §5).
            let handle = app.handle().clone();
            let worker_queue = job_queue.clone();
            let worker_library = library_handle.clone();
            std::thread::Builder::new()
                .name("pipeline-worker".into())
                .spawn(move || worker_queue.run_worker(handle, worker_library))
                .expect("spawn pipeline worker");
            // Performance-player host: Player holds a cpal::Stream (!Send),
            // so the whole engine lives on this thread behind a command
            // channel (player.rs module docs) — never in managed state.
            let player_handle = player::spawn_host(app.handle().clone());
            app.manage(player_handle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::generate_song,
            commands::cancel_job,
            commands::list_jobs,
            commands::read_timing_map,
            commands::clean_lyrics_preview,
            commands::export_song,
            library::probe_audio,
            library::library_songs,
            library::library_delete_song,
            library::library_collections,
            library::collection_create,
            library::collection_rename,
            library::collection_delete,
            library::collection_add_song,
            library::collection_remove_song,
            library::song_collections,
            library::queue_list,
            library::queue_add,
            library::queue_remove,
            library::queue_move,
            library::queue_clear,
            library::read_cover,
            review::playback_sources,
            review::realign_selection,
            review::save_timing_map,
            review::song_set_reviewed,
            review::library_song,
            review::export_status,
            player::player_load,
            player::player_play,
            player::player_pause,
            player::player_stop,
            player::player_seek,
            player::player_set_guide,
            player::player_set_pitch,
            player::player_set_tempo,
            player::player_set_stretch_config,
            player::player_status,
            player::player_unload,
            player::measure_plan,
            player::measure_write,
        ])
        .run(tauri::generate_context!())
        .expect("error while running karaoke desktop app");
}
