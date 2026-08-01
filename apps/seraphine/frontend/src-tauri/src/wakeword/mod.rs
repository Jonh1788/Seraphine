//! Native wake-word detection — "Ei Seraphine".
//!
//! Replaces the old speech-to-text loop (VAD segment -> Whisper -> regex),
//! which cost a full transcription for a binary decision and only ran while
//! the webview was awake. This runs entirely in Rust, so on iOS it keeps
//! listening after the screen goes off, where the WKWebView is suspended.
//!
//! Shape of it:
//!
//! ```text
//!   native mic callback ──feed()──> bounded queue ──> worker thread
//!   (cpal / VPIO / AVAudioEngine)                     chain + threshold
//!                                                     + refractory
//!                                                          │
//!                                       app.emit("wakeword-detected")
//! ```
//!
//! The audio callbacks never touch the models: they push 16 kHz i16 samples
//! onto a bounded channel and return. All inference happens on the worker
//! thread, so a slow frame can never stall CoreAudio. If the queue backs up
//! (it should not — 80 ms of work per 80 ms of audio) samples are dropped
//! rather than blocking the audio thread.
//!
//! This module is a *sink*. It never opens its own microphone stream when
//! one already exists — on iOS two input streams fight over the audio
//! session, and on macOS over the HAL. `wakeword_start` asks the platform's
//! existing capture layer for a handle and releases it on stop.

pub mod chain;

#[cfg(test)]
mod tests;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender, TrySendError};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use chain::{Detector, WakeWordChain, DEFAULT_REFRACTORY_S, DEFAULT_THRESHOLD};

#[cfg(target_os = "ios")]
mod ios_audio;

/// Fast path for the audio callbacks: a plain atomic load, no lock, no
/// allocation when the wake word is off (the default).
static ACTIVE: AtomicBool = AtomicBool::new(false);
static TX: OnceLock<SyncSender<Msg>> = OnceLock::new();
static LAST_ERROR: Mutex<Option<String>> = Mutex::new(None);
static THRESHOLD: Mutex<f32> = Mutex::new(DEFAULT_THRESHOLD);

/// ~2.5 s of 100 ms chunks. Deep enough to ride out a scheduling hiccup,
/// shallow enough that a genuinely stuck worker drops audio instead of
/// silently accumulating latency.
const QUEUE_DEPTH: usize = 25;

enum Msg {
    Audio(Vec<i16>),
    Arm { threshold: f32, refractory_s: f32 },
    Disarm,
}

#[derive(Serialize, Clone)]
struct DetectedEvent {
    score: f32,
    threshold: f32,
}

#[derive(Serialize)]
pub struct WakeWordStatus {
    pub active: bool,
    pub threshold: f32,
    /// The validated operating point, so the UI never has to hardcode it.
    pub default_threshold: f32,
    pub last_error: Option<String>,
}

/// Feed 16 kHz mono PCM from whichever native capture is running.
///
/// Called from real-time audio callbacks — cheap and non-blocking by
/// construction. Safe to call when the wake word is disabled.
pub fn feed(samples: &[i16]) {
    if !ACTIVE.load(Ordering::Relaxed) || samples.is_empty() {
        return;
    }
    let Some(tx) = TX.get() else { return };
    match tx.try_send(Msg::Audio(samples.to_vec())) {
        Ok(()) => {}
        // Dropping audio is the correct failure here: blocking would stall
        // CoreAudio and glitch the whole output device.
        Err(TrySendError::Full(_)) => {
            log::warn!("wakeword: queue full, dropping {} samples", samples.len());
        }
        Err(TrySendError::Disconnected(_)) => {
            ACTIVE.store(false, Ordering::Relaxed);
        }
    }
}

/// C entry point for the iOS Swift audio bridge.
///
/// # Safety
/// `ptr` must point to `count` valid, initialised `i16` samples that stay
/// alive for the duration of the call. Called from `AVAudioEngine`'s tap.
#[cfg(target_os = "ios")]
#[no_mangle]
pub unsafe extern "C" fn seraphine_wakeword_push_pcm(ptr: *const i16, count: i32) {
    if ptr.is_null() || count <= 0 {
        return;
    }
    let samples = unsafe { std::slice::from_raw_parts(ptr, count as usize) };
    feed(samples);
}

fn set_error(app: &AppHandle, msg: String) {
    log::warn!("{msg}");
    if let Ok(mut slot) = LAST_ERROR.lock() {
        *slot = Some(msg.clone());
    }
    let _ = app.emit("wakeword-error", msg);
}

