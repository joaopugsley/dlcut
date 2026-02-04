/**
 * DLCut Frontend
 *
 * Minimal JavaScript for interacting with the Tauri backend.
 * No frameworks - just vanilla TypeScript with Tauri's API.
 */

// Tauri APIs are available globally via withGlobalTauri
declare global {
  interface Window {
    __TAURI__: {
      core: {
        invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
      };
      event: {
        listen: <T>(
          event: string,
          handler: (event: { payload: T }) => void
        ) => Promise<() => void>;
      };
    };
    __TAURI_INTERNALS__: {
      invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
    };
  }
}

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// Types matching Rust structures
interface VideoFormat {
  format_id: string;
  ext: string;
  resolution: string;
  fps: number | null;
  vcodec: string | null;
  acodec: string | null;
  filesize: number | null;
  filesize_approx: string | null;
  quality: string;
  has_video: boolean;
  has_audio: boolean;
}

interface VideoInfo {
  id: string;
  title: string;
  duration: number;
  duration_string: string;
  thumbnail: string | null;
  uploader: string | null;
  formats: VideoFormat[];
}

interface ProgressUpdate {
  stage: "fetching" | "downloading" | "cutting" | "complete" | "error";
  percent: number;
  message: string;
  speed: string | null;
  eta: string | null;
}

// DOM Elements
const urlInput = document.getElementById("url-input") as HTMLInputElement;
const urlError = document.getElementById("url-error") as HTMLParagraphElement;
const videoInfoSection = document.getElementById("video-info") as HTMLElement;
const thumbnail = document.getElementById("thumbnail") as HTMLImageElement;
const videoTitle = document.getElementById("video-title") as HTMLHeadingElement;
const videoUploader = document.getElementById("video-uploader") as HTMLParagraphElement;
const videoDuration = document.getElementById("video-duration") as HTMLParagraphElement;
const formatSection = document.getElementById("format-section") as HTMLElement;
const formatSelect = document.getElementById("format-select") as HTMLSelectElement;
const cutSection = document.getElementById("cut-section") as HTMLElement;
const startTimeInput = document.getElementById("start-time") as HTMLInputElement;
const endTimeInput = document.getElementById("end-time") as HTMLInputElement;
const cutError = document.getElementById("cut-error") as HTMLParagraphElement;
const downloadSection = document.getElementById("download-section") as HTMLElement;
const downloadBtn = document.getElementById("download-btn") as HTMLButtonElement;
const progressSection = document.getElementById("progress-section") as HTMLElement;
const progressMessage = document.getElementById("progress-message") as HTMLSpanElement;
const progressPercent = document.getElementById("progress-percent") as HTMLSpanElement;
const progressFill = document.getElementById("progress-fill") as HTMLDivElement;
const progressSpeed = document.getElementById("progress-speed") as HTMLSpanElement;
const progressEta = document.getElementById("progress-eta") as HTMLSpanElement;
const cancelBtn = document.getElementById("cancel-btn") as HTMLButtonElement;
const statusSection = document.getElementById("status-section") as HTMLElement;
const statusMessage = document.getElementById("status-message") as HTMLDivElement;

// State
let currentVideoInfo: VideoInfo | null = null;
let fetchTimeout: number | null = null;
let isDownloading = false;

// Initialize
async function init() {
  try {
    await invoke("check_dependencies");
  } catch (error) {
    showStatus(`${error}`, "error");
  }

  // Set up event listeners
  urlInput.addEventListener("input", handleUrlInput);
  urlInput.addEventListener("paste", handleUrlPaste);
  formatSelect.addEventListener("change", handleFormatChange);
  downloadBtn.addEventListener("click", handleDownload);
  cancelBtn.addEventListener("click", handleCancel);
  startTimeInput.addEventListener("blur", validateTimestamps);
  endTimeInput.addEventListener("blur", validateTimestamps);

  // Listen for progress events from backend
  await listen<ProgressUpdate>("progress", (event) => {
    updateProgress(event.payload);
  });

  await listen<string>("download-complete", (event) => {
    handleDownloadComplete(event.payload);
  });

  await listen<string>("download-error", (event) => {
    handleDownloadError(event.payload);
  });

  // Focus URL input on load
  urlInput.focus();
}

