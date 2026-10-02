//! karaoke-desktop — Tauri 2 shell over karaoke-core (PLAN.md §5, §9 Phase 2).
//!
//! Open source, GPL-3.0-or-later (PLAN.md §8). All processing is local;
//! no cloud, no telemetry, no hosting of user audio (CLAUDE.md hard rules).

mod commands;
mod gaming;
mod keep_awake;
mod library;
mod media_keys;
mod models;
mod player;
mod queue;
mod review;
mod stage;
mod theme;
mod tools;
mod worker;

use std::sync::Arc;

use library::LibraryHandle;
use queue::JobQueue;
use tauri::Manager;
use tools::ToolsState;

pub use worker::WORKER_ARG;

/// Entry point of the import worker process (worker.rs); returns its exit code.
pub fn serve_worker() -> i32 {
    worker::serve()
}

pub fn run() {
    // The data folder moved with the rename (karaoke → baritoad): once,
    // before anything opens the library. A failed move leaves everything
    // in the old folder, which stays in use (karaoke_core::paths).
    match karaoke_core::paths::migrate_default() {
        Ok(Some(m)) => eprintln!(
            "data folder: moved to {} — {} files, {} paths updated, settings {}, models {}",
            karaoke_core::paths::data_dir().display(),
            m.files_copied,
            m.paths_rewritten,
            if m.settings { "too" } else { "not found" },
            if m.models { "moved" } else { "not moved" },
        ),
        Ok(None) => {}
        Err(e) => eprintln!(
            "data folder: couldn't move it, still using {}: {e}",
            karaoke_core::paths::data_dir().display()
        ),
    }
    // The webview's profile (localStorage: the settings, the themes) lives
    // in the data folder, so it doesn't hang on the app identifier.
    #[cfg(windows)]
    if std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").is_none() {
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", karaoke_core::paths::webview_dir());
    }
    // Unfinished imports survive a restart (queue.rs module docs).
    let job_queue = Arc::new(JobQueue::with_store(queue::queue_store_path()));
    // The library store opens (and migrates) before anything can enqueue —
    // a failure here is unrecoverable-by-design (the DB lives in our own
    // %LOCALAPPDATA% dir).
    let library_handle = LibraryHandle::open_default().expect("open library store");
    // yt-dlp / Deno for Add from URL (tools.rs), found on first use.
    let tools_state = Arc::new(ToolsState::default());
    // Gaming mode: watches for a game using the graphics card (gaming.rs).
    let game_watch = gaming::GameWatch::spawn();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(job_queue.clone())
        .manage(library_handle.clone())
        .manage(tools_state.clone())
        .manage(game_watch.clone())
        // Windowed re-aligner (review screen): lazy-loaded wav2vec2 session,
        // CPU EP only (review.rs).
        .manage(review::RealignState::default())
        // The TV player's own window (stage.rs): created on first Sing, reused
        // after; its lifecycle unloads the engine and follows the main window.
        .manage(stage::StageState::default())
        .manage(std::sync::Arc::new(models::ModelDownloads::default()))
        .on_window_event(|window, event| stage::on_window_event(window, event))
        .setup(move |app| {
            // One worker: pipeline stages are compute-bound (GPU/CPU saturating)
            // — jobs queue FIFO and run strictly one at a time (PLAN.md §5),
            // each in the below-normal-priority worker process (worker.rs).
            let handle = app.handle().clone();
            job_queue.restore(&handle);
            library::spawn_meta_backfill(handle.clone(), library_handle.clone());
            let worker_queue = job_queue.clone();
            let worker_library = library_handle.clone();
            let worker_tools = tools_state.clone();
            let worker_game = game_watch.clone();
            std::thread::Builder::new()
                .name("pipeline-worker".into())
                .spawn(move || worker_queue.run_worker(handle, worker_library, worker_tools, worker_game))
                .expect("spawn pipeline worker");
            // Performance-player host: Player holds a cpal::Stream (!Send),
            // so the whole engine lives on this thread behind a command
            // channel (player.rs module docs) — never in managed state.
            let player_handle = player::spawn_host(app.handle().clone());
            app.manage(player_handle);
            // Media keys and the OS "now playing" panel (media_keys.rs).
            let media = media_keys::MediaKeys::default();
            media_keys::init(app.handle(), &media);
            app.manage(media);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::generate_song,
            commands::job_lyrics,
            commands::scan_import,
            commands::import_songs,
            commands::check_links,
            commands::queue_links,
            commands::reveal_path,
            media_keys::media_now_playing,
            models::models_status,
            models::models_download,
            models::models_cancel,
            commands::find_lyrics,
            library::song_update_details,
            commands::cancel_job,
            commands::retry_job,
            commands::set_game_policy,
            commands::game_status,
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
            library::queue_state,
            library::queue_add,
            library::queue_add_many,
            library::queue_remove,
            library::queue_move,
            library::queue_clear,
            library::queue_play,
            library::queue_stop,
            library::queue_finish,
            library::read_cover,
            library::cover_import_image,
            library::song_set_cover,
            theme::theme_import_image,
            theme::read_theme_image,
            review::playback_sources,
            review::realign_selection,
            review::save_timing_map,
            review::song_set_reviewed,
            review::library_song,
            review::export_status,
            review::vocal_levels,
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
            stage::stage_open,
            stage::stage_show_on,
            stage::stage_focus,
            stage::stage_current,
        ])
        .run(tauri::generate_context!())
        .expect("error while running karaoke desktop app");
}
