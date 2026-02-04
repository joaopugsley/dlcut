import { defineConfig } from "vite";

// Tauri requires specific settings for security and compatibility
export default defineConfig({
  // Prevent vite from obscuring Rust errors
  clearScreen: false,

  server: {
    // Tauri expects a fixed port, fail if not available
    port: 1420,
    strictPort: true,
    // Enable HMR for development
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },

  // Security: Only expose VITE_ prefixed env variables
  // Never expose TAURI_ to prevent leaking private keys (CVE-2023-46115)
  envPrefix: ["VITE_"],

  build: {
    // Tauri uses Chromium on Windows and WebKit on macOS/Linux
    target: process.env.TAURI_ENV_PLATFORM === "windows"
      ? "chrome105"
      : "safari13",
    // Optimize for production
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    // Produce sourcemaps for debugging
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
