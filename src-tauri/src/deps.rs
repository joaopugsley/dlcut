//! Dependency manager
//!
//! Handles automatic downloading and management of yt-dlp and ffmpeg binaries.
//! Binaries are stored in the user's local app data directory.

use crate::error::{AppError, Result};
use futures_util::StreamExt;
use std::io::Write;
use std::path::PathBuf;
use tokio::process::Command;

#[cfg(windows)]
#[allow(unused_imports)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Get the directory where dependencies are stored
pub fn get_deps_dir() -> Result<PathBuf> {
    let base = dirs::data_local_dir()
        .ok_or_else(|| AppError::DependencyError("Could not find local data directory".into()))?;

    let deps_dir = base.join("DLCut").join("bin");
    Ok(deps_dir)
}

/// Get the path to yt-dlp binary
pub fn get_ytdlp_path() -> Result<PathBuf> {
    let deps_dir = get_deps_dir()?;

    #[cfg(windows)]
    let binary = "yt-dlp.exe";
    #[cfg(not(windows))]
    let binary = "yt-dlp";

    Ok(deps_dir.join(binary))
}

/// Get the path to ffmpeg binary
pub fn get_ffmpeg_path() -> Result<PathBuf> {
    let deps_dir = get_deps_dir()?;

    #[cfg(windows)]
    let binary = "ffmpeg.exe";
    #[cfg(not(windows))]
    let binary = "ffmpeg";

    Ok(deps_dir.join(binary))
}

/// Check if a binary exists and is executable
async fn check_binary(path: &PathBuf, version_arg: &str) -> bool {
    if !path.exists() {
        return false;
    }

    let mut cmd = Command::new(path);
    cmd.arg(version_arg);

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    cmd.output().await.map(|o| o.status.success()).unwrap_or(false)
}

/// Check if yt-dlp is available (either local or system)
pub async fn is_ytdlp_available() -> bool {
    // First check local
    if let Ok(path) = get_ytdlp_path() {
        if check_binary(&path, "--version").await {
            return true;
        }
    }

    // Then check system PATH
    let mut cmd = Command::new("yt-dlp");
    cmd.arg("--version");

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    cmd.output().await.map(|o| o.status.success()).unwrap_or(false)
}

/// Check if ffmpeg is available (either local or system)
pub async fn is_ffmpeg_available() -> bool {
    // First check local
    if let Ok(path) = get_ffmpeg_path() {
        if check_binary(&path, "-version").await {
            return true;
        }
    }

    // Then check system PATH
    let mut cmd = Command::new("ffmpeg");
    cmd.arg("-version");

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    cmd.output().await.map(|o| o.status.success()).unwrap_or(false)
}

/// Get the command for yt-dlp (local path if available, otherwise system)
pub async fn get_ytdlp_command() -> String {
    if let Ok(path) = get_ytdlp_path() {
        if path.exists() {
            return path.to_string_lossy().to_string();
        }
    }
    "yt-dlp".to_string()
}

/// Get the command for ffmpeg (local path if available, otherwise system)
pub async fn get_ffmpeg_command() -> String {
    if let Ok(path) = get_ffmpeg_path() {
        if path.exists() {
            return path.to_string_lossy().to_string();
        }
    }
    "ffmpeg".to_string()
}

/// Status of dependencies
#[derive(serde::Serialize, Clone)]
pub struct DepsStatus {
    pub ytdlp_installed: bool,
    pub ffmpeg_installed: bool,
    pub ready: bool,
}

/// Check status of all dependencies
pub async fn check_deps_status() -> DepsStatus {
    let ytdlp = is_ytdlp_available().await;
    let ffmpeg = is_ffmpeg_available().await;

    DepsStatus {
        ytdlp_installed: ytdlp,
        ffmpeg_installed: ffmpeg,
        ready: ytdlp && ffmpeg,
    }
}

/// Progress callback type
pub type ProgressCallback = Box<dyn Fn(&str, f64) + Send + Sync>;

