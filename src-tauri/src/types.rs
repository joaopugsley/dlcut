//! Shared types for DLCut
//!
//! These structures are used for IPC between frontend and backend.
//! All fields are validated before use.

use serde::{Deserialize, Serialize};

/// Supported platform detected from URL
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum Platform {
    #[serde(rename = "youtube")]
    YouTube,
    #[serde(rename = "tiktok")]
    TikTok,
    #[serde(rename = "instagram")]
    Instagram,
    #[serde(rename = "twitter")]
    Twitter,
    #[serde(rename = "reddit")]
    Reddit,
    #[serde(rename = "soundcloud")]
    SoundCloud,
}

impl Platform {
    /// Whether the platform supports video downloads
    pub fn supports_video(&self) -> bool {
        !matches!(self, Platform::SoundCloud)
    }
}

/// Download mode - video with audio or audio only
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DownloadMode {
    /// Download video with audio merged (output as .mp4)
    VideoWithAudio,
    /// Download audio only (output as .mp3)
    AudioOnly,
}

/// Quality option for video downloads
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoQuality {
    /// Height in pixels (e.g., 1080, 720, 480)
    pub height: u32,
    /// Human-readable label (e.g., "1080p")
    pub label: String,
    /// Estimated file size (if available)
    pub filesize_approx: Option<String>,
}

/// Quality option for audio downloads
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioQuality {
    /// Bitrate identifier (e.g., "high", "medium", "low")
    pub quality_id: String,
    /// Human-readable label (e.g., "High Quality (320kbps)")
    pub label: String,
    /// Audio bitrate in kbps (approximate)
    pub bitrate: u32,
}

/// Video format information from yt-dlp
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoFormat {
    pub format_id: String,
    pub ext: String,
    pub resolution: String,
    pub fps: Option<f64>,
    pub vcodec: Option<String>,
    pub acodec: Option<String>,
    /// File size in bytes, if known
    pub filesize: Option<u64>,
    /// Human-readable file size
    pub filesize_approx: Option<String>,
    /// Quality note (e.g., "1080p", "720p")
    pub quality: String,
    /// Whether this format has video
    pub has_video: bool,
    /// Whether this format has audio
    pub has_audio: bool,
}

/// Complete video metadata from yt-dlp
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoInfo {
    pub id: String,
    pub title: String,
    /// Duration in seconds
    pub duration: f64,
    /// Human-readable duration (e.g., "10:30")
    pub duration_string: String,
    pub thumbnail: Option<String>,
    pub uploader: Option<String>,
    /// Legacy formats (kept for compatibility)
    pub formats: Vec<VideoFormat>,
    /// Available video quality options
    pub video_qualities: Vec<VideoQuality>,
    /// Available audio quality options
    pub audio_qualities: Vec<AudioQuality>,
    /// Detected platform
    pub platform: Platform,
}

/// Download request from frontend
#[derive(Debug, Clone, Deserialize)]
pub struct DownloadRequest {
    pub url: String,
    /// For VideoWithAudio: height as string (e.g., "1080")
    /// For AudioOnly: quality_id (e.g., "high", "medium", "low")
    pub quality: String,
    /// Download mode (video+audio or audio only)
    pub mode: DownloadMode,
    pub output_path: String,
    /// Start time in seconds (optional, for cutting)
    pub start_time: Option<f64>,
    /// End time in seconds (optional, for cutting)
    pub end_time: Option<f64>,
}

/// Progress update sent to frontend
#[derive(Debug, Clone, Serialize)]
pub struct ProgressUpdate {
    pub stage: ProgressStage,
    /// Progress percentage (0-100)
    pub percent: f64,
    /// Current status message
    pub message: String,
    /// Download speed if available
    pub speed: Option<String>,
    /// ETA if available
    pub eta: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ProgressStage {
    Fetching,
    Downloading,
    Cutting,
    Complete,
    Error,
}

impl VideoFormat {
    /// Create a human-readable label for this format
    pub fn label(&self) -> String {
        let mut parts = vec![self.quality.clone()];

        if let Some(ref vcodec) = self.vcodec {
            if vcodec != "none" {
                parts.push(vcodec.clone());
            }
        }

        if let Some(ref size) = self.filesize_approx {
            parts.push(format!("~{}", size));
        }

        parts.join(" • ")
    }
}

/// Parse duration in seconds to human-readable format
pub fn format_duration(seconds: f64) -> String {
    let total_secs = seconds as u64;
    let hours = total_secs / 3600;
    let minutes = (total_secs % 3600) / 60;
    let secs = total_secs % 60;

    if hours > 0 {
        format!("{:02}:{:02}:{:02}", hours, minutes, secs)
    } else {
        format!("{:02}:{:02}", minutes, secs)
    }
}

/// Parse a timestamp string (HH:MM:SS or MM:SS or SS) to seconds
pub fn parse_timestamp(timestamp: &str) -> Option<f64> {
    let parts: Vec<&str> = timestamp.trim().split(':').collect();

    match parts.len() {
        1 => parts[0].parse::<f64>().ok(),
        2 => {
            let mins = parts[0].parse::<f64>().ok()?;
            let secs = parts[1].parse::<f64>().ok()?;
            Some(mins * 60.0 + secs)
        }
        3 => {
            let hours = parts[0].parse::<f64>().ok()?;
            let mins = parts[1].parse::<f64>().ok()?;
            let secs = parts[2].parse::<f64>().ok()?;
            Some(hours * 3600.0 + mins * 60.0 + secs)
        }
        _ => None,
    }
}

/// Format bytes to human-readable size
pub fn format_bytes(bytes: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = KB * 1024;
    const GB: u64 = MB * 1024;

    if bytes >= GB {
        format!("{:.1} GB", bytes as f64 / GB as f64)
    } else if bytes >= MB {
        format!("{:.1} MB", bytes as f64 / MB as f64)
    } else if bytes >= KB {
        format!("{:.0} KB", bytes as f64 / KB as f64)
    } else {
        format!("{} B", bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_duration() {
        assert_eq!(format_duration(65.0), "01:05");
        assert_eq!(format_duration(3661.0), "01:01:01");
        assert_eq!(format_duration(0.0), "00:00");
    }

    #[test]
    fn test_parse_timestamp() {
        assert_eq!(parse_timestamp("30"), Some(30.0));
        assert_eq!(parse_timestamp("1:30"), Some(90.0));
        assert_eq!(parse_timestamp("01:30"), Some(90.0));
        assert_eq!(parse_timestamp("1:00:00"), Some(3600.0));
        assert_eq!(parse_timestamp("invalid"), None);
    }

    #[test]
    fn test_format_bytes() {
        assert_eq!(format_bytes(500), "500 B");
        assert_eq!(format_bytes(1024), "1 KB");
        assert_eq!(format_bytes(1536), "2 KB");
        assert_eq!(format_bytes(1048576), "1.0 MB");
        assert_eq!(format_bytes(1073741824), "1.0 GB");
    }
}
