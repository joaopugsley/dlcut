//! ffmpeg integration
//!
//! Handles video cutting using ffmpeg when yt-dlp's built-in
//! cutting doesn't suffice (e.g., for post-download trimming).

use crate::deps;
use crate::error::{AppError, Result};
use crate::types::{ProgressStage, ProgressUpdate};
use regex::Regex;
use std::path::Path;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Windows flag to prevent console window from appearing
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Get the ffmpeg command (local or system)
async fn get_ffmpeg_cmd() -> String {
    deps::get_ffmpeg_command().await
}

/// Check if ffmpeg is available
pub async fn check_ffmpeg() -> Result<()> {
    let ffmpeg_cmd = get_ffmpeg_cmd().await;
    let mut cmd = Command::new(&ffmpeg_cmd);
    cmd.arg("-version");

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd.output().await.map_err(|_| AppError::FfmpegNotFound)?;

    if output.status.success() {
        Ok(())
    } else {
        Err(AppError::FfmpegNotFound)
    }
}

/// Cut a video file using ffmpeg
///
/// This function is used when we need to cut an already-downloaded video.
/// It uses stream copy (-c copy) for fast, lossless cutting when possible.
pub async fn cut_video(
    input_path: &str,
    output_path: &str,
    start_time: f64,
    end_time: f64,
    progress_tx: mpsc::Sender<ProgressUpdate>,
) -> Result<String> {
    let input = Path::new(input_path);
    if !input.exists() {
        return Err(AppError::CutError("Input file not found".to_string()));
    }

    let _ = progress_tx
        .send(ProgressUpdate {
            stage: ProgressStage::Cutting,
            percent: 0.0,
            message: "Starting video cut...".to_string(),
            speed: None,
            eta: None,
        })
        .await;

    let duration = end_time - start_time;

    // Build ffmpeg command
    // -ss before -i seeks before demuxing (faster)
    // -t specifies duration from start point
    // -c copy uses stream copy (no re-encoding, very fast)
    // -avoid_negative_ts make_zero helps with timestamp issues
    let ffmpeg_cmd = get_ffmpeg_cmd().await;
    let mut cmd = Command::new(&ffmpeg_cmd);
    cmd.args([
        "-y",                                  // Overwrite output
        "-ss", &format!("{:.3}", start_time),  // Seek to start
        "-i", input_path,                      // Input file
        "-t", &format!("{:.3}", duration),     // Duration
        "-c", "copy",                          // Stream copy (no re-encode)
        "-avoid_negative_ts", "make_zero",
        "-progress", "pipe:1",                 // Progress to stdout
        output_path,
    ])
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::CutError(format!("Failed to start ffmpeg: {}", e)))?;

    let stdout = child.stdout.take().unwrap();
    let mut reader = BufReader::new(stdout).lines();

    // Parse ffmpeg progress output
    let time_regex = Regex::new(r"out_time_ms=(\d+)").unwrap();
    let total_us = (duration * 1_000_000.0) as u64;

    while let Some(line) = reader.next_line().await.map_err(|e| {
        AppError::CutError(format!("Failed to read ffmpeg output: {}", e))
    })? {
        if let Some(caps) = time_regex.captures(&line) {
            if let Some(time_ms) = caps.get(1).and_then(|m| m.as_str().parse::<u64>().ok()) {
                let percent = if total_us > 0 {
                    (time_ms as f64 / total_us as f64 * 100.0).min(100.0)
                } else {
                    0.0
                };

                let _ = progress_tx
                    .send(ProgressUpdate {
                        stage: ProgressStage::Cutting,
                        percent,
                        message: format!("Cutting video... {:.0}%", percent),
                        speed: None,
                        eta: None,
                    })
                    .await;
            }
        }
    }

    let status = child.wait().await.map_err(|e| {
        AppError::CutError(format!("Failed to wait for ffmpeg: {}", e))
    })?;

    if !status.success() {
        // Try with re-encoding if stream copy failed
        return cut_video_reencode(input_path, output_path, start_time, end_time, progress_tx).await;
    }

    let _ = progress_tx
        .send(ProgressUpdate {
            stage: ProgressStage::Complete,
            percent: 100.0,
            message: "Cut complete!".to_string(),
            speed: None,
            eta: None,
        })
        .await;

    Ok(output_path.to_string())
}

/// Cut video with re-encoding (fallback for when stream copy fails)
async fn cut_video_reencode(
    input_path: &str,
    output_path: &str,
    start_time: f64,
    end_time: f64,
    progress_tx: mpsc::Sender<ProgressUpdate>,
) -> Result<String> {
    let _ = progress_tx
        .send(ProgressUpdate {
            stage: ProgressStage::Cutting,
            percent: 0.0,
            message: "Re-encoding video (this may take longer)...".to_string(),
            speed: None,
            eta: None,
        })
        .await;

    let duration = end_time - start_time;

    // Re-encode with libx264 and aac
    let ffmpeg_cmd = get_ffmpeg_cmd().await;
    let mut cmd = Command::new(&ffmpeg_cmd);
    cmd.args([
        "-y",
        "-ss", &format!("{:.3}", start_time),
        "-i", input_path,
        "-t", &format!("{:.3}", duration),
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "23",
        "-c:a", "aac",
        "-b:a", "128k",
        "-progress", "pipe:1",
        output_path,
    ])
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::CutError(format!("Failed to start ffmpeg: {}", e)))?;

    let stdout = child.stdout.take().unwrap();
    let mut reader = BufReader::new(stdout).lines();

    let time_regex = Regex::new(r"out_time_ms=(\d+)").unwrap();
    let total_us = (duration * 1_000_000.0) as u64;

    while let Some(line) = reader.next_line().await.ok().flatten() {
        if let Some(caps) = time_regex.captures(&line) {
            if let Some(time_ms) = caps.get(1).and_then(|m| m.as_str().parse::<u64>().ok()) {
                let percent = if total_us > 0 {
                    (time_ms as f64 / total_us as f64 * 100.0).min(100.0)
                } else {
                    0.0
                };

                let _ = progress_tx
                    .send(ProgressUpdate {
                        stage: ProgressStage::Cutting,
                        percent,
                        message: format!("Re-encoding... {:.0}%", percent),
                        speed: None,
                        eta: None,
                    })
                    .await;
            }
        }
    }

    let status = child.wait().await.map_err(|e| {
        AppError::CutError(format!("Failed to wait for ffmpeg: {}", e))
    })?;

    if !status.success() {
        return Err(AppError::CutError("ffmpeg encoding failed".to_string()));
    }

    let _ = progress_tx
        .send(ProgressUpdate {
            stage: ProgressStage::Complete,
            percent: 100.0,
            message: "Cut complete!".to_string(),
            speed: None,
            eta: None,
        })
        .await;

    Ok(output_path.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_check_ffmpeg() {
        // This test will pass if ffmpeg is installed
        let result = check_ffmpeg().await;
        // We don't assert success because ffmpeg might not be installed in CI
        println!("ffmpeg check result: {:?}", result);
    }
}
