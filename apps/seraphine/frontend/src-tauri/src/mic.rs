//! Native microphone capture via cpal (CoreAudio on macOS).
//!
//! Works around the WKWebView limitation where navigator.mediaDevices
//! is not exposed. Captures audio on the Rust side, resamples to
//! 16 kHz mono Int16 PCM, and emits chunks to the frontend via
//! Tauri events so the same WebSocket pipeline can consume them.

use std::collections::HashSet;
use std::sync::Mutex;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, Stream, StreamConfig};
use tauri::{AppHandle, Emitter, Manager, State};

const TARGET_SAMPLE_RATE: u32 = 16_000;
const CHUNK_SAMPLES: usize = 1600; // 100 ms at 16 kHz

/// Who currently needs the microphone. The stream is torn down only when
/// the last holder lets go — otherwise arming the wake word while realtime
/// is running (or vice versa) would have one of them yank the device out
/// from under the other, and two cpal streams on the same input device
/// fight over the CoreAudio HAL lock.
pub const HOLDER_REALTIME: &str = "realtime";
pub const HOLDER_WAKEWORD: &str = "wakeword";

/// Shared state — holds the active capture stream. `None` when stopped.
/// Stream is not `Sync`, so we wrap in a Mutex for interior mutability.
pub struct MicState {
    stream: Mutex<Option<Stream>>,
    holders: Mutex<HashSet<&'static str>>,
    info: Mutex<Option<MicInfo>>,
}

impl MicState {
    pub fn new() -> Self {
        Self {
            stream: Mutex::new(None),
            holders: Mutex::new(HashSet::new()),
            info: Mutex::new(None),
        }
    }
}

// Safety: cpal::Stream is Send but !Sync. We only touch it behind a
// Mutex inside Tauri command handlers which run serially.
unsafe impl Send for MicState {}
unsafe impl Sync for MicState {}

#[tauri::command]
pub fn start_mic_capture(
    app: AppHandle,
    state: State<'_, MicState>,
) -> Result<MicInfo, String> {
    let info = build_and_install(&app, &state)?;
    state
        .holders
        .lock()
        .map_err(|e| e.to_string())?
        .insert(HOLDER_REALTIME);
    Ok(info)
}

/// Start (or restart) the capture stream, replacing any existing one.
fn build_and_install(app: &AppHandle, state: &MicState) -> Result<MicInfo, String> {
    // Stop any existing stream first.
    {
        let mut guard = state.stream.lock().map_err(|e| e.to_string())?;
        *guard = None;
    }

    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| "No input audio device available".to_string())?;

    let device_name = device.name().unwrap_or_else(|_| "unknown".to_string());

    let supported = device
        .default_input_config()
        .map_err(|e| format!("default_input_config: {}", e))?;

    let input_rate = supported.sample_rate().0;
    let input_channels = supported.channels() as usize;
    let sample_format = supported.sample_format();

    let config: StreamConfig = supported.clone().into();

    let app_handle = app.clone();
    let mut resampler = LinearResampler::new(input_rate, TARGET_SAMPLE_RATE);
    let mut buffer: Vec<i16> = Vec::with_capacity(CHUNK_SAMPLES * 2);

    let err_fn = |err| eprintln!("[mic] stream error: {}", err);

    let stream: Stream = match sample_format {
        SampleFormat::F32 => device
            .build_input_stream(
                &config,
                move |data: &[f32], _| {
                    let mono = to_mono_f32(data, input_channels);
                    let resampled = resampler.process_f32(&mono);
                    for s in resampled {
                        let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
                        buffer.push(v);
                    }
                    flush_chunks(&mut buffer, &app_handle);
                },
                err_fn,
                None,
            )
            .map_err(|e| format!("build_input_stream(f32): {}", e))?,
        SampleFormat::I16 => device
            .build_input_stream(
                &config,
                move |data: &[i16], _| {
                    let mono = to_mono_f32_from_i16(data, input_channels);
                    let resampled = resampler.process_f32(&mono);
                    for s in resampled {
                        let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
                        buffer.push(v);
                    }
                    flush_chunks(&mut buffer, &app_handle);
                },
                err_fn,
                None,
            )
            .map_err(|e| format!("build_input_stream(i16): {}", e))?,
        SampleFormat::U16 => device
            .build_input_stream(
                &config,
                move |data: &[u16], _| {
                    let mono = to_mono_f32_from_u16_slice(data, input_channels);
                    let resampled = resampler.process_f32(&mono);
                    for s in resampled {
                        let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
                        buffer.push(v);
                    }
                    flush_chunks(&mut buffer, &app_handle);
                },
                err_fn,
                None,
            )
            .map_err(|e| format!("build_input_stream(u16): {}", e))?,
        other => return Err(format!("Unsupported sample format: {:?}", other)),
    };

    stream.play().map_err(|e| format!("stream.play: {}", e))?;

    {
        let mut guard = state.stream.lock().map_err(|e| e.to_string())?;
        *guard = Some(stream);
    }

    let info = MicInfo {
        device: device_name,
        input_sample_rate: input_rate,
        target_sample_rate: TARGET_SAMPLE_RATE,
        channels: input_channels as u32,
    };
    *state.info.lock().map_err(|e| e.to_string())? = Some(info.clone());
    Ok(info)
}

#[tauri::command]
pub fn stop_mic_capture(state: State<'_, MicState>) -> Result<(), String> {
    release_from(&state, HOLDER_REALTIME)
}

