//! Clipboard read helper for SDD 017-B (on-demand assist).
//!
//! Exposes a single `#[tauri::command]` that reads the system clipboard
//! and returns the text to the frontend. We use the `arboard` crate
//! directly (rather than `tauri-plugin-clipboard-manager`) because:
//!
//! * It keeps the capability allow-list unchanged.
//! * No polling, no passive monitoring — the command only runs when the
//!   user explicitly triggers it via the global shortcut (Cmd+Shift+V).
//! * `arboard` already handles the macOS NSPasteboard dance correctly.

use arboard::Clipboard;

/// Read the current clipboard contents as plain text.
///
/// Returns an empty string when the clipboard is empty or holds a
/// non-text payload (image, files…). Only propagates a hard error when
/// the clipboard itself cannot be opened (e.g. some sandbox edge cases).
#[tauri::command]
pub fn read_clipboard() -> Result<String, String> {
    let mut clipboard = Clipboard::new().map_err(|e| format!("clipboard open: {}", e))?;
    match clipboard.get_text() {
        Ok(text) => Ok(text),
        // Empty / non-text clipboard is a normal state, not an error.
        Err(_) => Ok(String::new()),
    }
}
