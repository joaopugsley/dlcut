# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

DLCut is a desktop application for downloading and cutting YouTube videos. Built with Tauri 2.0 (Rust backend + TypeScript frontend), it wraps yt-dlp and ffmpeg for video operations.

## Commands

```bash
# Development
bun run dev           # Start Vite dev server (port 1420)
bun tauri dev         # Run full Tauri app in dev mode

# Testing & Linting
cargo test            # Run Rust tests
cargo clippy          # Lint Rust code

# Production Build
bun tauri build       # Build production binary
```

## Architecture

**Frontend** (`src/`): Vanilla TypeScript with Vite. No framework - event-driven UI with debounced handlers. Communicates with backend via Tauri IPC (`invoke()`).

**Backend** (`src-tauri/src/`):
- `lib.rs` - Tauri app initialization and command registration
- `commands.rs` - IPC command handlers (fetch_video_info, download_video, etc.)
- `types.rs` - Shared types with serde serialization
- `error.rs` - Custom AppError with safe serialization (no internals exposed to frontend)
- `ytdlp.rs` - yt-dlp CLI integration for fetching info and downloading
- `ffmpeg.rs` - Video cutting operations

**Data Flow**: Frontend → Tauri IPC → Rust Commands → yt-dlp/ffmpeg → Progress events → Frontend UI

**Key Patterns**:
- Single download at a time (AppState tracks active downloads)
- Real-time progress via Tauri event emitters, not polling
- Two-stage validation: frontend basic + backend strict
- All errors safely serialized (full error logged, safe message to frontend)

## Security

This is a HIGH-RISK security context due to web-to-native boundary. See `.agents/skills/tauri/` for detailed threat model and security patterns.

**Critical Security Rules**:
- Never expose `TAURI_` env vars; use `VITE_` prefix only
- Always validate IPC inputs on backend (don't trust frontend)
- Use `dunce::canonicalize()` for path operations
- CSP restricts sources to 'self' except YouTube thumbnail CDN

## Dependencies

- **Required**: yt-dlp (checked at startup via `check_dependencies()`)
- **Optional**: ffmpeg (only needed for post-download cutting; yt-dlp can cut during download)