/// Keep a capture stream alive on behalf of `holder`, reusing the running
/// one if there is one. Used by the wake word so arming it does not open a
/// second microphone.
pub fn acquire(app: &AppHandle, holder: &'static str) -> Result<MicInfo, String> {
    let state = app.state::<MicState>();
    let already = state.stream.lock().map_err(|e| e.to_string())?.is_some();
    let info = if already {
        state
            .info
            .lock()
            .map_err(|e| e.to_string())?
            .clone()
            .ok_or_else(|| "mic: stream running but info missing".to_string())?
    } else {
        build_and_install(app, &state)?
    };
    state
        .holders
        .lock()
        .map_err(|e| e.to_string())?
        .insert(holder);
    Ok(info)
}

/// Drop `holder`'s claim. The stream stops only once nobody holds it.
pub fn release(app: &AppHandle, holder: &'static str) {
    let state = app.state::<MicState>();
    if let Err(e) = release_from(&state, holder) {
        log::warn!("mic: release({holder}) failed: {e}");
    }
}

fn release_from(state: &MicState, holder: &'static str) -> Result<(), String> {
    let remaining = {
        let mut holders = state.holders.lock().map_err(|e| e.to_string())?;
        holders.remove(holder);
        holders.len()
    };
    if remaining == 0 {
        let mut guard = state.stream.lock().map_err(|e| e.to_string())?;
        *guard = None; // drops the stream -> stops capture
        *state.info.lock().map_err(|e| e.to_string())? = None;
    }
    Ok(())
}

#[derive(serde::Serialize, Clone)]
pub struct MicInfo {
    pub device: String,
    pub input_sample_rate: u32,
    pub target_sample_rate: u32,
    pub channels: u32,
}

/// Flush full chunks from the buffer as Tauri events.
fn flush_chunks(buffer: &mut Vec<i16>, app: &AppHandle) {
    while buffer.len() >= CHUNK_SAMPLES {
        let chunk: Vec<i16> = buffer.drain(..CHUNK_SAMPLES).collect();
        // Wake word taps the same samples the webview gets. It is a no-op
        // (one atomic load) unless the user turned the wake word on.
        crate::wakeword::feed(&chunk);
        let _ = app.emit("mic-pcm-chunk", chunk);
    }
}

fn to_mono_f32(data: &[f32], channels: usize) -> Vec<f32> {
    if channels == 1 {
        return data.to_vec();
    }
    let frames = data.len() / channels;
    let mut out = Vec::with_capacity(frames);
    for i in 0..frames {
        let mut sum = 0.0_f32;
        for c in 0..channels {
            sum += data[i * channels + c];
        }
        out.push(sum / channels as f32);
    }
    out
}

fn to_mono_f32_from_i16(data: &[i16], channels: usize) -> Vec<f32> {
    let conv: Vec<f32> = data.iter().map(|&s| s as f32 / 32768.0).collect();
    to_mono_f32(&conv, channels)
}

/// Convert a single unsigned-offset PCM u16 sample to f32 in `[-1.0, 1.0)`.
///
/// Linear PCM u16 is unsigned-offset: range `[0, 65535]` with mid-point
/// `32768` representing silence. Using `i32` as the intermediate avoids
/// any silent f32 precision loss for the `u16::MAX` endpoint.
fn to_mono_f32_from_u16(s: u16) -> f32 {
    ((s as i32) - 32768) as f32 / 32768.0
}

fn to_mono_f32_from_u16_slice(data: &[u16], channels: usize) -> Vec<f32> {
    let conv: Vec<f32> = data.iter().map(|&s| to_mono_f32_from_u16(s)).collect();
    to_mono_f32(&conv, channels)
}

/// Simple linear resampler. Not HQ but fine for speech.
struct LinearResampler {
    input_rate: u32,
    output_rate: u32,
    position: f64,
}

impl LinearResampler {
    fn new(input_rate: u32, output_rate: u32) -> Self {
        Self {
            input_rate,
            output_rate,
            position: 0.0,
        }
    }

    fn process_f32(&mut self, input: &[f32]) -> Vec<f32> {
        if input.is_empty() {
            return Vec::new();
        }
        if self.input_rate == self.output_rate {
            return input.to_vec();
        }
        let ratio = self.input_rate as f64 / self.output_rate as f64;
        let mut out = Vec::new();
        let mut pos = self.position;
        while pos < input.len() as f64 - 1.0 {
            let idx = pos as usize;
            let frac = pos - idx as f64;
            let s = input[idx] as f64 * (1.0 - frac)
                + input[idx + 1] as f64 * frac;
            out.push(s as f32);
            pos += ratio;
        }
        // Carry over remainder for next call
        self.position = pos - input.len() as f64;
        if self.position < 0.0 {
            self.position = 0.0;
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_mono_f32_from_u16_endpoints() {
        // Min: 0 -> -1.0
        assert!((to_mono_f32_from_u16(0) - (-1.0)).abs() < 1e-6);
        // Mid: 32768 -> 0.0 (silence)
        assert!((to_mono_f32_from_u16(32768) - 0.0).abs() < 1e-6);
        // Max: 65535 -> just under 1.0 (i.e. range is [-1, 1))
        let max = to_mono_f32_from_u16(65535);
        assert!(max < 1.0 && max > 0.999, "got {max}");
    }
}