// URL input handler with debounce
function handleUrlInput() {
  hideError(urlError);

  // Debounce the fetch
  if (fetchTimeout) {
    clearTimeout(fetchTimeout);
  }

  const url = urlInput.value.trim();
  if (!url) {
    resetUI();
    return;
  }

  // Wait for user to stop typing
  fetchTimeout = window.setTimeout(() => {
    if (isYouTubeUrl(url)) {
      fetchVideoInfo(url);
    }
  }, 500);
}

// Handle paste event - fetch immediately
function handleUrlPaste(event: ClipboardEvent) {
  // Let the paste complete first
  setTimeout(() => {
    const url = urlInput.value.trim();
    if (isYouTubeUrl(url)) {
      if (fetchTimeout) clearTimeout(fetchTimeout);
      fetchVideoInfo(url);
    }
  }, 0);
}

// Basic YouTube URL validation (detailed validation happens on backend)
function isYouTubeUrl(url: string): boolean {
  return (
    url.includes("youtube.com/watch") ||
    url.includes("youtu.be/") ||
    url.includes("youtube.com/shorts/")
  );
}

// Fetch video information
async function fetchVideoInfo(url: string) {
  resetUI();
  urlInput.classList.add("loading");

  try {
    currentVideoInfo = await invoke<VideoInfo>("fetch_video_info", { url });
    displayVideoInfo(currentVideoInfo);
  } catch (error) {
    showError(urlError, `${error}`);
  } finally {
    urlInput.classList.remove("loading");
  }
}

// Display video information
function displayVideoInfo(info: VideoInfo) {
  // Thumbnail
  if (info.thumbnail) {
    thumbnail.src = info.thumbnail;
    thumbnail.alt = info.title;
  } else {
    thumbnail.src = "";
    thumbnail.alt = "No thumbnail";
  }

  // Details
  videoTitle.textContent = info.title;
  videoUploader.textContent = info.uploader || "Unknown uploader";
  videoDuration.textContent = info.duration_string;

  // Populate format select
  formatSelect.innerHTML = '<option value="">Select quality...</option>';
  for (const format of info.formats) {
    const option = document.createElement("option");
    option.value = format.format_id;

    // Build label: "1080p • h264 • ~150 MB"
    const parts = [format.quality];
    if (format.vcodec && format.vcodec !== "none") {
      // Simplify codec name
      const codec = format.vcodec.split(".")[0];
      parts.push(codec);
    }
    if (format.filesize_approx) {
      parts.push(`~${format.filesize_approx}`);
    }
    if (!format.has_audio) {
      parts.push("(no audio)");
    }

    option.textContent = parts.join(" • ");
    option.dataset.ext = format.ext;
    formatSelect.appendChild(option);
  }

  // Set placeholder for end time
  endTimeInput.placeholder = info.duration_string;

  // Show sections
  show(videoInfoSection);
  show(formatSection);
  show(cutSection);
}

// Handle format selection
function handleFormatChange() {
  if (formatSelect.value) {
    show(downloadSection);
  } else {
    hide(downloadSection);
  }
}

// Validate timestamps
async function validateTimestamps(): Promise<boolean> {
  if (!currentVideoInfo) return false;

  hideError(cutError);

  const start = startTimeInput.value.trim();
  const end = endTimeInput.value.trim();

  if (!start && !end) return true;

  try {
    await invoke("validate_timestamps", {
      start: start || null,
      end: end || null,
      duration: currentVideoInfo.duration,
    });
    return true;
  } catch (error) {
    showError(cutError, `${error}`);
    return false;
  }
}