/// Download yt-dlp
pub async fn download_ytdlp<F>(on_progress: F) -> Result<()>
where
    F: Fn(&str, f64) + Send + Sync,
{
    let deps_dir = get_deps_dir()?;
    tokio::fs::create_dir_all(&deps_dir).await
        .map_err(|e| AppError::DependencyError(format!("Failed to create deps directory: {}", e)))?;

    #[cfg(windows)]
    let url = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
    #[cfg(target_os = "macos")]
    let url = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos";
    #[cfg(target_os = "linux")]
    let url = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";

    let target_path = get_ytdlp_path()?;

    on_progress("Downloading yt-dlp...", 0.0);

    download_file(url, &target_path, |progress| {
        on_progress("Downloading yt-dlp...", progress * 0.5); // 0-50%
    }).await?;

    // Make executable on Unix
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = tokio::fs::metadata(&target_path).await
            .map_err(|e| AppError::DependencyError(format!("Failed to get permissions: {}", e)))?
            .permissions();
        perms.set_mode(0o755);
        tokio::fs::set_permissions(&target_path, perms).await
            .map_err(|e| AppError::DependencyError(format!("Failed to set permissions: {}", e)))?;
    }

    on_progress("yt-dlp ready!", 50.0);

    Ok(())
}

/// Download ffmpeg
pub async fn download_ffmpeg<F>(on_progress: F) -> Result<()>
where
    F: Fn(&str, f64) + Send + Sync,
{
    let deps_dir = get_deps_dir()?;
    tokio::fs::create_dir_all(&deps_dir).await
        .map_err(|e| AppError::DependencyError(format!("Failed to create deps directory: {}", e)))?;

    on_progress("Downloading ffmpeg...", 50.0);

    #[cfg(windows)]
    {
        // Download ffmpeg zip for Windows
        let url = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip";
        let zip_path = deps_dir.join("ffmpeg.zip");

        download_file(url, &zip_path, |progress| {
            on_progress("Downloading ffmpeg...", 50.0 + progress * 0.4); // 50-90%
        }).await?;

        on_progress("Extracting ffmpeg...", 90.0);

        // Extract ffmpeg.exe from zip
        extract_ffmpeg_from_zip(&zip_path, &deps_dir).await?;

        // Clean up zip
        let _ = tokio::fs::remove_file(&zip_path).await;
    }

    #[cfg(target_os = "macos")]
    {
        // For macOS, download from evermeet.cx (static build)
        let url = "https://evermeet.cx/ffmpeg/getrelease/zip";
        let zip_path = deps_dir.join("ffmpeg.zip");

        download_file(url, &zip_path, |progress| {
            on_progress("Downloading ffmpeg...", 50.0 + progress * 0.4);
        }).await?;

        on_progress("Extracting ffmpeg...", 90.0);

        // Extract
        extract_ffmpeg_from_zip_macos(&zip_path, &deps_dir).await?;

        let _ = tokio::fs::remove_file(&zip_path).await;

        // Make executable
        use std::os::unix::fs::PermissionsExt;
        let ffmpeg_path = get_ffmpeg_path()?;
        if ffmpeg_path.exists() {
            let mut perms = tokio::fs::metadata(&ffmpeg_path).await?.permissions();
            perms.set_mode(0o755);
            tokio::fs::set_permissions(&ffmpeg_path, perms).await?;
        }
    }

    #[cfg(target_os = "linux")]
    {
        // For Linux, download static build from John Van Sickle
        let url = "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz";
        let archive_path = deps_dir.join("ffmpeg.tar.xz");

        download_file(url, &archive_path, |progress| {
            on_progress("Downloading ffmpeg...", 50.0 + progress * 0.4);
        }).await?;

        on_progress("Extracting ffmpeg...", 90.0);

        // Extract using tar command (simpler than implementing tar.xz in Rust)
        extract_ffmpeg_linux(&archive_path, &deps_dir).await?;

        let _ = tokio::fs::remove_file(&archive_path).await;
    }

    on_progress("ffmpeg ready!", 100.0);

    Ok(())
}

/// Download a file with progress reporting
async fn download_file<F>(url: &str, target: &PathBuf, on_progress: F) -> Result<()>
where
    F: Fn(f64),
{
    let client = reqwest::Client::new();
    let response = client.get(url)
        .send()
        .await
        .map_err(|e| AppError::DependencyError(format!("Download failed: {}", e)))?;

    if !response.status().is_success() {
        return Err(AppError::DependencyError(format!(
            "Download failed with status: {}", response.status()
        )));
    }

    let total_size = response.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;

    let mut file = std::fs::File::create(target)
        .map_err(|e| AppError::DependencyError(format!("Failed to create file: {}", e)))?;

    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| AppError::DependencyError(format!("Download error: {}", e)))?;

        file.write_all(&chunk)
            .map_err(|e| AppError::DependencyError(format!("Write error: {}", e)))?;

        downloaded += chunk.len() as u64;

        if total_size > 0 {
            let progress = (downloaded as f64 / total_size as f64) * 100.0;
            on_progress(progress);
        }
    }

    Ok(())
}

