//! DLCut - YouTube Video Downloader & Cutter
//!
//! A simple, elegant Tauri application for downloading and cutting
//! YouTube videos using yt-dlp and ffmpeg.

pub mod commands;
pub mod deps;
pub mod error;
pub mod ffmpeg;
pub mod types;
pub mod ytdlp;

use commands::AppState;
use std::sync::Arc;

/// Initialize and run the Tauri application
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Register plugins
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        // Initialize application state
        .manage(Arc::new(AppState::default()))
        // Register IPC commands
        .invoke_handler(tauri::generate_handler![
            commands::check_dependencies,
            commands::install_dependencies,
            commands::fetch_video_info,
            commands::validate_timestamps,
            commands::start_download,
            commands::cancel_download,
            commands::generate_filename,
            commands::get_default_download_dir,
            commands::show_in_folder,
            commands::get_video_duration,
            commands::cut_local_video,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