// Handle download button click
async function handleDownload() {
  if (!currentVideoInfo || isDownloading) return;

  // Validate timestamps first
  const valid = await validateTimestamps();
  if (!valid) return;

  // Get selected format
  const selectedOption = formatSelect.selectedOptions[0];
  if (!selectedOption || !formatSelect.value) {
    showStatus("Please select a quality", "error");
    return;
  }

  const formatId = formatSelect.value;
  const ext = selectedOption.dataset.ext || "mp4";

  // Generate filename
  const filename = await invoke<string>("generate_filename", {
    title: currentVideoInfo.title,
    formatExt: ext,
  });

  // Get default download directory
  const defaultDir = await invoke<string | null>("get_default_download_dir");

  // Open save dialog using Tauri's dialog plugin
  // We need to use the global Tauri API for the dialog plugin
  const { save } = await import("@tauri-apps/plugin-dialog");

  const outputPath = await save({
    defaultPath: defaultDir ? `${defaultDir}/${filename}` : filename,
    filters: [
      { name: "Video", extensions: [ext] },
      { name: "All Files", extensions: ["*"] },
    ],
    title: "Save Video As",
  });

  if (!outputPath) {
    // User cancelled
    return;
  }

  // Parse timestamps
  let startTime: number | null = null;
  let endTime: number | null = null;

  const startStr = startTimeInput.value.trim();
  const endStr = endTimeInput.value.trim();

  if (startStr || endStr) {
    const [start, end] = await invoke<[number | null, number | null]>(
      "validate_timestamps",
      {
        start: startStr || null,
        end: endStr || null,
        duration: currentVideoInfo.duration,
      }
    );
    startTime = start;
    endTime = end;
  }

  // Start download
  isDownloading = true;
  hide(downloadSection);
  hide(statusSection);
  show(progressSection);

  try {
    await invoke("start_download", {
      request: {
        url: urlInput.value.trim(),
        format_id: formatId,
        output_path: outputPath,
        start_time: startTime,
        end_time: endTime,
      },
    });
  } catch (error) {
    handleDownloadError(`${error}`);
  }
}

// Update progress display
function updateProgress(progress: ProgressUpdate) {
  progressMessage.textContent = progress.message;
  progressPercent.textContent = `${Math.round(progress.percent)}%`;
  progressFill.style.width = `${progress.percent}%`;

  progressSpeed.textContent = progress.speed || "";
  progressEta.textContent = progress.eta ? `ETA: ${progress.eta}` : "";
}

// Handle download completion
function handleDownloadComplete(path: string) {
  isDownloading = false;
  hide(progressSection);
  show(downloadSection);
  showStatus(`Downloaded successfully to:\n${path}`, "success");
}

// Handle download error
function handleDownloadError(error: string) {
  isDownloading = false;
  hide(progressSection);
  show(downloadSection);
  showStatus(error, "error");
}

// Handle cancel button
async function handleCancel() {
  try {
    await invoke("cancel_download");
    isDownloading = false;
    hide(progressSection);
    show(downloadSection);
    showStatus("Download cancelled", "error");
  } catch (error) {
    // Ignore cancellation errors
  }
}

// Reset UI to initial state
function resetUI() {
  currentVideoInfo = null;
  hide(videoInfoSection);
  hide(formatSection);
  hide(cutSection);
  hide(downloadSection);
  hide(progressSection);
  hide(statusSection);
  hideError(urlError);
  hideError(cutError);
  formatSelect.innerHTML = '<option value="">Select quality...</option>';
  startTimeInput.value = "";
  endTimeInput.value = "";
  progressFill.style.width = "0%";
}

// Helper functions
function show(element: HTMLElement) {
  element.classList.remove("hidden");
}

function hide(element: HTMLElement) {
  element.classList.add("hidden");
}

function showError(element: HTMLElement, message: string) {
  element.textContent = message;
  element.classList.remove("hidden");
}

function hideError(element: HTMLElement) {
  element.classList.add("hidden");
}

function showStatus(message: string, type: "success" | "error") {
  statusMessage.textContent = message;
  statusMessage.className = `status ${type}`;
  show(statusSection);
}

// Start the app
init();
