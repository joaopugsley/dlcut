/**
 * DLCut Frontend
 *
 * Minimal JavaScript for interacting with the Tauri backend.
 * No frameworks - just vanilla TypeScript with Tauri's API.
 */

// Tauri APIs are available globally via withGlobalTauri
// @ts-expect-error
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

// @ts-expect-error
const { invoke, convertFileSrc } = window.__TAURI__.core;
// @ts-expect-error
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

// Check for updates against GitHub releases
async function checkForUpdates(currentVersion: string) {
  try {
    const res = await fetch("https://api.github.com/repos/joaopugsley/dlcut/releases/latest");
    if (!res.ok) return;
    const data = await res.json();
    const latestTag: string = data.tag_name;
    const latestVersion = latestTag.replace(/^v/, "");
    if (latestVersion === currentVersion) return;

    const updateLink = document.getElementById("update-link") as HTMLAnchorElement;
    updateLink.textContent = `new version ${latestTag} is out`;
    updateLink.classList.remove("hidden");
    updateLink.addEventListener("click", async (e) => {
      e.preventDefault();
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(data.html_url);
    });
  } catch {
    // Silently ignore - network may be unavailable
  }
}

// Initialize
async function init() {
  // Set up window controls (minimize, close)
  await setupWindowControls();

  // Display app version and check for updates
  const { getVersion } = await import("@tauri-apps/api/app");
  const version = await getVersion();
  document.getElementById("app-version")!.textContent = `v${version}`;
  checkForUpdates(version);

  // Check if dependencies are installed
  const depsStatus = await invoke<DepsStatus>("check_dependencies");

  if (!depsStatus.ready) {
    // Show setup section, hide URL input and footer
    urlSection.classList.add("hidden");
    appFooter.classList.add("hidden");
    setupSection.classList.remove("hidden");
    resizeWindowToContent();

    // Listen for setup progress
    await listen<SetupProgress>("setup-progress", (event: { payload: { message: string | null; progress: any; }; }) => {
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
    await open("https://github.com/joaopugsley/dlcut");
  });

  // Listen for progress events from backend
  await listen<ProgressUpdate>("progress", (event: { payload: ProgressUpdate; }) => {
    updateProgress(event.payload);
  });

  await listen<string>("download-complete", (event: { payload: string; }) => {
    handleDownloadComplete(event.payload);
  });

  await listen<string>("download-error", (event: { payload: string; }) => {
    handleDownloadError(event.payload);
  });

  // Initialize cut tab
  await initCutTab();

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
function handleUrlPaste() {
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
    displayVideoInfo(currentVideoInfo!);
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

  // Resize window when speed visibility changes (content height may change)
  const hadSpeed = progressSpeed.textContent !== "";
  const hasSpeed = newSpeed !== "";

  progressSpeed.textContent = newSpeed;

  if (hasSpeed !== hadSpeed) {
    resizeWindowToContent();
  }
}

// Handle download completion
function handleDownloadComplete(path: string) {
  isDownloading = false;
  lastDownloadedPath = path;
  hide(progressSection);
  show(downloadSection);
  // Unhide button before showing status so resize captures full height
  openFolderBtn.classList.remove("hidden");
  showStatus(`Downloaded successfully to:\n${path}`, "success");
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

// ==================== CUT TAB ====================

// Tab DOM Elements
const tabBtnDownload = document.getElementById("tab-btn-download") as HTMLButtonElement;
const tabBtnCut = document.getElementById("tab-btn-cut") as HTMLButtonElement;
const tabDownload = document.getElementById("tab-download") as HTMLElement;
const tabCut = document.getElementById("tab-cut") as HTMLElement;

// Cut DOM Elements
const cutOpenBtn = document.getElementById("cut-open-btn") as HTMLButtonElement;
const cutFileLabel = document.getElementById("cut-file-label") as HTMLSpanElement;
const cutSkeletonSection = document.getElementById("cut-skeleton-section") as HTMLElement;
const cutPreviewSection = document.getElementById("cut-preview-section") as HTMLElement;
const cutVideo = document.getElementById("cut-video") as HTMLVideoElement;
const cutPlayBtn = document.getElementById("cut-play-btn") as HTMLButtonElement;
const cutPlayIcon = document.getElementById("cut-play-icon") as unknown as SVGElement;
const cutPauseIcon = document.getElementById("cut-pause-icon") as unknown as SVGElement;
const cutCurrentTime = document.getElementById("cut-current-time") as HTMLSpanElement;
const cutTotalTime = document.getElementById("cut-total-time") as HTMLSpanElement;
const cutTimeline = document.getElementById("cut-timeline") as HTMLElement;
const cutTimelineSelection = document.getElementById("cut-timeline-selection") as HTMLElement;
const cutTimelineDimLeft = document.getElementById("cut-timeline-dim-left") as HTMLElement;
const cutTimelineDimRight = document.getElementById("cut-timeline-dim-right") as HTMLElement;
const cutTrimStart = document.getElementById("cut-trim-start") as HTMLElement;
const cutTrimEnd = document.getElementById("cut-trim-end") as HTMLElement;
const cutPlayhead = document.getElementById("cut-playhead") as HTMLElement;
const cutLabelStart = document.getElementById("cut-label-start") as HTMLElement;
const cutLabelEnd = document.getElementById("cut-label-end") as HTMLElement;
const cutGotoStart = document.getElementById("cut-goto-start") as HTMLButtonElement;
const cutGotoEnd = document.getElementById("cut-goto-end") as HTMLButtonElement;
const cutActionSection = document.getElementById("cut-action-section") as HTMLElement;
const cutBtn = document.getElementById("cut-btn") as HTMLButtonElement;
const cutProgressSection = document.getElementById("cut-progress-section") as HTMLElement;
const cutProgressMessage = document.getElementById("cut-progress-message") as HTMLSpanElement;
const cutProgressPercent = document.getElementById("cut-progress-percent") as HTMLSpanElement;
const cutProgressFill = document.getElementById("cut-progress-fill") as HTMLDivElement;
const cutStatusSection = document.getElementById("cut-status-section") as HTMLElement;
const cutStatusMessage = document.getElementById("cut-status-message") as HTMLDivElement;
const cutStatusText = document.getElementById("cut-status-text") as HTMLSpanElement;
const cutOpenFolderBtn = document.getElementById("cut-open-folder-btn") as HTMLButtonElement;

// Cut state
let cutFilePath: string | null = null;
let cutVideoDuration = 0;
let cutSliderStartPercent = 0;
let cutSliderEndPercent = 100;
let cutActiveHandle: "start" | "end" | "playhead" | null = null;
let isCutting = false;
let lastCutPath: string | null = null;

// Tab switching
function switchTab(tab: "download" | "cut") {
  if (tab === "download") {
    tabBtnDownload.classList.add("active");
    tabBtnCut.classList.remove("active");
    tabDownload.classList.remove("hidden");
    tabCut.classList.add("hidden");
  } else {
    tabBtnDownload.classList.remove("active");
    tabBtnCut.classList.add("active");
    tabDownload.classList.add("hidden");
    tabCut.classList.remove("hidden");
  }

  resizeWindowToContent();
}

// Open video file for cutting
// Revoke previous blob URL to free memory
let cutBlobUrl: string | null = null;

const VIDEO_EXTENSIONS = ["mp4", "mkv", "avi", "mov", "webm", "flv", "wmv", "m4v"];

async function handleCutOpenFile() {
  const { open } = await import("@tauri-apps/plugin-dialog");

  const selected = await open({
    multiple: false,
    filters: [{
      name: "Video",
      extensions: VIDEO_EXTENSIONS,
    }],
    title: "Open Video File",
  });

  if (!selected) return;
  await loadCutFile(selected);
}

async function loadCutFile(filePath: string) {
  cutFilePath = filePath;

  // Update UI
  const fileName = filePath.split(/[\\/]/).pop() || filePath;
  cutFileLabel.textContent = fileName;
  cutOpenBtn.classList.add("has-file");

  // Hide previous sections, show skeleton
  cutPreviewSection.classList.add("hidden");
  cutActionSection.classList.add("hidden");
  cutStatusSection.classList.add("hidden");
  cutProgressSection.classList.add("hidden");
  cutSkeletonSection.classList.remove("hidden");
  resizeWindowToContent();

  // Revoke previous blob URL if any
  if (cutBlobUrl) {
    URL.revokeObjectURL(cutBlobUrl);
    cutBlobUrl = null;
  }

  // Serve the file via a local HTTP server with range request support.
  // WebView2 rejects Tauri's asset protocol for <video> elements, and loading
  // entire files into memory via blob URLs crashes on large videos.
  const videoUrl = await invoke<string>("serve_local_file", { path: filePath });
  cutVideo.src = videoUrl;
  cutVideo.load();
}

// Video loaded - show preview and controls
function handleCutVideoLoaded() {
  cutVideoDuration = cutVideo.duration;
  cutTotalTime.textContent = formatTime(cutVideoDuration);
  cutCurrentTime.textContent = formatTime(0);

  // Reset slider and playhead
  cutSliderStartPercent = 0;
  cutSliderEndPercent = 100;
  updateCutSliderUI();
  // Seek to cut start and position playhead there
  cutVideo.currentTime = 0;
  updatePlayheadPosition(cutSliderStartPercent);

  // Hide skeleton, show actual sections
  cutSkeletonSection.classList.add("hidden");
  cutPreviewSection.classList.remove("hidden");
  cutActionSection.classList.remove("hidden");
  resizeWindowToContent();
}

// Video time update
function handleCutTimeUpdate() {
  if (cutVideoDuration <= 0) return;

  // Clamp to cut range (with tolerance for keyframe seeking)
  const seekTolerance = 0.15;
  const startTime = (cutSliderStartPercent / 100) * cutVideoDuration;
  const endTime = (cutSliderEndPercent / 100) * cutVideoDuration;

  if (cutVideo.currentTime >= endTime) {
    cutVideo.pause();
    cutVideo.currentTime = endTime;
    updateCutPlayButton();
  } else if (cutVideo.currentTime < startTime - seekTolerance) {
    cutVideo.currentTime = startTime;
  }

  cutCurrentTime.textContent = formatTime(cutVideo.currentTime);

  const percent = (cutVideo.currentTime / cutVideoDuration) * 100;
  updatePlayheadPosition(percent);
}

// Play/Pause toggle
function toggleCutPlayback() {
  if (cutVideo.paused) {
    // If at end marker, seek to start marker
    const startTime = (cutSliderStartPercent / 100) * cutVideoDuration;
    const endTime = (cutSliderEndPercent / 100) * cutVideoDuration;
    if (cutVideo.currentTime >= endTime || cutVideo.currentTime < startTime) {
      cutVideo.currentTime = startTime;
    }
    cutVideo.play();
  } else {
    cutVideo.pause();
  }
  updateCutPlayButton();
}

function updateCutPlayButton() {
  if (cutVideo.paused) {
    cutPlayIcon.classList.remove("hidden");
    cutPauseIcon.classList.add("hidden");
  } else {
    cutPlayIcon.classList.add("hidden");
    cutPauseIcon.classList.remove("hidden");
  }
}

// Cut slider functions
// Check if a screen X coordinate is close to a trim handle; returns which one (or null)
function getNearTrimHandle(clientX: number): "start" | "end" | null {
  const THRESHOLD = 12; // px
  const startRect = cutTrimStart.getBoundingClientRect();
  const endRect = cutTrimEnd.getBoundingClientRect();
  const distStart = Math.abs(clientX - (startRect.left + startRect.width / 2));
  const distEnd = Math.abs(clientX - (endRect.left + endRect.width / 2));
  // If both are within threshold, pick the closer one
  if (distStart <= THRESHOLD && distEnd <= THRESHOLD) {
    return distStart <= distEnd ? "start" : "end";
  }
  if (distStart <= THRESHOLD) return "start";
  if (distEnd <= THRESHOLD) return "end";
  return null;
}

function startCutDrag(e: MouseEvent | TouchEvent, handle: "start" | "end") {
  e.preventDefault();
  e.stopPropagation();
  cutActiveHandle = handle;
}

function onCutDrag(e: MouseEvent | TouchEvent) {
  if (!cutActiveHandle || cutVideoDuration <= 0) return;
  e.preventDefault();

  const track = cutTimeline.querySelector(".timeline-track") as HTMLElement;
  const rect = track.getBoundingClientRect();
  const clientX = e instanceof MouseEvent ? e.clientX : e.touches[0].clientX;
  let percent = ((clientX - rect.left) / rect.width) * 100;
  percent = Math.max(0, Math.min(100, percent));

  if (cutActiveHandle === "playhead") {
    // Constrain playhead to cut range
    const seekPercent = Math.max(cutSliderStartPercent, Math.min(cutSliderEndPercent, percent));
    const time = (seekPercent / 100) * cutVideoDuration;
    cutVideo.currentTime = time;
    updatePlayheadPosition(seekPercent);
  } else {
    const minGap = 2;
    if (cutActiveHandle === "start") {
      cutSliderStartPercent = Math.min(percent, cutSliderEndPercent - minGap);
    } else {
      cutSliderEndPercent = Math.max(percent, cutSliderStartPercent + minGap);
    }

    updateCutSliderUI();

    // Seek video to trim handle position for preview
    const clampedPercent = cutActiveHandle === "start" ? cutSliderStartPercent : cutSliderEndPercent;
    const time = (clampedPercent / 100) * cutVideoDuration;
    cutVideo.currentTime = time;
    updatePlayheadPosition(clampedPercent);
  }
}

function stopCutDrag() {
  cutActiveHandle = null;
}

function updateCutSliderUI() {
  const selectionWidth = cutSliderEndPercent - cutSliderStartPercent;

  cutTimelineDimLeft.style.width = `${cutSliderStartPercent}%`;
  cutTimelineSelection.style.width = `${selectionWidth}%`;
  cutTimelineDimRight.style.width = `${100 - cutSliderEndPercent}%`;

  const startTime = (cutSliderStartPercent / 100) * cutVideoDuration;
  const endTime = (cutSliderEndPercent / 100) * cutVideoDuration;

  cutLabelStart.textContent = formatTime(startTime);
  cutLabelEnd.textContent = formatTime(endTime);
}

// Position the playhead, remapping within the cut range so it stays
// visually between the inner edges of the 8px trim handles.
const TRIM_HANDLE_PX = 8;

function updatePlayheadPosition(percent: number) {
  const track = cutTimeline.querySelector(".timeline-track") as HTMLElement;
  const trackWidth = track.offsetWidth;
  if (trackWidth <= 0) {
    cutPlayhead.style.left = `${percent}%`;
    return;
  }

  const offsetPct = (TRIM_HANDLE_PX / trackWidth) * 100;
  const range = cutSliderEndPercent - cutSliderStartPercent;

  // Tolerance for floating point / keyframe seeking differences
  const epsilon = 0.5;

  // If within (or very near) the cut range, remap to the inner area between trim handles
  if (range > 0 && percent >= cutSliderStartPercent - epsilon && percent <= cutSliderEndPercent + epsilon) {
    const innerStart = cutSliderStartPercent + offsetPct;
    const innerEnd = cutSliderEndPercent - offsetPct;

    if (innerEnd > innerStart) {
      const t = Math.max(0, Math.min(1, (percent - cutSliderStartPercent) / range));
      const adjusted = innerStart + t * (innerEnd - innerStart);
      cutPlayhead.style.left = `${adjusted}%`;
    } else {
      cutPlayhead.style.left = `${cutSliderStartPercent + range / 2}%`;
    }
  } else {
    cutPlayhead.style.left = `${percent}%`;
  }
}

// Handle cut button click
async function handleCut() {
  if (!cutFilePath || isCutting || cutVideoDuration <= 0) return;

  const startTime = (cutSliderStartPercent / 100) * cutVideoDuration;
  const endTime = (cutSliderEndPercent / 100) * cutVideoDuration;

  if (endTime - startTime < 0.5) {
    showCutStatus("Selected range is too short", "error");
    return;
  }

  // Get file extension from input
  const ext = cutFilePath.split(".").pop() || "mp4";
  const baseName = cutFilePath.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") || "output";

  const defaultDir = await invoke<string | null>("get_default_download_dir");
  const { save } = await import("@tauri-apps/plugin-dialog");

  const outputPath = await save({
    defaultPath: defaultDir ? `${defaultDir}/${baseName}_cut.${ext}` : `${baseName}_cut.${ext}`,
    filters: [
      { name: "Video", extensions: [ext] },
      { name: "All Files", extensions: ["*"] },
    ],
    title: "Save Cut Video As",
  });

  if (!outputPath) return;

  isCutting = true;
  cutActionSection.classList.add("hidden");
  cutStatusSection.classList.add("hidden");
  cutProgressSection.classList.remove("hidden");
  cutProgressFill.style.width = "0%";
  cutProgressMessage.textContent = "Starting cut...";
  cutProgressPercent.textContent = "0%";
  resizeWindowToContent();

  try {
    await invoke("cut_local_video", {
      inputPath: cutFilePath,
      outputPath,
      startTime,
      endTime,
    });
  } catch (error) {
    handleCutError(`${error}`);
  }
}

function handleCutProgress(progress: ProgressUpdate) {
  cutProgressMessage.textContent = progress.message;
  cutProgressPercent.textContent = `${Math.round(progress.percent)}%`;
  cutProgressFill.style.width = `${progress.percent}%`;
}

function handleCutComplete(path: string) {
  isCutting = false;
  lastCutPath = path;
  cutProgressSection.classList.add("hidden");
  cutActionSection.classList.remove("hidden");
  showCutStatus(`Cut saved to:\n${path}`, "success");
  cutOpenFolderBtn.classList.remove("hidden");
  resizeWindowToContent();
}

function handleCutError(error: string) {
  isCutting = false;
  cutProgressSection.classList.add("hidden");
  cutActionSection.classList.remove("hidden");
  showCutStatus(error, "error");
}

function showCutStatus(message: string, type: "success" | "error") {
  cutStatusText.textContent = message;
  cutStatusMessage.className = `status ${type}`;
  if (type !== "success") {
    cutOpenFolderBtn.classList.add("hidden");
  }
  cutStatusSection.classList.remove("hidden");
  resizeWindowToContent();
}

async function handleCutOpenFolder() {
  if (!lastCutPath) return;
  try {
    await invoke("show_in_folder", { path: lastCutPath });
  } catch {
    // Silently ignore
  }
}

// Initialize cut tab event listeners
async function initCutTab() {
  // Tab switching
  tabBtnDownload.addEventListener("click", () => switchTab("download"));
  tabBtnCut.addEventListener("click", () => switchTab("cut"));

  // File open (button + drag-and-drop)
  cutOpenBtn.addEventListener("click", handleCutOpenFile);

  const cutFileArea = document.getElementById("cut-file-area") as HTMLElement;
  await appWindow!.onDragDropEvent((event) => {
    // Only handle drops when cut tab is visible
    if (tabCut.classList.contains("hidden")) return;

    if (event.payload.type === "over") {
      cutFileArea.classList.add("drag-over");
    } else if (event.payload.type === "leave") {
      cutFileArea.classList.remove("drag-over");
    } else if (event.payload.type === "drop") {
      cutFileArea.classList.remove("drag-over");
      const paths: string[] = event.payload.paths;
      const videoFile = paths.find((p) => {
        const ext = p.split(".").pop()?.toLowerCase() || "";
        return VIDEO_EXTENSIONS.includes(ext);
      });
      if (videoFile) {
        loadCutFile(videoFile);
      }
    }
  });

  // Video events
  cutVideo.addEventListener("loadedmetadata", handleCutVideoLoaded);
  cutVideo.addEventListener("timeupdate", handleCutTimeUpdate);
  cutVideo.addEventListener("error", () => {
    const err = cutVideo.error;
    const msg = err ? `Video error: ${err.message}` : "Failed to load video";
    console.error(msg, "src:", cutVideo.src);
    cutSkeletonSection.classList.add("hidden");
    cutFileLabel.textContent = msg;
    cutOpenBtn.classList.remove("has-file");
    resizeWindowToContent();
  });
  cutVideo.addEventListener("click", toggleCutPlayback);
  cutVideo.addEventListener("pause", updateCutPlayButton);
  cutVideo.addEventListener("play", updateCutPlayButton);

  // Playback controls
  cutPlayBtn.addEventListener("click", toggleCutPlayback);

  // Timeline trim handle events
  cutTrimStart.addEventListener("mousedown", (e) => startCutDrag(e, "start"));
  cutTrimEnd.addEventListener("mousedown", (e) => startCutDrag(e, "end"));
  cutTrimStart.addEventListener("touchstart", (e) => startCutDrag(e, "start"), { passive: false });
  cutTrimEnd.addEventListener("touchstart", (e) => startCutDrag(e, "end"), { passive: false });
  document.addEventListener("mousemove", onCutDrag);
  document.addEventListener("mouseup", stopCutDrag);
  document.addEventListener("touchmove", onCutDrag, { passive: false });
  document.addEventListener("touchend", stopCutDrag);

  // Playhead drag — but prioritize trim handles when overlapping
  function playheadMouseDown(e: MouseEvent | TouchEvent) {
    e.preventDefault();
    e.stopPropagation();
    const clientX = e instanceof MouseEvent ? e.clientX : e.touches[0].clientX;
    const nearHandle = getNearTrimHandle(clientX);
    cutActiveHandle = nearHandle ?? "playhead";
  }
  cutPlayhead.addEventListener("mousedown", playheadMouseDown);
  cutPlayhead.addEventListener("touchstart", playheadMouseDown, { passive: false });

  // Click on timeline to seek (constrained to cut range)
  cutTimeline.addEventListener("mousedown", (e) => {
    if ((e.target as HTMLElement).closest(".timeline-trim")) return;
    if ((e.target as HTMLElement).closest(".timeline-playhead")) return;
    if (cutVideoDuration <= 0) return;
    const track = cutTimeline.querySelector(".timeline-track") as HTMLElement;
    const rect = track.getBoundingClientRect();
    const rawPercent = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
    const percent = Math.max(cutSliderStartPercent, Math.min(cutSliderEndPercent, rawPercent));
    const time = (percent / 100) * cutVideoDuration;
    cutVideo.currentTime = time;
    updatePlayheadPosition(percent);
  });

  // Go to cut start / end
  cutGotoStart.addEventListener("click", () => {
    if (cutVideoDuration <= 0) return;
    cutVideo.currentTime = (cutSliderStartPercent / 100) * cutVideoDuration;
    updatePlayheadPosition(cutSliderStartPercent);
  });
  cutGotoEnd.addEventListener("click", () => {
    if (cutVideoDuration <= 0) return;
    cutVideo.currentTime = (cutSliderEndPercent / 100) * cutVideoDuration;
    updatePlayheadPosition(cutSliderEndPercent);
  });

  // Cut button
  cutBtn.addEventListener("click", handleCut);

  // Open folder
  cutOpenFolderBtn.addEventListener("click", handleCutOpenFolder);

  // Listen for cut events
  await listen<ProgressUpdate>("cut-progress", (event: { payload: ProgressUpdate }) => {
    handleCutProgress(event.payload);
  });

  await listen<string>("cut-complete", (event: { payload: string }) => {
    handleCutComplete(event.payload);
  });

  await listen<string>("cut-error", (event: { payload: string }) => {
    handleCutError(event.payload);
  });
}

// Start the app
init();