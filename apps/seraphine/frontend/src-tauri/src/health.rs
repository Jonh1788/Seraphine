//! Apple Health (HealthKit) bridge — SDD 018.
//!
//! Calls into a Swift static library (see `swift/HealthKitBridge.swift`
//! + build.rs) that talks to HealthKit natively. Swift returns JSON
//! strings; we parse them here and re-serialize into the Tauri command
//! return types so the frontend keeps its contract.
//!
//! Modes:
//!
//! * Default — real HealthKit via the Swift bridge. Requires the
//!   `com.apple.developer.healthkit` entitlement (signed build + Apple
//!   Developer account). Requires the user to grant permission on
//!   first request.
//! * `SERAPHINE_HEALTHKIT_MOCK=1` — skip the Swift bridge entirely and
//!   return deterministic synthetic data. Useful for unsigned dev
//!   builds, CI, or demos.

use chrono::{Datelike, Duration, Local, NaiveDate};
use serde::{Deserialize, Serialize};
use std::env;
use std::ffi::{c_char, CStr};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkoutSample {
    #[serde(rename = "type", alias = "workout_type")]
    pub workout_type: String,
    pub start: String,
    pub end: String,
    pub duration_min: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calories: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub distance_km: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthSnapshot {
    pub date: String,
    pub steps: i64,
    pub active_calories: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resting_heart_rate: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sleep_minutes: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sleep_quality: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weight_kg: Option<f64>,
    #[serde(default)]
    pub workouts: Vec<WorkoutSample>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthorizationStatus {
    pub authorized: bool,
    /// "mock" | "real" | "unavailable"
    pub mode: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackgroundScheduleStatus {
    pub scheduled: bool,
    pub message: String,
}

// ---------------------------------------------------------------------------
// Swift FFI surface. See swift/HealthKitBridge.swift for the producer
// side. Every function returns a C string we must free via
// `seraphine_health_free_string`.
// ---------------------------------------------------------------------------

extern "C" {
    fn seraphine_health_request_authorization() -> *mut c_char;
    fn seraphine_health_get_today_summary() -> *mut c_char;
    fn seraphine_health_get_recent(days: i32) -> *mut c_char;
    fn seraphine_health_schedule_background_sync() -> *mut c_char;
    fn seraphine_health_free_string(ptr: *mut c_char);
}

/// Safely consume a C string returned by the Swift bridge. On error,
/// returns a JSON error description matching the Swift side's format.
fn consume_swift_string(ptr: *mut c_char) -> Result<String, String> {
    if ptr.is_null() {
        return Err("swift bridge returned null".to_string());
    }
    let out = unsafe {
        CStr::from_ptr(ptr)
            .to_string_lossy()
            .into_owned()
    };
    unsafe { seraphine_health_free_string(ptr) };
    Ok(out)
}

/// Shape returned by Swift when something goes wrong. Anything else is
/// the happy-path payload for the specific command.
#[derive(Debug, Deserialize)]
struct SwiftError {
    error: String,
}

fn parse_swift<T: for<'de> Deserialize<'de>>(json: &str) -> Result<T, String> {
    if let Ok(err) = serde_json::from_str::<SwiftError>(json) {
        return Err(err.error);
    }
    serde_json::from_str::<T>(json).map_err(|e| format!("parse: {e} (payload={json})"))
}

// ---------------------------------------------------------------------------
// Mock mode
// ---------------------------------------------------------------------------

fn mock_enabled() -> bool {
    match env::var("SERAPHINE_HEALTHKIT_MOCK") {
        Ok(v) => matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes"),
        Err(_) => false,
    }
}

fn today_local() -> NaiveDate {
    Local::now().date_naive()
}

fn date_iso(d: NaiveDate) -> String {
    d.format("%Y-%m-%d").to_string()
}

fn iso_datetime_at(d: NaiveDate, hour: u32, minute: u32) -> String {
    format!("{}T{:02}:{:02}:00-03:00", date_iso(d), hour, minute)
}

fn mock_snapshot(date: NaiveDate) -> HealthSnapshot {
    let seed = (date.num_days_from_ce() as u64).wrapping_mul(2654435761);
    let next = |state: &mut u64| {
        *state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (*state >> 32) as u32
    };
    let mut s = seed;

    let steps = 5_000 + (next(&mut s) % 9_000) as i64;
    let active_calories = 120.0 + (next(&mut s) % 500) as f64;
    let rhr = 55.0 + (next(&mut s) % 17) as f64;
    let sleep_min = 330.0 + (next(&mut s) % 195) as f64;
    let weight = 69.0 + (next(&mut s) % 500) as f64 / 100.0;

    let num_workouts = (next(&mut s) % 3) as u32;
    let mut workouts = Vec::with_capacity(num_workouts as usize);
    for i in 0..num_workouts {
        let hour = 6 + (next(&mut s) % 14);
        let min = (next(&mut s) % 60) as u32;
        let duration = 18.0 + (next(&mut s) % 45) as f64;
        let end_min = min + (duration as u32);
        let end_hour = hour + (end_min / 60);
        let end_min_clamped = end_min % 60;
        let kind_idx = next(&mut s) as usize % 4;
        let kind = ["running", "walking", "cycling", "strength"][kind_idx];
        let cals = 120.0 + (next(&mut s) % 320) as f64;
        let distance = if kind == "running" || kind == "walking" || kind == "cycling" {
            Some(((duration / 10.0) * (1.0 + (i as f64 * 0.1))).round() / 2.0 * 2.0)
        } else {
            None
        };
        workouts.push(WorkoutSample {
            workout_type: kind.to_string(),
            start: iso_datetime_at(date, hour, min),
            end: iso_datetime_at(date, end_hour, end_min_clamped),
            duration_min: duration.round(),
            calories: Some(cals.round()),
            distance_km: distance,
        });
    }

    let sleep_quality = if sleep_min >= 7.0 * 60.0 {
        "boa"
    } else if sleep_min >= 5.0 * 60.0 {
        "regular"
    } else {
        "ruim"
    };

    HealthSnapshot {
        date: date_iso(date),
        steps,
        active_calories: active_calories.round(),
        resting_heart_rate: Some(rhr.round()),
        sleep_minutes: Some(sleep_min.round()),
        sleep_quality: Some(sleep_quality.to_string()),
        weight_kg: Some((weight * 10.0).round() / 10.0),
        workouts,
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

// The Swift bridge blocks on a semaphore while the HealthKit authorization
// sheet is presented. We MUST run that on a worker thread so the main
// queue is free to run the sheet's UI loop; otherwise iOS throws
// "Authorization session timed out".
async fn run_blocking<F, T>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("blocking task join: {e}"))?
}

#[tauri::command]
pub async fn health_request_authorization() -> Result<AuthorizationStatus, String> {
    if mock_enabled() {
        return Ok(AuthorizationStatus {
            authorized: true,
            mode: "mock".to_string(),
            message: "HealthKit mock mode (SERAPHINE_HEALTHKIT_MOCK=1). \
                      Dados sinteticos."
                .to_string(),
        });
    }
    run_blocking(|| {
        let ptr = unsafe { seraphine_health_request_authorization() };
        let json = consume_swift_string(ptr)?;
        parse_swift::<AuthorizationStatus>(&json)
    })
    .await
}

#[tauri::command]
pub async fn health_get_today_summary() -> Result<HealthSnapshot, String> {
    if mock_enabled() {
        return Ok(mock_snapshot(today_local()));
    }
    run_blocking(|| {
        let ptr = unsafe { seraphine_health_get_today_summary() };
        let json = consume_swift_string(ptr)?;
        parse_swift::<HealthSnapshot>(&json)
    })
    .await
}

#[tauri::command]
pub async fn health_schedule_background() -> Result<BackgroundScheduleStatus, String> {
    if mock_enabled() {
        return Ok(BackgroundScheduleStatus {
            scheduled: false,
            message: "mock mode — background scheduling skipped".to_string(),
        });
    }
    run_blocking(|| {
        let ptr = unsafe { seraphine_health_schedule_background_sync() };
        let json = consume_swift_string(ptr)?;
        parse_swift::<BackgroundScheduleStatus>(&json)
    })
    .await
}

#[tauri::command]
pub async fn health_get_recent(days: u32) -> Result<Vec<HealthSnapshot>, String> {
    let n = days.clamp(1, 365);
    if mock_enabled() {
        let today = today_local();
        let mut out: Vec<HealthSnapshot> = (0..n as i64)
            .map(|i| mock_snapshot(today - Duration::days(n as i64 - 1 - i)))
            .collect();
        out.sort_by(|a, b| a.date.cmp(&b.date));
        return Ok(out);
    }
    run_blocking(move || {
        let ptr = unsafe { seraphine_health_get_recent(n as i32) };
        let json = consume_swift_string(ptr)?;
        parse_swift::<Vec<HealthSnapshot>>(&json)
    })
    .await
}
