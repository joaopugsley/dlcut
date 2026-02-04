//! Tauri commands
//!
//! These are the IPC endpoints exposed to the frontend.
//! All inputs are validated before processing.

use crate::error::{AppError, Result};
use crate::types::{parse_timestamp, DownloadRequest, ProgressStage, ProgressUpdate, VideoInfo};
use crate::ytdlp;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

/// Application state for tracking active downloads
pub struct AppState {
    /// Currently active download (only one at a time)
    pub active_download: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            active_download: Mutex::new(None),
        }
    }
}

/// Check if required tools are available
#[tauri::command]
pub async fn check_dependencies() -> Result<()> {
    ytdlp::check_ytdlp().await?;
    // ffmpeg is optional - only needed for post-download cutting
    // We don't fail if it's not available since yt-dlp can cut during download
    Ok(())
}

/// Fetch video information from a YouTube URL
#[tauri::command]
pub async fn fetch_video_info(url: String, app: AppHandle) -> Result<VideoInfo> {
    // Emit fetching status
    let _ = app.emit("progress", ProgressUpdate {
        stage: ProgressStage::Fetching,
        percent: 0.0,
        message: "Fetching video information...".to_string(),
        speed: None,
        eta: None,
    });

    let info = ytdlp::fetch_video_info(&url).await?;

    let _ = app.emit("progress", ProgressUpdate {
        stage: ProgressStage::Fetching,
        percent: 100.0,
        message: "Video information loaded".to_string(),
        speed: None,
        eta: None,
    });

    Ok(info)
}

/// Validate timestamps against video duration
#[tauri::command]
pub fn validate_timestamps(
    start: Option<String>,
    end: Option<String>,
    duration: f64,
) -> Result<(Option<f64>, Option<f64>)> {
    let start_secs = if let Some(ref s) = start {
        if s.trim().is_empty() {
            None
        } else {
            Some(parse_timestamp(s).ok_or_else(|| {
                AppError::InvalidTimestamp(format!("Invalid start time: {}", s))
            })?)
        }
    } else {
        None
    };

    let end_secs = if let Some(ref e) = end {
        if e.trim().is_empty() {
            None
        } else {
            Some(parse_timestamp(e).ok_or_else(|| {
                AppError::InvalidTimestamp(format!("Invalid end time: {}", e))
            })?)
        }
    } else {
        None
    };

    // Validate ranges
    if let Some(start) = start_secs {
        if start < 0.0 {
            return Err(AppError::InvalidTimestamp("Start time cannot be negative".to_string()));
        }
        if start >= duration {
            return Err(AppError::InvalidTimestamp("Start time exceeds video duration".to_string()));
        }
    }

    if let Some(end) = end_secs {
        if end <= 0.0 {
            return Err(AppError::InvalidTimestamp("End time must be positive".to_string()));
        }
        if end > duration {
            return Err(AppError::InvalidTimestamp("End time exceeds video duration".to_string()));
        }
    }

    if let (Some(start), Some(end)) = (start_secs, end_secs) {
        if start >= end {
            return Err(AppError::InvalidTimestamp("Start time must be before end time".to_string()));
        }
    }

    Ok((start_secs, end_secs))
}

/// Start downloading a video
#[tauri::command]
pub async fn start_download(
    request: DownloadRequest,
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
) -> Result<()> {
    // Validate URL
    ytdlp::validate_youtube_url(&request.url)?;

    // Check if there's already an active download
    {
        let active = state.active_download.lock().await;
        if active.is_some() {
            return Err(AppError::DownloadError("A download is already in progress".to_string()));
        }
    }

    // Create progress channel
    let (tx, mut rx) = tokio::sync::mpsc::channel::<ProgressUpdate>(32);

    // Clone values for the spawned task
    let url = request.url.clone();
    let format_id = request.format_id.clone();
    let output_path = request.output_path.clone();
    let start_time = request.start_time;
    let end_time = request.end_time;
    let app_clone = app.clone();

    // Spawn progress forwarding task
    let app_for_progress = app.clone();
    tokio::spawn(async move {
        while let Some(progress) = rx.recv().await {
            let _ = app_for_progress.emit("progress", &progress);
        }
    });

    // Spawn download task
    let state_clone = state.inner().clone();
    let handle = tokio::spawn(async move {
        let result = ytdlp::download_video(
            &url,
            &format_id,
            &output_path,
            start_time,
            end_time,
            tx.clone(),
        )
        .await;

        // Emit final status
        match result {
            Ok(_) => {
                let _ = app_clone.emit("download-complete", &output_path);
            }
            Err(e) => {
                let _ = app_clone.emit("progress", ProgressUpdate {
                    stage: ProgressStage::Error,
                    percent: 0.0,
                    message: e.to_string(),
                    speed: None,
                    eta: None,
                });
                let _ = app_clone.emit("download-error", e.to_string());
            }
        }

        // Clear active download
        let mut active = state_clone.active_download.lock().await;
        *active = None;
    });

    // Store the download handle
    {
        let mut active = state.active_download.lock().await;
        *active = Some(handle);
    }

    Ok(())
}

/// Cancel the active download
#[tauri::command]
pub async fn cancel_download(state: State<'_, Arc<AppState>>) -> Result<()> {
    let mut active = state.active_download.lock().await;
    if let Some(handle) = active.take() {
        handle.abort();
        Ok(())
    } else {
        Err(AppError::Cancelled)
    }
}

/// Generate output filename from video info
#[tauri::command]
pub fn generate_filename(title: String, format_ext: String) -> String {
    // Sanitize filename by removing invalid characters
    let sanitized: String = title
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect();

    // Truncate if too long (max 200 chars for safety)
    let truncated = if sanitized.len() > 200 {
        sanitized[..200].to_string()
    } else {
        sanitized
    };

    format!("{}.{}", truncated.trim(), format_ext)
}

/// Get default download directory
#[tauri::command]
pub fn get_default_download_dir() -> Option<String> {
    dirs::download_dir()
        .or_else(dirs::home_dir)
        .map(|p| p.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_filename() {
        assert_eq!(
            generate_filename("Test Video".to_string(), "mp4".to_string()),
            "Test Video.mp4"
        );
        assert_eq!(
            generate_filename("Test/Video:Name".to_string(), "mp4".to_string()),
            "Test_Video_Name.mp4"
        );
    }

    #[test]
    fn test_validate_timestamps() {
        // Valid timestamps
        let result = validate_timestamps(Some("0:30".to_string()), Some("1:30".to_string()), 120.0);
        assert!(result.is_ok());
        let (start, end) = result.unwrap();
        assert_eq!(start, Some(30.0));
        assert_eq!(end, Some(90.0));

        // Empty strings should be None
        let result = validate_timestamps(Some("".to_string()), Some("".to_string()), 120.0);
        assert!(result.is_ok());
        let (start, end) = result.unwrap();
        assert_eq!(start, None);
        assert_eq!(end, None);

        // Invalid: start >= end
        let result = validate_timestamps(Some("1:00".to_string()), Some("0:30".to_string()), 120.0);
        assert!(result.is_err());

        // Invalid: exceeds duration
        let result = validate_timestamps(Some("2:30".to_string()), None, 120.0);
        assert!(result.is_err());
    }
}
