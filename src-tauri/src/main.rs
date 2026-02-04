//! DLCut entry point
//!
//! This file is the entry point for the Tauri application.
//! The main logic is in lib.rs for better testing.

// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    dlcut_lib::run()
}
