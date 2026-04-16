//! Native microphone capture via cpal (CoreAudio on macOS).
//!
//! Works around the WKWebView limitation where navigator.mediaDevices
//! is not exposed. Captures audio on the Rust side, resamples to
//! 16 kHz mono Int16 PCM, and emits chunks to the frontend via
//! Tauri events so the same WebSocket pipeline can consume them.

use std::sync::Mutex;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, Stream, StreamConfig};
use tauri::{AppHandle, Emitter, State};

const TARGET_SAMPLE_RATE: u32 = 16_000;
const CHUNK_SAMPLES: usize = 1600; // 100 ms at 16 kHz

/// Shared state — holds the active capture stream. `None` when stopped.
/// Stream is not `Sync`, so we wrap in a Mutex for interior mutability.
pub struct MicState {
    stream: Mutex<Option<Stream>>,
}

impl MicState {
    pub fn new() -> Self {
        Self {
            stream: Mutex::new(None),
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
                    let mono = to_mono_f32_from_u16(data, input_channels);
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

    Ok(MicInfo {
        device: device_name,
        input_sample_rate: input_rate,
        target_sample_rate: TARGET_SAMPLE_RATE,
        channels: input_channels as u32,
    })
}

#[tauri::command]
pub fn stop_mic_capture(state: State<'_, MicState>) -> Result<(), String> {
    let mut guard = state.stream.lock().map_err(|e| e.to_string())?;
    *guard = None; // drops the stream -> stops capture
    Ok(())
}

#[derive(serde::Serialize)]
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

fn to_mono_f32_from_u16(data: &[u16], channels: usize) -> Vec<f32> {
    let conv: Vec<f32> = data
        .iter()
        .map(|&s| (s as f32 - 32768.0) / 32768.0)
        .collect();
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
