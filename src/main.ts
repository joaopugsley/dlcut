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

// Window controls
const minimizeBtn = document.getElementById("btn-minimize") as HTMLButtonElement;
const closeBtn = document.getElementById("btn-close") as HTMLButtonElement;

// Window reference for resizing
let appWindow: Awaited<ReturnType<typeof import("@tauri-apps/api/window").getCurrentWindow>> | null = null;
const WINDOW_WIDTH = 520;
let resizeTimeout: number | null = null;

async function setupWindowControls() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  appWindow = getCurrentWindow();

  minimizeBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await appWindow!.minimize();
  });

  closeBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await appWindow!.close();
  });

  // Enable window dragging on titlebar
  const titlebar = document.querySelector(".titlebar") as HTMLElement;
  titlebar.addEventListener("mousedown", async (e) => {
    // Only drag if clicking on the titlebar itself, not on buttons
    if ((e.target as HTMLElement).closest(".titlebar-controls")) return;
    await appWindow!.startDragging();
  });

  // Initial resize
  await doResize();
}

// Resize window to fit content (debounced)
function resizeWindowToContent() {
  if (resizeTimeout) {
    clearTimeout(resizeTimeout);
  }
  resizeTimeout = window.setTimeout(() => doResize(), 10);
}

async function doResize() {
  if (!appWindow) return;

  const { LogicalSize } = await import("@tauri-apps/api/dpi");
  const windowFrame = document.querySelector(".window-frame") as HTMLElement;

  // Wait for layout to settle
  await new Promise((resolve) => requestAnimationFrame(resolve));

  // Get the actual content height
  const contentHeight = windowFrame.scrollHeight;

  // Add small padding for the border
  const targetHeight = contentHeight + 2;

  await appWindow.setSize(new LogicalSize(WINDOW_WIDTH, targetHeight));
}

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

interface VideoQuality {
  height: number;
  label: string;
  filesize_approx: string | null;
}

interface AudioQuality {
  quality_id: string;
  label: string;
  bitrate: number;
}

type DownloadMode = "video_with_audio" | "audio_only";

interface VideoInfo {
  id: string;
  title: string;
  duration: number;
  duration_string: string;
  thumbnail: string | null;
  uploader: string | null;
  formats: VideoFormat[];
  video_qualities: VideoQuality[];
  audio_qualities: AudioQuality[];
}

interface ProgressUpdate {
  stage: "fetching" | "downloading" | "cutting" | "complete" | "error";
  percent: number;
  message: string;
  speed: string | null;
  eta: string | null;
}

interface DepsStatus {
  ytdlp_installed: boolean;
  ffmpeg_installed: boolean;
  ready: boolean;
}

interface SetupProgress {
  message: string;
  progress: number;
}

// DOM Elements
const setupSection = document.getElementById("setup-section") as HTMLElement;
const setupMessage = document.getElementById("setup-message") as HTMLParagraphElement;
const setupProgressFill = document.getElementById("setup-progress-fill") as HTMLDivElement;
const urlSection = document.getElementById("url-section") as HTMLElement;
const urlInput = document.getElementById("url-input") as HTMLInputElement;
const urlError = document.getElementById("url-error") as HTMLParagraphElement;
const videoInfoSkeleton = document.getElementById("video-info-skeleton") as HTMLElement;
const videoInfoSection = document.getElementById("video-info") as HTMLElement;
const thumbnail = document.getElementById("thumbnail") as HTMLImageElement;
const videoTitle = document.getElementById("video-title") as HTMLHeadingElement;
const videoUploader = document.getElementById("video-uploader") as HTMLParagraphElement;
const videoDuration = document.getElementById("video-duration") as HTMLParagraphElement;
const modeSection = document.getElementById("mode-section") as HTMLElement;
const modeVideoBtn = document.getElementById("mode-video") as HTMLButtonElement;
const modeAudioBtn = document.getElementById("mode-audio") as HTMLButtonElement;
const qualitySection = document.getElementById("quality-section") as HTMLElement;
const qualitySelect = document.getElementById("quality-select") as HTMLSelectElement;
const cutSection = document.getElementById("cut-section") as HTMLElement;
const startTimeInput = document.getElementById("start-time") as HTMLInputElement;
const endTimeInput = document.getElementById("end-time") as HTMLInputElement;
const cutError = document.getElementById("cut-error") as HTMLParagraphElement;
const rangeSlider = document.getElementById("range-slider") as HTMLElement;
const rangeSelection = document.getElementById("range-selection") as HTMLElement;
const handleStart = document.getElementById("handle-start") as HTMLElement;
const handleEnd = document.getElementById("handle-end") as HTMLElement;
const labelStart = document.getElementById("label-start") as HTMLElement;
const labelEnd = document.getElementById("label-end") as HTMLElement;
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
const statusText = document.getElementById("status-text") as HTMLSpanElement;
const openFolderBtn = document.getElementById("open-folder-btn") as HTMLButtonElement;
const appFooter = document.querySelector(".app-footer") as HTMLElement;

