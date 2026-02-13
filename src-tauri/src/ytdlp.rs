//! yt-dlp integration
//!
//! Handles all interactions with the yt-dlp CLI tool.
//! Commands are built using proper argument arrays to prevent injection.

use crate::deps;
use crate::error::{AppError, Result};
use crate::types::{
    format_bytes, format_duration, AudioQuality, DownloadMode, ProgressStage, ProgressUpdate,
    VideoFormat, VideoInfo, VideoQuality,
};
use regex::Regex;
use serde::Deserialize;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;

/// Windows flag to prevent console window from appearing
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Get the yt-dlp command (local or system)
async fn get_ytdlp_cmd() -> String {
    deps::get_ytdlp_command().await
}

/// Raw format data from yt-dlp JSON output
#[derive(Debug, Deserialize)]
struct RawFormat {
    format_id: String,
    ext: String,
    resolution: Option<String>,
    fps: Option<f64>,
    vcodec: Option<String>,
    acodec: Option<String>,
    filesize: Option<u64>,
    filesize_approx: Option<u64>,
    format_note: Option<String>,
    height: Option<u32>,
    width: Option<u32>,
}

/// Raw video info from yt-dlp JSON output
#[derive(Debug, Deserialize)]
struct RawVideoInfo {
    id: String,
    title: String,
    duration: Option<f64>,
    thumbnail: Option<String>,
    uploader: Option<String>,
    formats: Option<Vec<RawFormat>>,
}

/// Check if yt-dlp is available
pub async fn check_ytdlp() -> Result<()> {
    let ytdlp_cmd = get_ytdlp_cmd().await;
    let mut cmd = Command::new(&ytdlp_cmd);
    cmd.arg("--version");

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd.output().await.map_err(|_| AppError::YtDlpNotFound)?;

    if output.status.success() {
        Ok(())
    } else {
        Err(AppError::YtDlpNotFound)
    }
}

/// Validate that a URL looks like a YouTube URL
/// This is a security measure to prevent arbitrary URL processing
pub fn validate_youtube_url(url: &str) -> Result<()> {
    let url = url.trim();

    // Basic URL patterns for YouTube
    let patterns = [
        r"^https?://(www\.)?youtube\.com/watch\?v=[\w-]+",
        r"^https?://(www\.)?youtube\.com/shorts/[\w-]+",
        r"^https?://youtu\.be/[\w-]+",
        r"^https?://(www\.)?youtube\.com/embed/[\w-]+",
        r"^https?://m\.youtube\.com/watch\?v=[\w-]+",
    ];

    for pattern in &patterns {
        let re = Regex::new(pattern).unwrap();
        if re.is_match(url) {
            return Ok(());
        }
    }

    Err(AppError::InvalidUrl)
}