/// Spawn the inference worker. Idempotent — the channel lives for the
/// process, so arming and disarming does not re-parse the models.
fn worker(app: AppHandle) -> &'static SyncSender<Msg> {
    TX.get_or_init(|| {
        let (tx, rx) = sync_channel::<Msg>(QUEUE_DEPTH);
        std::thread::Builder::new()
            .name("seraphine-wakeword".into())
            .spawn(move || {
                let mut detector: Option<Detector<WakeWordChain>> = None;
                while let Ok(msg) = rx.recv() {
                    match msg {
                        Msg::Arm {
                            threshold,
                            refractory_s,
                        } => {
                            // Parsing + optimising the three models costs a
                            // few hundred ms; keep it off the UI thread and
                            // out of the audio callback.
                            match WakeWordChain::new() {
                                Ok(c) => {
                                    detector = Some(Detector::new(c, threshold, refractory_s));
                                    ACTIVE.store(true, Ordering::Relaxed);
                                    let _ = app.emit("wakeword-ready", threshold);
                                }
                                Err(e) => {
                                    ACTIVE.store(false, Ordering::Relaxed);
                                    set_error(&app, e);
                                }
                            }
                        }
                        Msg::Disarm => {
                            ACTIVE.store(false, Ordering::Relaxed);
                            if let Some(d) = detector.as_mut() {
                                d.reset();
                            }
                        }
                        Msg::Audio(pcm) => {
                            if !ACTIVE.load(Ordering::Relaxed) {
                                continue;
                            }
                            let Some(d) = detector.as_mut() else { continue };
                            match d.feed(&pcm) {
                                Ok(Some(det)) => {
                                    let threshold = *THRESHOLD.lock().unwrap();
                                    log::info!("wakeword: detected (score {:.4})", det.score);
                                    let _ = app.emit(
                                        "wakeword-detected",
                                        DetectedEvent {
                                            score: det.score,
                                            threshold,
                                        },
                                    );
                                }
                                Ok(None) => {}
                                Err(e) => {
                                    ACTIVE.store(false, Ordering::Relaxed);
                                    set_error(&app, e);
                                }
                            }
                        }
                    }
                }
            })
            .expect("spawn wakeword worker");
        tx
    })
}

/// Ask the platform's capture layer to keep a 16 kHz mono stream running.
#[cfg(not(any(target_os = "ios", target_os = "android")))]
fn acquire_audio(app: &AppHandle) -> Result<(), String> {
    crate::mic::acquire(app, crate::mic::HOLDER_WAKEWORD).map(|_| ())
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
fn release_audio(app: &AppHandle) {
    crate::mic::release(app, crate::mic::HOLDER_WAKEWORD);
}

#[cfg(target_os = "ios")]
fn acquire_audio(_app: &AppHandle) -> Result<(), String> {
    ios_audio::start()
}

#[cfg(target_os = "ios")]
fn release_audio(_app: &AppHandle) {
    ios_audio::stop();
}

#[cfg(target_os = "android")]
fn acquire_audio(_app: &AppHandle) -> Result<(), String> {
    Err("wake word capture is not implemented on Android".into())
}

#[cfg(target_os = "android")]
fn release_audio(_app: &AppHandle) {}

/// Arm the detector. Off by default — only the wake-word setting turns it on.
///
/// `threshold` overrides the validated 0.92 operating point. Do not raise or
/// lower it casually: 0.92 is where `fp_per_hour 0.454` and `recall 0.969`
/// were measured, and the margins are thin.
#[tauri::command]
pub fn wakeword_start(app: AppHandle, threshold: Option<f32>) -> Result<WakeWordStatus, String> {
    let threshold = threshold.unwrap_or(DEFAULT_THRESHOLD);
    if !(0.0..=1.0).contains(&threshold) {
        return Err(format!("wakeword: threshold {threshold} outside [0, 1]"));
    }
    *THRESHOLD.lock().unwrap() = threshold;
    if let Ok(mut slot) = LAST_ERROR.lock() {
        *slot = None;
    }

    acquire_audio(&app)?;

    let tx = worker(app.clone());
    tx.send(Msg::Arm {
        threshold,
        refractory_s: DEFAULT_REFRACTORY_S,
    })
    .map_err(|e| format!("wakeword: worker gone: {e}"))?;

    Ok(status_snapshot())
}

/// Disarm and hand the microphone back.
#[tauri::command]
pub fn wakeword_stop(app: AppHandle) -> Result<WakeWordStatus, String> {
    ACTIVE.store(false, Ordering::Relaxed);
    if let Some(tx) = TX.get() {
        let _ = tx.send(Msg::Disarm);
    }
    release_audio(&app);
    Ok(status_snapshot())
}

#[tauri::command]
pub fn wakeword_status() -> WakeWordStatus {
    status_snapshot()
}

fn status_snapshot() -> WakeWordStatus {
    WakeWordStatus {
        active: ACTIVE.load(Ordering::Relaxed),
        threshold: *THRESHOLD.lock().unwrap(),
        default_threshold: DEFAULT_THRESHOLD,
        last_error: LAST_ERROR.lock().ok().and_then(|g| g.clone()),
    }
}
