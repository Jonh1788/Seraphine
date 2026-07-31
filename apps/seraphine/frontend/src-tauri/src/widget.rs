//! SDD task 26 — lock-screen widget snapshot.
//!
//! Thin Rust wrapper over `swift/WidgetBridge.swift`. The Swift side owns
//! the App Group container (`group.io.jonhdev.seraphine`) and writes
//! `widget-snapshot.json`; the WidgetKit extension only ever reads it.
//!
//! Two ways in:
//!   * [`widget_write_snapshot`] — caller already has the numbers.
//!   * [`widget_refresh_snapshot`] — Swift fetches `/calendar/aggregate`
//!     and `/courses/stats` itself.
//!
//! Everything is a no-op outside iOS: the App Group container simply does
//! not exist on the macOS desktop build, so the commands return an error
//! instead of pretending to have written something.

use serde::{Deserialize, Serialize};

#[cfg(target_os = "ios")]
use std::ffi::{c_char, CStr, CString};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgendaItem {
    pub title: String,
    /// "09:00" or a full ISO-8601 timestamp — the widget normalises both.
    pub at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WidgetSnapshot {
    pub agenda: Vec<AgendaItem>,
    pub streak: i64,
    pub xp: i64,
    /// Filled in by the Swift side when empty.
    #[serde(default)]
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

/// Raw JSON passthrough. The Swift bridge already returns a well-formed
/// object (`{"ok":bool,...}`), and re-typing every field here would only
/// add a second place to keep in sync.
pub type BridgeResult = serde_json::Value;

#[cfg(target_os = "ios")]
extern "C" {
    fn seraphine_widget_write_snapshot(json: *const c_char) -> *mut c_char;
    fn seraphine_widget_refresh_snapshot() -> *mut c_char;
    fn seraphine_widget_snapshot_status() -> *mut c_char;
    fn seraphine_widget_install_auto_refresh() -> *mut c_char;
    fn seraphine_widget_free_string(ptr: *mut c_char);
}

#[cfg(target_os = "ios")]
fn consume(ptr: *mut c_char) -> Result<BridgeResult, String> {
    if ptr.is_null() {
        return Err("widget bridge returned null".to_string());
    }
    let json = unsafe { CStr::from_ptr(ptr).to_string_lossy().into_owned() };
    unsafe { seraphine_widget_free_string(ptr) };
    serde_json::from_str(&json).map_err(|e| format!("parse: {e} (payload={json})"))
}

#[cfg(not(target_os = "ios"))]
const NOT_IOS: &str = "widget snapshot só existe no build iOS (App Group indisponível)";

/// Write an explicit snapshot into the App Group container.
#[tauri::command]
pub async fn widget_write_snapshot(snapshot: WidgetSnapshot) -> Result<BridgeResult, String> {
    #[cfg(target_os = "ios")]
    {
        let payload = serde_json::to_string(&snapshot).map_err(|e| format!("encode: {e}"))?;
        let c = CString::new(payload).map_err(|e| format!("cstring: {e}"))?;
        let out = unsafe { seraphine_widget_write_snapshot(c.as_ptr()) };
        consume(out)
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = snapshot;
        Err(NOT_IOS.to_string())
    }
}

/// Let the Swift side rebuild the snapshot from the backend.
#[tauri::command]
pub async fn widget_refresh_snapshot() -> Result<BridgeResult, String> {
    #[cfg(target_os = "ios")]
    {
        consume(unsafe { seraphine_widget_refresh_snapshot() })
    }
    #[cfg(not(target_os = "ios"))]
    {
        Err(NOT_IOS.to_string())
    }
}

/// Where the snapshot lives, whether it exists, and how fresh it is.
/// Exists so the App Group wiring can be verified from the app without
/// digging through the simulator's data container by hand.
#[tauri::command]
pub async fn widget_snapshot_status() -> Result<BridgeResult, String> {
    #[cfg(target_os = "ios")]
    {
        consume(unsafe { seraphine_widget_snapshot_status() })
    }
    #[cfg(not(target_os = "ios"))]
    {
        Err(NOT_IOS.to_string())
    }
}

/// Called once from the Tauri `setup` hook: refreshes now and registers a
/// `didBecomeActive` observer so every foreground refreshes the widget.
#[cfg(target_os = "ios")]
pub fn install_auto_refresh() {
    match consume(unsafe { seraphine_widget_install_auto_refresh() }) {
        Ok(v) => log::info!("[widget] auto-refresh: {v}"),
        Err(e) => log::warn!("[widget] auto-refresh falhou: {e}"),
    }
}