// State
let currentVideoInfo: VideoInfo | null = null;
let fetchTimeout: number | null = null;
let isDownloading = false;
let currentMode: DownloadMode = "video_with_audio";
let lastDownloadedPath: string | null = null;

// Slider state
let sliderStartPercent = 0;
let sliderEndPercent = 100;
let activeHandle: "start" | "end" | null = null;

// Initialize
async function init() {
  // Set up window controls (minimize, close)
  await setupWindowControls();

  // Display app version
  const { getVersion } = await import("@tauri-apps/api/app");
  const version = await getVersion();
  document.getElementById("app-version")!.textContent = `v${version}`;

  // Check if dependencies are installed
  const depsStatus = await invoke<DepsStatus>("check_dependencies");

  if (!depsStatus.ready) {
    // Show setup section, hide URL input and footer
    urlSection.classList.add("hidden");
    appFooter.classList.add("hidden");
    setupSection.classList.remove("hidden");
    resizeWindowToContent();

    // Listen for setup progress
    await listen<SetupProgress>("setup-progress", (event) => {
      setupMessage.textContent = event.payload.message;
      setupProgressFill.style.width = `${event.payload.progress}%`;
    });

    // Install dependencies
    try {
      await invoke("install_dependencies");

      // Setup complete
      setupMessage.textContent = "Ready!";
      setupProgressFill.style.width = "100%";

      // Wait a moment then show main UI
      await new Promise((resolve) => setTimeout(resolve, 500));

      setupSection.classList.add("hidden");
      urlSection.classList.remove("hidden");
      appFooter.classList.remove("hidden");
      resizeWindowToContent();
    } catch (error) {
      setupMessage.textContent = `Setup failed: ${error}`;
      setupProgressFill.style.width = "0%";
      return;
    }
  }

  // Set up event listeners
  urlInput.addEventListener("input", handleUrlInput);
  urlInput.addEventListener("paste", handleUrlPaste);
  modeVideoBtn.addEventListener("click", () => handleModeChange("video_with_audio"));
  modeAudioBtn.addEventListener("click", () => handleModeChange("audio_only"));
  qualitySelect.addEventListener("change", handleQualityChange);
  downloadBtn.addEventListener("click", handleDownload);
  cancelBtn.addEventListener("click", handleCancel);
  openFolderBtn.addEventListener("click", handleOpenFolder);

  // Range slider events
  handleStart.addEventListener("mousedown", (e) => startDrag(e, "start"));
  handleEnd.addEventListener("mousedown", (e) => startDrag(e, "end"));
  handleStart.addEventListener("touchstart", (e) => startDrag(e, "start"), { passive: false });
  handleEnd.addEventListener("touchstart", (e) => startDrag(e, "end"), { passive: false });
  document.addEventListener("mousemove", onDrag);
  document.addEventListener("mouseup", stopDrag);
  document.addEventListener("touchmove", onDrag, { passive: false });
  document.addEventListener("touchend", stopDrag);

  // Resize when collapsible is toggled
  const cutCollapsible = cutSection.querySelector("details");
  if (cutCollapsible) {
    cutCollapsible.addEventListener("toggle", () => resizeWindowToContent());
  }

  // Credits links - open in browser
  const { open } = await import("@tauri-apps/plugin-shell");

  document.getElementById("credits-twitter")!.addEventListener("click", async (e) => {
    e.preventDefault();
    await open("https://twitter.com/i/user/996532148436918272");
  });

  document.getElementById("credits-github")!.addEventListener("click", async (e) => {
    e.preventDefault();
    await open("https://github.com/joaopugsley");
  });

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
  show(videoInfoSkeleton);

  try {
    currentVideoInfo = await invoke<VideoInfo>("fetch_video_info", { url });
    hide(videoInfoSkeleton);
    displayVideoInfo(currentVideoInfo);
  } catch (error) {
    hide(videoInfoSkeleton);
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

  // Initialize slider with video duration
  resetSlider();

  // Populate quality options based on current mode
  populateQualityOptions();

  // Show sections
  show(videoInfoSection);
  show(cutSection);
  show(modeSection);
  show(qualitySection);
}

// Handle mode change (video+audio or audio only)
function handleModeChange(mode: DownloadMode) {
  currentMode = mode;

  // Update button states
  if (mode === "video_with_audio") {
    modeVideoBtn.classList.add("active");
    modeAudioBtn.classList.remove("active");
  } else {
    modeVideoBtn.classList.remove("active");
    modeAudioBtn.classList.add("active");
  }

  // Repopulate quality options (auto-selects highest and shows download button)
  populateQualityOptions();
}

// Populate quality dropdown based on current mode and auto-select highest
function populateQualityOptions() {
  if (!currentVideoInfo) return;

  qualitySelect.innerHTML = "";

  if (currentMode === "video_with_audio") {
    for (const quality of currentVideoInfo.video_qualities) {
      const option = document.createElement("option");
      option.value = quality.height.toString();

      // Build label: "1080p • ~150 MB"
      const parts = [quality.label];
      if (quality.filesize_approx) {
        parts.push(`~${quality.filesize_approx}`);
      }

      option.textContent = parts.join(" • ");
      qualitySelect.appendChild(option);
    }
  } else {
    for (const quality of currentVideoInfo.audio_qualities) {
      const option = document.createElement("option");
      option.value = quality.quality_id;
      option.textContent = quality.label;
      qualitySelect.appendChild(option);
    }
  }

  // Auto-select first (highest) quality option
  if (qualitySelect.options.length > 0) {
    qualitySelect.selectedIndex = 0;
    show(downloadSection);
  }
}

// Handle quality selection
function handleQualityChange() {
  if (qualitySelect.value) {
    show(downloadSection);
  } else {
    hide(downloadSection);
  }
}

// Slider functions
function startDrag(e: MouseEvent | TouchEvent, handle: "start" | "end") {
  e.preventDefault();
  activeHandle = handle;
}

function onDrag(e: MouseEvent | TouchEvent) {
  if (!activeHandle || !currentVideoInfo) return;
  e.preventDefault();

  const rect = rangeSlider.getBoundingClientRect();
  const clientX = e instanceof MouseEvent ? e.clientX : e.touches[0].clientX;
  let percent = ((clientX - rect.left) / rect.width) * 100;
  percent = Math.max(0, Math.min(100, percent));

  if (activeHandle === "start") {
    sliderStartPercent = Math.min(percent, sliderEndPercent - 1);
  } else {
    sliderEndPercent = Math.max(percent, sliderStartPercent + 1);
  }

  updateSliderUI();
}

function stopDrag() {
  activeHandle = null;
}

function updateSliderUI() {
  if (!currentVideoInfo) return;

  // Update handle positions
  handleStart.style.left = `${sliderStartPercent}%`;
  handleEnd.style.left = `${sliderEndPercent}%`;

  // Update selection highlight
  rangeSelection.style.left = `${sliderStartPercent}%`;
  rangeSelection.style.width = `${sliderEndPercent - sliderStartPercent}%`;

  // Calculate times
  const duration = currentVideoInfo.duration;
  const startTime = (sliderStartPercent / 100) * duration;
  const endTime = (sliderEndPercent / 100) * duration;

  // Update labels
  labelStart.textContent = formatTime(startTime);
  labelEnd.textContent = formatTime(endTime);

  // Update hidden inputs
  startTimeInput.value = sliderStartPercent > 0 ? startTime.toString() : "";
  endTimeInput.value = sliderEndPercent < 100 ? endTime.toString() : "";
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function resetSlider() {
  sliderStartPercent = 0;
  sliderEndPercent = 100;
  updateSliderUI();
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

  // Get selected quality
  if (!qualitySelect.value) {
    showStatus("Please select a quality", "error");
    return;
  }

  const quality = qualitySelect.value;
  const ext = currentMode === "video_with_audio" ? "mp4" : "mp3";
  const fileTypeName = currentMode === "video_with_audio" ? "Video" : "Audio";

  // Generate filename
  const filename = await invoke<string>("generate_filename", {
    title: currentVideoInfo.title,
    formatExt: ext,
  });

  // Get default download directory
  const defaultDir = await invoke<string | null>("get_default_download_dir");

  // Open save dialog using Tauri's dialog plugin
  const { save } = await import("@tauri-apps/plugin-dialog");

  const outputPath = await save({
    defaultPath: defaultDir ? `${defaultDir}/${filename}` : filename,
    filters: [
      { name: fileTypeName, extensions: [ext] },
      { name: "All Files", extensions: ["*"] },
    ],
    title: `Save ${fileTypeName} As`,
  });

  if (!outputPath) {
    // User cancelled
    return;
  }

  // Get cut times from slider (stored as seconds in hidden inputs)
  const startTime = startTimeInput.value ? parseFloat(startTimeInput.value) : null;
  const endTime = endTimeInput.value ? parseFloat(endTimeInput.value) : null;

  // Start download
  isDownloading = true;
  hide(downloadSection);
  hide(statusSection);
  show(progressSection);

  try {
    await invoke("start_download", {
      request: {
        url: urlInput.value.trim(),
        quality: quality,
        mode: currentMode,
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

  const newSpeed = progress.speed || "";
  const newEta = progress.eta ? `ETA: ${progress.eta}` : "";

  // Resize window when speed/ETA visibility changes (content height may change)
  const hadDetails = progressSpeed.textContent !== "" || progressEta.textContent !== "";
  const hasDetails = newSpeed !== "" || newEta !== "";

  progressSpeed.textContent = newSpeed;
  progressEta.textContent = newEta;

  if (hasDetails !== hadDetails) {
    resizeWindowToContent();
  }
}

// Handle download completion
function handleDownloadComplete(path: string) {
  isDownloading = false;
  lastDownloadedPath = path;
  hide(progressSection);
  show(downloadSection);
  showStatus(`Downloaded successfully to:\n${path}`, "success");
  openFolderBtn.classList.remove("hidden");
  resizeWindowToContent();
}

// Open folder containing the downloaded file
async function handleOpenFolder() {
  if (!lastDownloadedPath) return;
  try {
    await invoke("show_in_folder", { path: lastDownloadedPath });
  } catch {
    // Silently ignore - file may have been moved
  }
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
  currentMode = "video_with_audio";
  sliderStartPercent = 0;
  sliderEndPercent = 100;
  videoInfoSkeleton.classList.add("hidden");
  videoInfoSection.classList.add("hidden");
  modeSection.classList.add("hidden");
  qualitySection.classList.add("hidden");
  cutSection.classList.add("hidden");
  downloadSection.classList.add("hidden");
  progressSection.classList.add("hidden");
  statusSection.classList.add("hidden");
  openFolderBtn.classList.add("hidden");
  urlError.classList.add("hidden");
  cutError.classList.add("hidden");
  qualitySelect.innerHTML = '<option value="">Select quality...</option>';
  modeVideoBtn.classList.add("active");
  modeAudioBtn.classList.remove("active");
  startTimeInput.value = "";
  endTimeInput.value = "";
  progressFill.style.width = "0%";
  resizeWindowToContent();
}

// Helper functions
function show(element: HTMLElement) {
  element.classList.remove("hidden");
  resizeWindowToContent();
}

function hide(element: HTMLElement) {
  element.classList.add("hidden");
  resizeWindowToContent();
}

function showError(element: HTMLElement, message: string) {
  element.textContent = message;
  element.classList.remove("hidden");
}

function hideError(element: HTMLElement) {
  element.classList.add("hidden");
}

function showStatus(message: string, type: "success" | "error") {
  statusText.textContent = message;
  statusMessage.className = `status ${type}`;
  if (type !== "success") {
    openFolderBtn.classList.add("hidden");
  }
  show(statusSection);
}

// Start the app
init();