/// Fetch video information using yt-dlp
pub async fn fetch_video_info(url: &str) -> Result<VideoInfo> {
    validate_youtube_url(url)?;

    // Use yt-dlp to get JSON metadata
    // Arguments are passed as separate strings to prevent shell injection
    let ytdlp_cmd = get_ytdlp_cmd().await;
    let mut cmd = Command::new(&ytdlp_cmd);
    cmd.args([
        "--dump-json",     // Output JSON metadata
        "--no-download",   // Don't download the video
        "--no-warnings",   // Suppress warnings
        "--no-playlist",   // Only process single video
        "--flat-playlist", // Don't extract playlist videos
        url,
    ]);

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd
        .output()
        .await
        .map_err(|e| AppError::FetchError(format!("Failed to run yt-dlp: {}", e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::FetchError(format!(
            "yt-dlp error: {}",
            stderr.lines().next().unwrap_or("Unknown error")
        )));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let raw: RawVideoInfo = serde_json::from_str(&stdout)
        .map_err(|e| AppError::FetchError(format!("Failed to parse video info: {}", e)))?;

    let raw_formats = raw.formats.unwrap_or_default();

    // Convert raw formats to our format type (legacy)
    let formats = raw_formats
        .iter()
        .filter_map(convert_format)
        .collect::<Vec<_>>();

    // Filter to only useful formats (video with audio, or best quality options)
    let formats = filter_formats(formats);

    // Extract video qualities (unique heights from video formats)
    let video_qualities = extract_video_qualities(&raw_formats);

    // Audio qualities are fixed options since yt-dlp will select best available
    let audio_qualities = vec![
        AudioQuality {
            quality_id: "high".to_string(),
            label: "High Quality (320kbps)".to_string(),
            bitrate: 320,
        },
        AudioQuality {
            quality_id: "medium".to_string(),
            label: "Medium Quality (192kbps)".to_string(),
            bitrate: 192,
        },
        AudioQuality {
            quality_id: "low".to_string(),
            label: "Low Quality (128kbps)".to_string(),
            bitrate: 128,
        },
    ];

    let duration = raw.duration.unwrap_or(0.0);

    Ok(VideoInfo {
        id: raw.id,
        title: raw.title,
        duration,
        duration_string: format_duration(duration),
        thumbnail: raw.thumbnail,
        uploader: raw.uploader,
        formats,
        video_qualities,
        audio_qualities,
    })
}

/// Convert raw format to our format type
fn convert_format(raw: &RawFormat) -> Option<VideoFormat> {
    let has_video = raw.vcodec.as_ref().map(|v| v != "none").unwrap_or(false);
    let has_audio = raw.acodec.as_ref().map(|a| a != "none").unwrap_or(false);

    // Skip formats without video (audio-only)
    if !has_video {
        return None;
    }

    let resolution = raw.resolution.clone().unwrap_or_else(|| {
        if let (Some(w), Some(h)) = (raw.width, raw.height) {
            format!("{}x{}", w, h)
        } else {
            "unknown".to_string()
        }
    });

    let quality = if let Some(height) = raw.height {
        format!("{}p", height)
    } else {
        raw.format_note
            .clone()
            .unwrap_or_else(|| "unknown".to_string())
    };

    let filesize = raw.filesize.or(raw.filesize_approx);
    let filesize_approx = filesize.map(format_bytes);

    Some(VideoFormat {
        format_id: raw.format_id.clone(),
        ext: raw.ext.clone(),
        resolution,
        fps: raw.fps,
        vcodec: raw.vcodec.clone(),
        acodec: raw.acodec.clone(),
        filesize,
        filesize_approx,
        quality,
        has_video,
        has_audio,
    })
}

/// Extract unique video quality options from raw formats
fn extract_video_qualities(raw_formats: &[RawFormat]) -> Vec<VideoQuality> {
    use std::collections::HashSet;

    let mut seen_heights = HashSet::new();
    let mut qualities = Vec::new();

    // Collect all video formats with heights
    let mut video_formats: Vec<_> = raw_formats
        .iter()
        .filter(|f| f.vcodec.as_ref().map(|v| v != "none").unwrap_or(false) && f.height.is_some())
        .collect();

    // Sort by height descending
    video_formats.sort_by(|a, b| b.height.cmp(&a.height));

    for format in video_formats {
        if let Some(height) = format.height {
            if !seen_heights.contains(&height) {
                seen_heights.insert(height);

                let filesize_approx = format.filesize.or(format.filesize_approx).map(format_bytes);

                qualities.push(VideoQuality {
                    height,
                    label: format!("{}p", height),
                    filesize_approx,
                });
            }
        }
    }

    // Limit to common resolutions
    qualities.truncate(8);
    qualities
}

/// Filter formats to show only the most useful options
fn filter_formats(mut formats: Vec<VideoFormat>) -> Vec<VideoFormat> {
    // Sort by resolution (height) descending
    formats.sort_by(|a, b| {
        let a_height = extract_height(&a.quality);
        let b_height = extract_height(&b.quality);
        b_height.cmp(&a_height)
    });

    // Keep unique quality levels, preferring formats with audio
    let mut seen_qualities = std::collections::HashSet::new();
    let mut result = Vec::new();

    for format in formats {
        let quality_key = format.quality.clone();
        if !seen_qualities.contains(&quality_key) {
            seen_qualities.insert(quality_key);
            result.push(format);
        }
    }

    // Limit to reasonable number of options
    result.truncate(8);
    result
}

fn extract_height(quality: &str) -> u32 {
    quality.trim_end_matches('p').parse().unwrap_or(0)
}

/// Download video with progress reporting
pub async fn download_video(
    url: &str,
    mode: &DownloadMode,
    quality: &str,
    output_path: &str,
    start_time: Option<f64>,
    end_time: Option<f64>,
    progress_tx: mpsc::Sender<ProgressUpdate>,
) -> Result<String> {
    validate_youtube_url(url)?;

    let mut args = vec![
        "--newline".to_string(), // Progress on new lines
        "--no-warnings".to_string(),
        "--no-playlist".to_string(),
    ];

    // Build format string based on mode
    match mode {
        DownloadMode::VideoWithAudio => {
            // For video+audio: select best video up to specified height + best audio, merge
            // Format: bestvideo[height<=X]+bestaudio/best[height<=X]
            // The fallback handles cases where separate streams aren't available
            let height: u32 = quality.parse().unwrap_or(1080);
            let format_str = format!(
                "bestvideo[height<={}]+bestaudio/best[height<={}]",
                height, height
            );
            args.push("-f".to_string());
            args.push(format_str);

            // Merge into mp4 container
            args.push("--merge-output-format".to_string());
            args.push("mp4".to_string());
        }
        DownloadMode::AudioOnly => {
            // For audio only: extract audio and convert to mp3
            args.push("-f".to_string());
            args.push("bestaudio/best".to_string());

            // Extract audio to mp3
            args.push("-x".to_string()); // Extract audio
            args.push("--audio-format".to_string());
            args.push("mp3".to_string());

            // Set audio quality based on selection
            let audio_quality = match quality {
                "high" => "0",   // Best quality (VBR ~245kbps)
                "medium" => "5", // Medium quality (VBR ~130kbps)
                "low" => "9",    // Lower quality (VBR ~65kbps)
                _ => "0",
            };
            args.push("--audio-quality".to_string());
            args.push(audio_quality.to_string());
        }
    }

    args.push("-o".to_string());
    args.push(output_path.to_string());

    // yt-dlp supports --download-sections for cutting during download
    // This is more efficient than downloading then cutting with ffmpeg
    let needs_postprocess_cut = if let (Some(start), Some(end)) = (start_time, end_time) {
        // Use download sections for cutting
        // Format: "*start-end" where times are in seconds
        let section = format!("*{:.2}-{:.2}", start, end);
        args.push("--download-sections".to_string());
        args.push(section);
        // Force keyframes to avoid seeking issues
        args.push("--force-keyframes-at-cuts".to_string());
        false
    } else if let Some(start) = start_time {
        let section = format!("*{:.2}-inf", start);
        args.push("--download-sections".to_string());
        args.push(section);
        args.push("--force-keyframes-at-cuts".to_string());
        false
    } else if let Some(end) = end_time {
        let section = format!("*0-{:.2}", end);
        args.push("--download-sections".to_string());
        args.push(section);
        args.push("--force-keyframes-at-cuts".to_string());
        false
    } else {
        false
    };

    args.push(url.to_string());

    let _ = progress_tx
        .send(ProgressUpdate {
            stage: ProgressStage::Downloading,
            percent: 0.0,
            message: "Starting download...".to_string(),
            speed: None,
            eta: None,
        })
        .await;

    let ytdlp_cmd = get_ytdlp_cmd().await;
    let mut cmd = Command::new(&ytdlp_cmd);
    cmd.args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::DownloadError(format!("Failed to start yt-dlp: {}", e)))?;

    let stdout = child.stdout.take().unwrap();
    let mut reader = BufReader::new(stdout);

    // Parse progress from yt-dlp output
    let progress_regex =
        Regex::new(r"\[download\]\s+(\d+\.?\d*)%.*?(\d+\.?\d*\w+/s)?.*?ETA\s+(\S+)?").unwrap();

    // Read raw bytes to handle non-UTF-8 output (e.g. video titles with special characters)
    let mut raw_line = Vec::new();
    loop {
        raw_line.clear();
        let bytes_read = reader
            .read_until(b'\n', &mut raw_line)
            .await
            .map_err(|e| AppError::DownloadError(format!("Failed to read output: {}", e)))?;
        if bytes_read == 0 {
            break;
        }
        let line = String::from_utf8_lossy(&raw_line);
        let line = line.trim_end_matches('\n').trim_end_matches('\r');

        if let Some(caps) = progress_regex.captures(line) {
            let percent: f64 = caps
                .get(1)
                .and_then(|m| m.as_str().parse().ok())
                .unwrap_or(0.0);

            let speed = caps.get(2).map(|m| m.as_str().to_string());
            let eta = caps.get(3).map(|m| m.as_str().to_string());

            let _ = progress_tx
                .send(ProgressUpdate {
                    stage: ProgressStage::Downloading,
                    percent,
                    message: format!("Downloading... {:.1}%", percent),
                    speed,
                    eta,
                })
                .await;
        }
    }

    let status = child
        .wait()
        .await
        .map_err(|e| AppError::DownloadError(format!("Failed to wait for yt-dlp: {}", e)))?;

    if !status.success() {
        return Err(AppError::DownloadError("Download failed".to_string()));
    }

    let _ = progress_tx
        .send(ProgressUpdate {
            stage: if needs_postprocess_cut {
                ProgressStage::Cutting
            } else {
                ProgressStage::Complete
            },
            percent: 100.0,
            message: if needs_postprocess_cut {
                "Download complete. Cutting...".to_string()
            } else {
                "Download complete!".to_string()
            },
            speed: None,
            eta: None,
        })
        .await;

    Ok(output_path.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_youtube_url() {
        // Valid URLs
        assert!(validate_youtube_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ").is_ok());
        assert!(validate_youtube_url("https://youtube.com/watch?v=dQw4w9WgXcQ").is_ok());
        assert!(validate_youtube_url("https://youtu.be/dQw4w9WgXcQ").is_ok());
        assert!(validate_youtube_url("https://www.youtube.com/shorts/abc123").is_ok());

        // Invalid URLs
        assert!(validate_youtube_url("https://example.com").is_err());
        assert!(validate_youtube_url("not a url").is_err());
        assert!(validate_youtube_url("").is_err());
        assert!(validate_youtube_url("https://vimeo.com/123456").is_err());
    }

    #[test]
    fn test_extract_height() {
        assert_eq!(extract_height("1080p"), 1080);
        assert_eq!(extract_height("720p"), 720);
        assert_eq!(extract_height("480p"), 480);
        assert_eq!(extract_height("unknown"), 0);
    }
}