/// Extract ffmpeg.exe from the BtbN zip (Windows)
#[cfg(windows)]
async fn extract_ffmpeg_from_zip(zip_path: &PathBuf, target_dir: &PathBuf) -> Result<()> {
    use std::io::Read;

    let file = std::fs::File::open(zip_path)
        .map_err(|e| AppError::DependencyError(format!("Failed to open zip: {}", e)))?;

    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| AppError::DependencyError(format!("Failed to read zip: {}", e)))?;

    // Find ffmpeg.exe in the archive (it's in a subdirectory)
    for i in 0..archive.len() {
        let mut file = archive.by_index(i)
            .map_err(|e| AppError::DependencyError(format!("Failed to read zip entry: {}", e)))?;

        let name = file.name().to_string();

        if name.ends_with("bin/ffmpeg.exe") {
            let target_path = target_dir.join("ffmpeg.exe");
            let mut outfile = std::fs::File::create(&target_path)
                .map_err(|e| AppError::DependencyError(format!("Failed to create ffmpeg.exe: {}", e)))?;

            let mut contents = Vec::new();
            file.read_to_end(&mut contents)
                .map_err(|e| AppError::DependencyError(format!("Failed to read ffmpeg.exe: {}", e)))?;

            outfile.write_all(&contents)
                .map_err(|e| AppError::DependencyError(format!("Failed to write ffmpeg.exe: {}", e)))?;

            return Ok(());
        }
    }

    Err(AppError::DependencyError("ffmpeg.exe not found in archive".into()))
}

/// Extract ffmpeg from zip (macOS)
#[cfg(target_os = "macos")]
async fn extract_ffmpeg_from_zip_macos(zip_path: &PathBuf, target_dir: &PathBuf) -> Result<()> {
    use std::io::Read;

    let file = std::fs::File::open(zip_path)
        .map_err(|e| AppError::DependencyError(format!("Failed to open zip: {}", e)))?;

    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| AppError::DependencyError(format!("Failed to read zip: {}", e)))?;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i)
            .map_err(|e| AppError::DependencyError(format!("Failed to read zip entry: {}", e)))?;

        let name = file.name().to_string();

        if name == "ffmpeg" || name.ends_with("/ffmpeg") {
            let target_path = target_dir.join("ffmpeg");
            let mut outfile = std::fs::File::create(&target_path)
                .map_err(|e| AppError::DependencyError(format!("Failed to create ffmpeg: {}", e)))?;

            let mut contents = Vec::new();
            file.read_to_end(&mut contents)
                .map_err(|e| AppError::DependencyError(format!("Failed to read ffmpeg: {}", e)))?;

            outfile.write_all(&contents)
                .map_err(|e| AppError::DependencyError(format!("Failed to write ffmpeg: {}", e)))?;

            return Ok(());
        }
    }

    Err(AppError::DependencyError("ffmpeg not found in archive".into()))
}

/// Extract ffmpeg from tar.xz (Linux)
#[cfg(target_os = "linux")]
async fn extract_ffmpeg_linux(archive_path: &PathBuf, target_dir: &PathBuf) -> Result<()> {
    // Use tar command to extract
    let output = Command::new("tar")
        .args([
            "-xf",
            archive_path.to_str().unwrap(),
            "-C",
            target_dir.to_str().unwrap(),
            "--wildcards",
            "*/ffmpeg",
            "--strip-components=1",
        ])
        .output()
        .await
        .map_err(|e| AppError::DependencyError(format!("Failed to extract: {}", e)))?;

    if !output.status.success() {
        return Err(AppError::DependencyError("Failed to extract ffmpeg".into()));
    }

    // Make executable
    use std::os::unix::fs::PermissionsExt;
    let ffmpeg_path = target_dir.join("ffmpeg");
    if ffmpeg_path.exists() {
        let mut perms = tokio::fs::metadata(&ffmpeg_path).await
            .map_err(|e| AppError::DependencyError(format!("Failed to get permissions: {}", e)))?
            .permissions();
        perms.set_mode(0o755);
        tokio::fs::set_permissions(&ffmpeg_path, perms).await
            .map_err(|e| AppError::DependencyError(format!("Failed to set permissions: {}", e)))?;
    }

    Ok(())
}

/// Install all missing dependencies
pub async fn install_dependencies<F>(on_progress: F) -> Result<()>
where
    F: Fn(&str, f64) + Send + Sync + Clone,
{
    let status = check_deps_status().await;

    if !status.ytdlp_installed {
        download_ytdlp(on_progress.clone()).await?;
    }

    if !status.ffmpeg_installed {
        download_ffmpeg(on_progress).await?;
    }

    Ok(())
}
