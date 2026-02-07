//! Error types for DLCut
//!
//! We use thiserror for ergonomic error definitions and implement
//! serde::Serialize to safely pass errors to the frontend without
//! leaking sensitive internal details.

use thiserror::Error;

#[derive(Error, Debug)]
pub enum AppError {
    #[error("Invalid YouTube URL")]
    InvalidUrl,

    #[error("Failed to fetch video information: {0}")]
    FetchError(String),

    #[error("Download failed: {0}")]
    DownloadError(String),

    #[error("Failed to cut video: {0}")]
    CutError(String),

    #[error("Invalid timestamp: {0}")]
    InvalidTimestamp(String),

    #[error("yt-dlp not found. Please ensure yt-dlp is installed and in PATH")]
    YtDlpNotFound,

    #[error("ffmpeg not found. Please ensure ffmpeg is installed and in PATH")]
    FfmpegNotFound,

    #[error("Dependency error: {0}")]
    DependencyError(String),

    #[error("Operation cancelled")]
    Cancelled,

    #[error("Internal error")]
    Internal(String),
}

pub type Result<T> = std::result::Result<T, AppError>;

// Serialize errors safely for the frontend
// We log the full error internally but only expose safe messages to the UI
impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        // Log full error for debugging
        eprintln!("Error: {:?}", self);
        // Serialize only the display message
        serializer.serialize_str(&self.to_string())
    }
}
