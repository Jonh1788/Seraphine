//! Apple VoiceProcessingIO audio unit — AEC + noise suppression + AGC.
//!
//! Used by the realtime voice path instead of cpal when we need echo
//! cancellation (user without headphones). The same AEC FaceTime, Siri,
//! and Zoom use on Apple devices; nothing to install, nothing to tune
//! — CoreAudio does the room calibration.
//!
//! Wiring:
//!   - Input bus 1 -> AEC-cleaned mic @ 16 kHz Float32 mono. Emitted to
//!     the frontend as `mic-pcm-chunk` events (same format as mic.rs)
//!     so tauriVad can consume it unchanged.
//!   - Output bus 0 -> PCM from TTS. We accept 24 kHz s16le chunks (the
//!     server's native format) and let CoreAudio resample; the VPIO
//!     unit also uses whatever we play on this bus as the **reference
//!     signal** for AEC on the mic.
//!
//! Lifecycle: `vpio_start` once realtime activates, `vpio_stop` when it
//! deactivates. Between utterances we keep VPIO running with silent
//! output so the adaptive filters stay warm.

#![allow(non_upper_case_globals)]
#![allow(non_snake_case)]
#![allow(clippy::missing_safety_doc)]

// Stubs for non-macOS desktops — keeps the tauri::generate_handler! list
// simple. Anyone calling these from a non-macOS build gets a clear error.
#[cfg(not(target_os = "macos"))]
mod stubs {
    use tauri::State;

    pub struct VoiceIoState;
    impl VoiceIoState {
        pub fn new() -> Self { Self }
    }

    const UNAVAILABLE: &str = "VoiceProcessingIO is macOS-only";

    #[tauri::command]
    pub fn vpio_start(_state: State<'_, VoiceIoState>) -> Result<(), String> { Err(UNAVAILABLE.into()) }
    #[tauri::command]
    pub fn vpio_stop(_state: State<'_, VoiceIoState>) -> Result<(), String> { Err(UNAVAILABLE.into()) }
    #[tauri::command]
    pub fn vpio_play_chunk(_pcm: Vec<u8>, _state: State<'_, VoiceIoState>) -> Result<(), String> { Err(UNAVAILABLE.into()) }
    #[tauri::command]
    pub fn vpio_flush_output(_state: State<'_, VoiceIoState>) -> Result<(), String> { Err(UNAVAILABLE.into()) }
    #[tauri::command]
    pub fn vpio_ring_len(_state: State<'_, VoiceIoState>) -> Result<usize, String> { Err(UNAVAILABLE.into()) }
}
#[cfg(not(target_os = "macos"))]
pub use stubs::*;

#[cfg(target_os = "macos")]
mod imp {

use std::collections::VecDeque;
use std::ffi::c_void;
use std::mem::size_of;
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use coreaudio_sys::{
    kAudioFormatFlagIsFloat, kAudioFormatFlagIsPacked, kAudioFormatLinearPCM,
    kAudioOutputUnitProperty_CurrentDevice, kAudioOutputUnitProperty_EnableIO,
    kAudioOutputUnitProperty_SetInputCallback, kAudioUnitManufacturer_Apple,
    kAudioUnitProperty_SetRenderCallback, kAudioUnitProperty_ShouldAllocateBuffer,
    kAudioUnitProperty_StreamFormat,
    kAudioUnitScope_Global, kAudioUnitScope_Input, kAudioUnitScope_Output,
    kAudioUnitSubType_VoiceProcessingIO, kAudioUnitType_Output,
    // Device discovery (AudioObjectGetPropertyData + constants)
    kAudioDevicePropertyNominalSampleRate, kAudioHardwarePropertyDefaultInputDevice,
    kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectPropertyElementMain,
    kAudioObjectPropertyName, kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject,
    AURenderCallbackStruct, AudioBuffer, AudioBufferList, AudioComponentDescription,
    AudioComponentFindNext, AudioComponentInstance, AudioComponentInstanceDispose,
    AudioComponentInstanceNew, AudioDeviceID, AudioObjectGetPropertyData,
    AudioObjectPropertyAddress, AudioOutputUnitStart, AudioOutputUnitStop,
    kCFStringEncodingUTF8,
    AudioStreamBasicDescription, AudioTimeStamp, AudioUnitGetProperty, AudioUnitInitialize,
    AudioUnitRender, AudioUnitSetProperty, AudioUnitUninitialize, CFRelease, CFStringGetCStringPtr,
    CFStringRef, OSStatus,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

// Target I/O rates for the frontend. VPIO runs at the device's native
// rate (typically 48 kHz); the callbacks do SRC to/from these rates.
const MIC_SAMPLE_RATE: f64 = 16_000.0;
const TTS_SAMPLE_RATE: f64 = 24_000.0;
// Emit a mic chunk every 100 ms to match cpal's cadence so the
// frontend's VAD/accumulator timing stays identical.
const MIC_EMIT_SAMPLES: usize = 1_600;
// Emit the rendered (about-to-play) audio every ~42 ms so the JS
// analyser that drives the avatar's lipsync can read samples at the
// moment they actually reach the speaker, not when they arrived from
// the WS. Smaller chunks = less lipsync lag but more IPC overhead.
const PLAYBACK_EMIT_SAMPLES: usize = 1_024;
// Output ring: holds a full TTS utterance so o backend pode streamar
// muito mais rápido que realtime (bursts de ~8kB em 1-2ms) sem dropar
// samples. Com 2s o ring enchia em respostas longas e pop_front() cortava
// palavras no meio da frase. 90s a 24kHz = 2.16M f32 = ~8.6MB — cobre
// qualquer utterance realista e ainda é trivial de memória.
const OUTPUT_RING_MAX: usize = 24_000 * 90;

// How many input-callback diagnostic events to emit before going quiet.
const DIAG_CB_LIMIT: u64 = 20;
// How many `vpio-playback-status` periodic events to emit (first N only).
const STATUS_EVENT_LIMIT: u64 = 20;
// Status event interval: emit one every ~200ms. At 48 kHz with 512-frame
// callbacks that's roughly every 19 callbacks (512/48000 ≈ 10.67 ms each).
const STATUS_INTERVAL_CBS: u64 = 19;

// ---------------------------------------------------------------------------
// Debug event — written by the RT audio thread, drained by a poller thread
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
struct VpioDebugCb {
    cb_index: u64,
    bus: u32,
    frames_requested: u32,
    frames_rendered: usize,
    status: i32,
    max_abs_f32: f32,
    abl_mNumberBuffers: u32,
    abl_mDataByteSize: u32,
    data_ptr_null: bool,
    negotiated_channels: u32,
    negotiated_bytes_per_frame: u32,
}

#[derive(Serialize, Clone)]
struct VpioDebugFormat {
    label: String,
    sample_rate: f64,
    channels_per_frame: u32,
    bytes_per_frame: u32,
    format_flags: u32,
    bits_per_channel: u32,
    bytes_per_packet: u32,
    frames_per_packet: u32,
    is_non_interleaved: bool,
}

/// Periodic status event (~200 ms) with ring health metrics so the
/// frontend can detect ring starvation or phase drift.
#[derive(Serialize, Clone)]
struct VpioPlaybackStatus {
    ring_size_samples: usize,
    drained_samples_last_window: u64,
    silence_output_samples_last_window: u64,
    output_phase: f64,
    render_cb_count: u64,
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

/// Debug payload for the first N render callbacks — lets us verify the
/// SRC consumption ratio in DevTools without an oscilloscope.
#[derive(Serialize, Clone)]
struct VpioRenderDebug {
    cb_index: u64,
    frames_produced: u32,
    ring_consumed: usize,
    ring_size_after: usize,
    phase_after: f64,
    ratio: f64,
    consumption_ratio: f64,  // ring_consumed / frames_produced — must ≈ 1/ratio
}

struct Ctx {
    au: AudioComponentInstance,
    /// TTS samples stored at 24 kHz. The render callback up-samples
    /// to the device rate on the fly.
    output_ring: Mutex<VecDeque<f32>>,
    /// Fractional sample position carried across render callbacks.
    /// Ensures we drain *exactly* `frames / ratio` source samples per
    /// callback with no per-callback rounding drift.
    output_phase: Mutex<f64>,
    /// Mic accumulator — holds 16 kHz samples after down-sampling.
    mic_accum: Mutex<Vec<f32>>,
    /// Samples just handed to the audio device; emitted in fixed chunks
    /// to the frontend so the avatar's JS lipsync analyser sees audio
    /// at actual playback time rather than WS arrival time.
    playback_accum: Mutex<Vec<f32>>,
    app: AppHandle,
    /// Device nominal sample rate (typically 48 000 Hz). Stored once
    /// at start so the callbacks can compute SRC ratios without
    /// querying the HAL on the audio thread.
    device_rate: f64,
    /// Diagnostic counter — number of input callbacks fired so far.
    /// We log raw sample stats for the first few callbacks so the
    /// developer can verify data is actually flowing.
    input_cb_count: AtomicU64,
    /// Counter for render (output) callbacks — used for debug diagnostics.
    render_cb_count: AtomicU64,
    /// Debug events queued by the RT audio thread. A poller thread
    /// drains this and emits Tauri events so they appear in DevTools.
    debug_queue: Mutex<Vec<VpioDebugCb>>,
    /// Render-side debug events (separate vec to avoid contention).
    render_debug_queue: Mutex<Vec<VpioRenderDebug>>,
    /// Periodic status events queued by render callback, drained by poller.
    status_queue: Mutex<Vec<VpioPlaybackStatus>>,
    /// Counter for status events emitted (first STATUS_EVENT_LIMIT only).
    status_events_emitted: AtomicU64,
    /// Samples drained from ring since last status event.
    status_drained_acc: AtomicU64,
    /// Silence output samples since last status event.
    status_silence_acc: AtomicU64,
    /// Set to false when the session stops so the poller thread exits.
    alive: AtomicBool,
    /// The actual number of channels VPIO negotiated on bus 1 output
    /// scope (what we read from AudioUnitRender). If the format is
    /// non-interleaved, each channel is a separate buffer in the ABL.
    /// If interleaved, there's one buffer with N*frames samples.
    negotiated_channels: u32,
    /// Bytes per frame on the negotiated output-scope bus 1.
    negotiated_bytes_per_frame: u32,
    /// Whether the negotiated format is non-interleaved (flag bit 5).
    negotiated_non_interleaved: bool,
    /// Pre-allocated scratch buffers reused across input callbacks so the
    /// real-time audio thread never allocates. Sized once on first call,
    /// then `clear()`+`resize()` to preserve capacity.
    ///
    /// SAFETY: `try_lock` is sufficient — the only consumer is the input
    /// callback (CoreAudio serializes per-stream, never two at once).
    /// Falling back to a stack ABL on contention keeps correctness.
    cb_buf: Mutex<Vec<f32>>,
    cb_extra_bufs: Mutex<Vec<Vec<f32>>>,
    cb_abl_dyn: Mutex<Vec<u64>>,
}

// SAFETY: `Ctx` is shared with CoreAudio's RT audio thread via a
// `*mut c_void` ref-con. `au` is an opaque CoreAudio handle that is
// thread-safely accessed through the Audio HAL (AudioUnitRender,
// AudioOutputUnitStop, etc. are documented as callable from any thread
// once the unit is initialized). All mutable state (`output_ring`,
// `mic_accum`, `playback_accum`, `output_phase`, debug queues, scratch
// buffers) is behind `Mutex`. No `&mut` aliasing occurs because
// CoreAudio guarantees the input/render callbacks are serialized
// per-stream — each callback is the only writer for its scratch
// buffers, and ring access is mediated by the lock.
unsafe impl Send for Ctx {}
// SAFETY: see Send impl above. Sharing `&Ctx` across threads is safe
// because every interior-mutable field is a `Mutex`/`Atomic`, and the
// raw `au` handle is thread-safe per CoreAudio's HAL contract.
unsafe impl Sync for Ctx {}

pub struct VoiceIoState {
    inner: Mutex<Option<Arc<Ctx>>>,
}

impl VoiceIoState {
    pub fn new() -> Self {
        Self { inner: Mutex::new(None) }
    }
}

// ---------------------------------------------------------------------------
// Callbacks
// ---------------------------------------------------------------------------

/// Input callback — VPIO tells us "there are N AEC'd mic frames ready"
/// at the device's native rate. We pull them, down-sample to 16 kHz,
/// accumulate, and emit to the frontend every `MIC_EMIT_SAMPLES`
/// (100 ms @ 16 kHz).
///
/// The ABL we hand to AudioUnitRender MUST match the format that VPIO
/// negotiated on bus 1 output scope. If VPIO chose multi-channel
/// non-interleaved, we need N separate buffers in the ABL. If it chose
/// multi-channel interleaved, we need 1 buffer with N*frames samples.
/// Mismatching this causes AudioUnitRender to silently write zeros.
unsafe extern "C" fn input_callback(
    ref_con: *mut c_void,
    flags: *mut u32,
    timestamp: *const AudioTimeStamp,
    bus: u32,
    num_frames: u32,
    _io_data: *mut AudioBufferList,
) -> OSStatus {
    if ref_con.is_null() {
        return 0;
    }
    let ctx = unsafe { &*(ref_con as *const Ctx) };
    let frames = num_frames as usize;
    let channels = ctx.negotiated_channels.max(1) as usize;
    let non_interleaved = ctx.negotiated_non_interleaved;

    // Build an ABL that matches the negotiated format.
    //
    // Non-interleaved: N buffers, each with `frames` f32 samples (1 ch).
    // Interleaved:     1 buffer with `frames * channels` f32 samples.
    //
    // For the common case (mono or interleaved), we use the AudioBufferList
    // struct directly for correct alignment. For non-interleaved multi-ch
    // we need a dynamically-sized struct.
    let total_samples = if non_interleaved && channels > 1 { frames } else { frames * channels };

    // SAFETY: pre-allocated scratch buffers in `Ctx`. We never allocate
    // on the RT audio thread — `clear()` + `resize()` reuses capacity.
    // `try_lock` is sufficient: the input callback is the only consumer
    // (CoreAudio serializes callbacks per-stream).
    let mut buf_guard = match ctx.cb_buf.try_lock() {
        Ok(g) => g,
        Err(_) => return 0, // contention impossible in practice; bail safely
    };
    buf_guard.clear();
    buf_guard.resize(total_samples, 0.0);
    let buf: &mut Vec<f32> = &mut buf_guard;

    // Extra channel buffers for non-interleaved multi-channel.
    let mut extra_guard = match ctx.cb_extra_bufs.try_lock() {
        Ok(g) => g,
        Err(_) => return 0,
    };
    if non_interleaved && channels > 1 {
        // Resize outer Vec to (channels - 1) entries, reusing inner Vec
        // capacity where possible.
        let needed = channels - 1;
        while extra_guard.len() < needed {
            extra_guard.push(Vec::with_capacity(frames));
        }
        extra_guard.truncate(needed);
        for ebuf in extra_guard.iter_mut() {
            ebuf.clear();
            ebuf.resize(frames, 0.0);
        }
    } else {
        extra_guard.clear();
    }
    let extra_bufs: &mut Vec<Vec<f32>> = &mut extra_guard;

    // For non-interleaved multi-channel we need a dynamically-sized ABL.
    // We allocate it as a properly-aligned Vec<u64> to ensure 8-byte
    // alignment for the pointer fields inside AudioBuffer.
    let abl_u64_count = if non_interleaved && channels > 1 {
        // Header (mNumberBuffers + padding) = 8 bytes = 1 u64
        // Each AudioBuffer = 16 bytes = 2 u64s
        1 + channels * 2
    } else {
        0
    };
    let mut abl_dyn_guard = match ctx.cb_abl_dyn.try_lock() {
        Ok(g) => g,
        Err(_) => return 0,
    };
    abl_dyn_guard.clear();
    abl_dyn_guard.resize(abl_u64_count, 0u64);
    let abl_dyn: &mut Vec<u64> = &mut abl_dyn_guard;

    let mut abl_stack = AudioBufferList {
        mNumberBuffers: 1,
        mBuffers: [AudioBuffer {
            mNumberChannels: channels as u32,
            mDataByteSize: (total_samples * size_of::<f32>()) as u32,
            mData: buf.as_mut_ptr() as *mut c_void,
        }],
    };

    let abl_ptr: *mut AudioBufferList = if non_interleaved && channels > 1 {
        // Cast a `Vec<u64>` storage block to `*mut AudioBufferList`. The
        // u64 backing gives us 8-byte alignment, which matches
        // `align_of::<AudioBufferList>()` on every Apple platform we ship.
        // This `debug_assert` surfaces an alignment violation immediately
        // at session start if `coreaudio-sys` ever bumps the type's
        // alignment beyond 8 bytes (today: u32 + AudioBuffer{u32, u32, *}).
        // TODO: replace with a `#[repr(C)] DynABL { count: u32, _pad: u32,
        // buffers: [AudioBuffer; MAX_BUFS] }` when channel count exceeds 8.
        let vec_ptr = abl_dyn.as_mut_ptr();
        debug_assert_eq!(
            (vec_ptr as usize) % std::mem::align_of::<AudioBufferList>(),
            0,
            "AudioBufferList alignment violation"
        );
        let abl = vec_ptr as *mut AudioBufferList;
        (*abl).mNumberBuffers = channels as u32;
        let buffers_ptr = &mut (*abl).mBuffers as *mut [AudioBuffer; 1] as *mut AudioBuffer;
        // Buffer 0 = our main buf
        let ab = &mut *buffers_ptr;
        ab.mNumberChannels = 1;
        ab.mDataByteSize = (frames * size_of::<f32>()) as u32;
        ab.mData = buf.as_mut_ptr() as *mut c_void;
        // Buffers 1..N = extra_bufs
        for (i, ebuf) in extra_bufs.iter_mut().enumerate() {
            let ab = &mut *buffers_ptr.add(i + 1);
            ab.mNumberChannels = 1;
            ab.mDataByteSize = (frames * size_of::<f32>()) as u32;
            ab.mData = ebuf.as_mut_ptr() as *mut c_void;
        }
        abl
    } else {
        &mut abl_stack as *mut AudioBufferList
    };

    let status = unsafe {
        AudioUnitRender(ctx.au, flags, timestamp, bus, num_frames, abl_ptr)
    };

    // Always count, even on error.
    let n = ctx.input_cb_count.fetch_add(1, Ordering::Relaxed);

    if status != 0 {
        // Emit diagnostic for the first N errors.
        if n < DIAG_CB_LIMIT {
            let evt = VpioDebugCb {
                cb_index: n,
                bus,
                frames_requested: num_frames,
                frames_rendered: 0,
                status,
                max_abs_f32: 0.0,
                abl_mNumberBuffers: unsafe { (*abl_ptr).mNumberBuffers },
                abl_mDataByteSize: 0,
                data_ptr_null: true,
                negotiated_channels: ctx.negotiated_channels,
                negotiated_bytes_per_frame: ctx.negotiated_bytes_per_frame,
            };
            if let Ok(mut q) = ctx.debug_queue.try_lock() {
                q.push(evt);
            }
        }
        return status;
    }

    // Read the rendered audio. For non-interleaved multi-channel, we
    // take only buffer 0 (= channel 0 = the mic's primary channel).
    // For interleaved, samples are [ch0 ch1 ch0 ch1 ...]; we stride
    // to extract channel 0 only.
    let abl_ref = unsafe { &*abl_ptr };
    let buf0_ptr = abl_ref.mBuffers[0].mData as *const f32;
    let buf0_bytes = abl_ref.mBuffers[0].mDataByteSize as usize;
    let buf0_channels = abl_ref.mBuffers[0].mNumberChannels as usize;
    let buf0_frames = if buf0_channels > 0 {
        buf0_bytes / (size_of::<f32>() * buf0_channels)
    } else {
        buf0_bytes / size_of::<f32>()
    };

    // Extract mono samples from channel 0.
    let mono_samples: Vec<f32> = if buf0_ptr.is_null() || buf0_frames == 0 {
        vec![]
    } else if non_interleaved || buf0_channels <= 1 {
        // Non-interleaved buffer 0 = channel 0 (mono), or single channel.
        let raw = unsafe { std::slice::from_raw_parts(buf0_ptr, buf0_frames) };
        raw.to_vec()
    } else {
        // Interleaved: stride by channel count to extract channel 0.
        let total = buf0_frames * buf0_channels;
        let raw = unsafe { std::slice::from_raw_parts(buf0_ptr, total) };
        raw.iter().step_by(buf0_channels).copied().collect()
    };

    // Diagnostic: emit debug info for the first N callbacks.
    if n < DIAG_CB_LIMIT {
        let max_abs = mono_samples.iter().fold(0.0_f32, |m, s| m.max(s.abs()));
        let evt = VpioDebugCb {
            cb_index: n,
            bus,
            frames_requested: num_frames,
            frames_rendered: mono_samples.len(),
            status,
            max_abs_f32: max_abs,
            abl_mNumberBuffers: abl_ref.mNumberBuffers,
            abl_mDataByteSize: buf0_bytes as u32,
            data_ptr_null: buf0_ptr.is_null(),
            negotiated_channels: ctx.negotiated_channels,
            negotiated_bytes_per_frame: ctx.negotiated_bytes_per_frame,
        };
        if let Ok(mut q) = ctx.debug_queue.try_lock() {
            q.push(evt);
        }
    }

    if mono_samples.is_empty() {
        return 0;
    }

    // Down-sample from device rate to 16 kHz. For integer ratios (e.g.
    // 48k -> 16k = 3:1) we average each group; for non-integer ratios
    // we use a simple linear resampler. Both are adequate for speech.
    let rendered_frames = mono_samples.len();
    let ratio = ctx.device_rate / MIC_SAMPLE_RATE;
    let out_len = (rendered_frames as f64 / ratio) as usize;
    let mut resampled = Vec::with_capacity(out_len);
    if (ratio - ratio.round()).abs() < 0.001 {
        // Fast path: integer ratio (3:1 for 48k->16k).
        let step = ratio as usize;
        for chunk in mono_samples.chunks(step) {
            let sum: f32 = chunk.iter().sum();
            resampled.push(sum / chunk.len() as f32);
        }
    } else {
        // General linear interpolation.
        for i in 0..out_len {
            let src_pos = i as f64 * ratio;
            let idx = src_pos as usize;
            let frac = (src_pos - idx as f64) as f32;
            let a = mono_samples[idx.min(rendered_frames - 1)];
            let b = mono_samples[(idx + 1).min(rendered_frames - 1)];
            resampled.push(a + (b - a) * frac);
        }
    }

    // Accumulate 16 kHz samples and emit fixed-size chunks.
    let mut accum = ctx.mic_accum.lock().unwrap();
    accum.extend_from_slice(&resampled);
    while accum.len() >= MIC_EMIT_SAMPLES {
        let chunk: Vec<i16> = accum
            .drain(..MIC_EMIT_SAMPLES)
            .map(|s| (s.clamp(-1.0, 1.0) * 32_767.0) as i16)
            .collect();
        // Wake word taps the AEC-cleaned mic too, so it can never hear
        // Seraphine's own TTS. Non-blocking; a no-op when disarmed.
        crate::wakeword::feed(&chunk);
        let _ = ctx.app.emit("mic-pcm-chunk", chunk);
    }
    0
}

/// Render callback — VPIO wants N frames at the device rate. The
/// `output_ring` stores 24 kHz TTS samples; we up-sample to the device
/// rate on the fly using linear interpolation and a fractional phase
/// accumulator that carries across callbacks. This ensures we consume
/// **exactly** `frames / ratio` source samples per callback with no
/// per-callback rounding drift.
///
/// If the ring is empty, output silence (safe — the VPIO output is
/// mostly quiet between utterances anyway).
unsafe extern "C" fn render_callback(
    ref_con: *mut c_void,
    _flags: *mut u32,
    _timestamp: *const AudioTimeStamp,
    _bus: u32,
    num_frames: u32,
    io_data: *mut AudioBufferList,
) -> OSStatus {
    if ref_con.is_null() || io_data.is_null() {
        return 0;
    }
    let ctx = unsafe { &*(ref_con as *const Ctx) };
    let abl = unsafe { &mut *io_data };
    if abl.mNumberBuffers == 0 {
        return 0;
    }
    let out_ptr = abl.mBuffers[0].mData as *mut f32;
    let frames = num_frames as usize;
    if out_ptr.is_null() {
        return 0;
    }
    let out = unsafe { std::slice::from_raw_parts_mut(out_ptr, frames) };

    // Up-sample from 24 kHz ring to device rate using a fractional
    // accumulator. `ratio` = device_rate / 24k (e.g. 2.0 for 48k).
    // For each output frame `i`, the source position is:
    //   src_pos = phase + i / ratio
    // where `phase` carries the fractional remainder from the previous
    // callback so we never accumulate rounding drift.
    let ratio = ctx.device_rate / TTS_SAMPLE_RATE; // e.g. 2.0

    let mut ring = ctx.output_ring.lock().unwrap();
    let mut phase = ctx.output_phase.lock().unwrap();
    let ring_len = ring.len();

    let mut silence_frames: usize = 0;
    let mut drain_count: usize = 0;

    if ring_len == 0 {
        // No source audio — emit silence and reset phase.
        for s in out.iter_mut() {
            *s = 0.0;
        }
        *phase = 0.0;
        silence_frames = frames;
    } else {
        // Linear interpolation: read directly from the VecDeque (O(1)
        // index access) so we avoid copying into a temporary Vec.
        //
        // Track how many output frames actually had source data vs.
        // silence (ring exhausted mid-callback). When the ring runs
        // out, we stop advancing the phase — otherwise the phase
        // drifts past the ring and the next pushed samples are skipped.
        let mut last_valid_src: Option<usize> = None;
        for i in 0..frames {
            let src_pos = *phase + (i as f64) / ratio;
            let idx = src_pos as usize;
            if idx + 1 < ring_len {
                let frac = (src_pos - idx as f64) as f32;
                let a = ring[idx];
                let b = ring[idx + 1];
                out[i] = a + (b - a) * frac;
                last_valid_src = Some(i);
            } else if idx < ring_len {
                out[i] = ring[idx];
                last_valid_src = Some(i);
            } else {
                // Ring exhausted — output silence for the rest.
                out[i] = 0.0;
                silence_frames += 1;
            }
        }

        // Advance the phase only by the output frames that actually
        // had source data. If the ring ran out mid-callback, the
        // remaining frames are silence and we must NOT advance
        // past them — doing so would cause the phase to drift ahead
        // of the ring, skipping samples on the next push.
        let valid_output_frames = match last_valid_src {
            Some(last) => last + 1,
            None => 0,
        };
        let advance = (valid_output_frames as f64) / ratio;
        let new_phase = *phase + advance;
        // Drain only the source samples we fully consumed (integer part).
        drain_count = (new_phase.floor() as usize).min(ring_len);
        ring.drain(..drain_count);
        // Carry the fractional remainder to the next callback.
        *phase = new_phase - drain_count as f64;
    }

    // Accumulate counters for the periodic status event.
    ctx.status_drained_acc.fetch_add(drain_count as u64, Ordering::Relaxed);
    ctx.status_silence_acc.fetch_add(silence_frames as u64, Ordering::Relaxed);

    // Diagnostic: emit render debug info for the first N callbacks so
    // we can verify the consumption ratio in DevTools.
    let n = ctx.render_cb_count.fetch_add(1, Ordering::Relaxed);
    if n < DIAG_CB_LIMIT {
        let evt = VpioRenderDebug {
            cb_index: n,
            frames_produced: num_frames,
            ring_consumed: drain_count,
            ring_size_after: ring.len(),
            phase_after: *phase,
            ratio,
            consumption_ratio: drain_count as f64 / frames as f64,
        };
        if let Ok(mut q) = ctx.render_debug_queue.try_lock() {
            q.push(evt);
        }
    }

    // Periodic status event (~200ms) for the first STATUS_EVENT_LIMIT events.
    // NOTE: `n` is the pre-increment value (fetch_add returns old). Use
    // `n + 1` so the first status event correctly reports 1 instead of 0
    // — avoids the misleading "render_cb_count: 0 => never fired" reading.
    if n % STATUS_INTERVAL_CBS == 0 {
        let emitted = ctx.status_events_emitted.fetch_add(1, Ordering::Relaxed);
        if emitted < STATUS_EVENT_LIMIT {
            let drained = ctx.status_drained_acc.swap(0, Ordering::Relaxed);
            let silence = ctx.status_silence_acc.swap(0, Ordering::Relaxed);
            let evt = VpioPlaybackStatus {
                ring_size_samples: ring.len(),
                drained_samples_last_window: drained,
                silence_output_samples_last_window: silence,
                output_phase: *phase,
                render_cb_count: n + 1,
            };
            if let Ok(mut q) = ctx.status_queue.try_lock() {
                q.push(evt);
            }
        }
    }

    drop(ring);
    drop(phase);

    // Mirror the rendered samples to the frontend so the JS analyser
    // that drives the avatar's mouth sees audio at playback time, in
    // step with the speaker. We still emit during silence (zero chunks)
    // so the analyser decays naturally instead of holding stale voice.
    let mut accum = ctx.playback_accum.lock().unwrap();
    accum.extend_from_slice(out);
    while accum.len() >= PLAYBACK_EMIT_SAMPLES {
        let chunk: Vec<i16> = accum
            .drain(..PLAYBACK_EMIT_SAMPLES)
            .map(|s| (s.clamp(-1.0, 1.0) * 32_767.0) as i16)
            .collect();
        let _ = ctx.app.emit("vpio-playback-chunk", chunk);
    }
    0
}

// ---------------------------------------------------------------------------
// OSStatus decoder — saves hours of debugging next time
// ---------------------------------------------------------------------------

fn os_status_name(code: OSStatus) -> &'static str {
    match code {
        0     => "noErr",
        -10875 => "kAudioUnitErr_FailedInitialization",
        -10851 => "kAudioUnitErr_InvalidProperty",
        -10877 => "kAudioUnitErr_Unauthorized",
        -10878 => "kAudioUnitErr_InvalidOfflineRender",
        -10863 => "kAudioUnitErr_FormatNotSupported",
        -10879 => "kAudioUnitErr_Initialized",
        -10876 => "kAudioUnitErr_Uninitialized",
        -10868 => "kAudioUnitErr_InvalidScope",
        -10867 => "kAudioUnitErr_InvalidElement",
        -10866 => "kAudioUnitErr_NoConnection",
        -10865 => "kAudioUnitErr_CannotDoInCurrentContext",
        -10864 => "kAudioUnitErr_InvalidPropertyValue",
        -50    => "paramErr",
        _      => "unknown",
    }
}

fn au_err(context: &str, code: OSStatus) -> String {
    format!("{context}: {code} ({name})", name = os_status_name(code))
}

// ---------------------------------------------------------------------------
// Device discovery helpers
// ---------------------------------------------------------------------------

/// Fetch the default input AudioDeviceID from the system.
unsafe fn get_default_input_device() -> Result<AudioDeviceID, String> {
    let addr = AudioObjectPropertyAddress {
        mSelector: kAudioHardwarePropertyDefaultInputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain,
    };
    let mut device_id: AudioDeviceID = 0;
    let mut size = size_of::<AudioDeviceID>() as u32;
    let s = AudioObjectGetPropertyData(
        kAudioObjectSystemObject,
        &addr,
        0,
        ptr::null(),
        &mut size,
        &mut device_id as *mut _ as *mut c_void,
    );
    if s != 0 {
        return Err(au_err("get default input device", s));
    }
    if device_id == 0 {
        return Err("no default input device available".into());
    }
    Ok(device_id)
}

/// Fetch the default output AudioDeviceID from the system.
unsafe fn get_default_output_device() -> Result<AudioDeviceID, String> {
    let addr = AudioObjectPropertyAddress {
        mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain,
    };
    let mut device_id: AudioDeviceID = 0;
    let mut size = size_of::<AudioDeviceID>() as u32;
    let s = AudioObjectGetPropertyData(
        kAudioObjectSystemObject,
        &addr,
        0,
        ptr::null(),
        &mut size,
        &mut device_id as *mut _ as *mut c_void,
    );
    if s != 0 {
        return Err(au_err("get default output device", s));
    }
    if device_id == 0 {
        return Err("no default output device available".into());
    }
    Ok(device_id)
}

/// Human-readable name for an AudioDeviceID (best-effort; returns
/// "<unknown>" if the query fails — never errors out).
unsafe fn get_device_name(device_id: AudioDeviceID) -> String {
    let addr = AudioObjectPropertyAddress {
        mSelector: kAudioObjectPropertyName,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain,
    };
    let mut cf_name: CFStringRef = ptr::null();
    let mut size = size_of::<CFStringRef>() as u32;
    let s = AudioObjectGetPropertyData(
        device_id,
        &addr,
        0,
        ptr::null(),
        &mut size,
        &mut cf_name as *mut _ as *mut c_void,
    );
    if s != 0 || cf_name.is_null() {
        return "<unknown>".into();
    }
    // Try the fast path (no allocation) first.
    let c_ptr = CFStringGetCStringPtr(cf_name, kCFStringEncodingUTF8);
    let name = if !c_ptr.is_null() {
        std::ffi::CStr::from_ptr(c_ptr)
            .to_string_lossy()
            .into_owned()
    } else {
        // Fallback: just report the device ID.
        format!("device#{device_id}")
    };
    CFRelease(cf_name as *const c_void);
    name
}

/// Query the nominal hardware sample rate of a device.
unsafe fn get_device_nominal_sample_rate(device_id: AudioDeviceID) -> Result<f64, String> {
    let addr = AudioObjectPropertyAddress {
        mSelector: kAudioDevicePropertyNominalSampleRate,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain,
    };
    let mut rate: f64 = 0.0;
    let mut size = size_of::<f64>() as u32;
    let s = AudioObjectGetPropertyData(
        device_id,
        &addr,
        0,
        ptr::null(),
        &mut size,
        &mut rate as *mut _ as *mut c_void,
    );
    if s != 0 {
        return Err(au_err("get nominal sample rate", s));
    }
    Ok(rate)
}

/// Device bind result — emitted as `vpio-bound-devices` event so the
/// frontend can confirm the correct hardware was selected.
#[derive(Serialize, Clone)]
struct VpioBoundDevices {
    input_device_id: u32,
    input_device_name: String,
    output_device_id: u32,
    output_device_name: String,
    per_element_bind: bool,
}

/// Warning payload when per-element binding fails and we fall back.
#[derive(Serialize, Clone)]
struct VpioBindWarning {
    message: String,
    original_error: i32,
    fallback_device_id: u32,
    fallback_device_name: String,
}

/// Bind the default input and output devices to the VPIO audio unit.
///
/// On macOS (unlike iOS), VPIO does NOT auto-discover devices — you must
/// set `kAudioOutputUnitProperty_CurrentDevice` before Initialize.
///
/// IMPORTANT: VPIO (like AUHAL) needs `CurrentDevice` set on **both**
/// elements when input and output are different physical devices:
///   - Element 0 (output bus) -> speaker device
///   - Element 1 (input bus)  -> microphone device
///
/// Setting it only on element 0 with the mic device can leave the input
/// path with no valid device binding, causing AudioUnitRender to return
/// zero-filled buffers.
unsafe fn bind_devices(au: AudioComponentInstance, app: &AppHandle) -> Result<(), String> {
    let input_id = get_default_input_device()?;
    let input_name = get_device_name(input_id);
    log::info!("[vpio] binding input device: {input_name} (id={input_id})");

    let output_id = get_default_output_device()?;
    let output_name = get_device_name(output_id);
    log::info!("[vpio] binding output device: {output_name} (id={output_id})");

    // Bind element 0 (output/speaker bus) to the output device.
    let s = AudioUnitSetProperty(
        au,
        kAudioOutputUnitProperty_CurrentDevice,
        kAudioUnitScope_Global,
        0, // element 0 = output bus
        &output_id as *const _ as *const c_void,
        size_of::<AudioDeviceID>() as u32,
    );
    if s != 0 {
        return Err(au_err("set CurrentDevice element 0 (output)", s));
    }

    // Bind element 1 (input/mic bus) to the input device.
    let s = AudioUnitSetProperty(
        au,
        kAudioOutputUnitProperty_CurrentDevice,
        kAudioUnitScope_Global,
        1, // element 1 = input bus
        &input_id as *const _ as *const c_void,
        size_of::<AudioDeviceID>() as u32,
    );
    let per_element_ok = s == 0;
    if !per_element_ok {
        // Some VPIO builds accept only a single device for both buses.
        // Fall back to binding both buses to the input device (mic).
        // WARNING: this means the output bus is bound to the mic device,
        // which has NO speaker capability — the render callback will fire
        // but produce audio to nowhere (no AEC reference, no user-audible
        // output). TTS still plays through Web Audio but without AEC.
        log::warn!(
            "[vpio] per-element device binding failed ({s} = {}), \
             falling back to single device (input on both buses) — \
             render callback will NOT produce audible output",
            os_status_name(s),
        );
        let _ = app.emit("vpio-bind-warning", VpioBindWarning {
            message: format!(
                "Per-element device binding failed (error {s} = {}). \
                 Fell back to input device on both buses — VPIO output \
                 will NOT produce audible audio. TTS routes through Web Audio.",
                os_status_name(s),
            ),
            original_error: s,
            fallback_device_id: input_id,
            fallback_device_name: input_name.clone(),
        });
        let s2 = AudioUnitSetProperty(
            au,
            kAudioOutputUnitProperty_CurrentDevice,
            kAudioUnitScope_Global,
            0,
            &input_id as *const _ as *const c_void,
            size_of::<AudioDeviceID>() as u32,
        );
        if s2 != 0 {
            return Err(au_err("set CurrentDevice fallback (input on 0)", s2));
        }
    }

    // Emit bound-devices event so the frontend can confirm which HW was used.
    let _ = app.emit("vpio-bound-devices", VpioBoundDevices {
        input_device_id: input_id,
        input_device_name: input_name,
        output_device_id: if per_element_ok { output_id } else { input_id },
        output_device_name: if per_element_ok { output_name } else { "<fallback: input device>".into() },
        per_element_bind: per_element_ok,
    });

    Ok(())
}

/// Query the stream format that VPIO has negotiated for a given scope/element
/// after device binding. Useful for diagnosing format mismatches.
unsafe fn get_format(
    au: AudioComponentInstance,
    scope: u32,
    element: u32,
) -> Result<AudioStreamBasicDescription, String> {
    let mut fmt: AudioStreamBasicDescription = std::mem::zeroed();
    let mut size = size_of::<AudioStreamBasicDescription>() as u32;
    let s = AudioUnitGetProperty(
        au,
        kAudioUnitProperty_StreamFormat,
        scope,
        element,
        &mut fmt as *mut _ as *mut c_void,
        &mut size,
    );
    if s != 0 {
        return Err(au_err(&format!("get_format({scope},{element})"), s));
    }
    Ok(fmt)
}

/// Convert an ASBD into the serialisable debug struct.
fn fmt_to_debug(label: &str, f: &AudioStreamBasicDescription) -> VpioDebugFormat {
    const NON_INTERLEAVED: u32 = 32; // kAudioFormatFlagIsNonInterleaved
    VpioDebugFormat {
        label: label.to_string(),
        sample_rate: f.mSampleRate,
        channels_per_frame: f.mChannelsPerFrame,
        bytes_per_frame: f.mBytesPerFrame,
        format_flags: f.mFormatFlags,
        bits_per_channel: f.mBitsPerChannel,
        bytes_per_packet: f.mBytesPerPacket,
        frames_per_packet: f.mFramesPerPacket,
        is_non_interleaved: (f.mFormatFlags & NON_INTERLEAVED) != 0,
    }
}

// ---------------------------------------------------------------------------
// AudioUnit setup
// ---------------------------------------------------------------------------

fn make_pcm_format(sample_rate: f64, channels: u32) -> AudioStreamBasicDescription {
    let ch = channels.max(1);
    AudioStreamBasicDescription {
        mSampleRate: sample_rate,
        mFormatID: kAudioFormatLinearPCM,
        mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
        mBytesPerPacket: 4 * ch,
        mFramesPerPacket: 1,
        mBytesPerFrame: 4 * ch,
        mChannelsPerFrame: ch,
        mBitsPerChannel: 32,
        mReserved: 0,
    }
}

unsafe fn create_vpio() -> Result<AudioComponentInstance, String> {
    let desc = AudioComponentDescription {
        componentType: kAudioUnitType_Output,
        componentSubType: kAudioUnitSubType_VoiceProcessingIO,
        componentManufacturer: kAudioUnitManufacturer_Apple,
        componentFlags: 0,
        componentFlagsMask: 0,
    };
    let comp = AudioComponentFindNext(ptr::null_mut(), &desc);
    if comp.is_null() {
        return Err("VoiceProcessingIO component not found".into());
    }
    let mut au: AudioComponentInstance = ptr::null_mut();
    let status = AudioComponentInstanceNew(comp, &mut au);
    if status != 0 || au.is_null() {
        return Err(au_err("AudioComponentInstanceNew", status));
    }
    Ok(au)
}

unsafe fn set_u32(
    au: AudioComponentInstance,
    prop: u32,
    scope: u32,
    element: u32,
    value: u32,
) -> Result<(), String> {
    let v: u32 = value;
    let status = AudioUnitSetProperty(
        au,
        prop,
        scope,
        element,
        &v as *const _ as *const c_void,
        size_of::<u32>() as u32,
    );
    if status != 0 {
        return Err(au_err(&format!("AudioUnitSetProperty({prop},{scope},{element})"), status));
    }
    Ok(())
}

unsafe fn set_format(
    au: AudioComponentInstance,
    scope: u32,
    element: u32,
    format: &AudioStreamBasicDescription,
) -> Result<(), String> {
    let status = AudioUnitSetProperty(
        au,
        kAudioUnitProperty_StreamFormat,
        scope,
        element,
        format as *const _ as *const c_void,
        size_of::<AudioStreamBasicDescription>() as u32,
    );
    if status != 0 {
        return Err(au_err(&format!("set_format({scope},{element})"), status));
    }
    Ok(())
}

unsafe fn set_callback(
    au: AudioComponentInstance,
    prop: u32,
    scope: u32,
    element: u32,
    cb: unsafe extern "C" fn(
        *mut c_void,
        *mut u32,
        *const AudioTimeStamp,
        u32,
        u32,
        *mut AudioBufferList,
    ) -> OSStatus,
    ref_con: *mut c_void,
) -> Result<(), String> {
    let s = AURenderCallbackStruct {
        inputProc: Some(cb),
        inputProcRefCon: ref_con,
    };
    let status = AudioUnitSetProperty(
        au,
        prop,
        scope,
        element,
        &s as *const _ as *const c_void,
        size_of::<AURenderCallbackStruct>() as u32,
    );
    if status != 0 {
        return Err(au_err(&format!("set_callback({prop},{scope},{element})"), status));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Debug poller thread
// ---------------------------------------------------------------------------

/// Spawns a thread that polls the debug queue every 100ms and emits
/// Tauri events. Stops when `ctx.alive` is set to false.
fn spawn_debug_poller(ctx: Arc<Ctx>) {
    std::thread::Builder::new()
        .name("vpio-debug-poller".into())
        .spawn(move || {
            while ctx.alive.load(Ordering::Relaxed) {
                std::thread::sleep(std::time::Duration::from_millis(100));
                // Drain input-callback debug events.
                let events: Vec<VpioDebugCb> = {
                    if let Ok(mut q) = ctx.debug_queue.try_lock() {
                        q.drain(..).collect()
                    } else {
                        vec![]
                    }
                };
                for evt in &events {
                    let _ = ctx.app.emit("vpio-debug", evt);
                }
                // Drain render-callback debug events.
                let render_events: Vec<VpioRenderDebug> = {
                    if let Ok(mut q) = ctx.render_debug_queue.try_lock() {
                        q.drain(..).collect()
                    } else {
                        vec![]
                    }
                };
                for evt in &render_events {
                    let _ = ctx.app.emit("vpio-render-debug", evt);
                }
                // Drain periodic status events.
                let status_events: Vec<VpioPlaybackStatus> = {
                    if let Ok(mut q) = ctx.status_queue.try_lock() {
                        q.drain(..).collect()
                    } else {
                        vec![]
                    }
                };
                for evt in &status_events {
                    let _ = ctx.app.emit("vpio-playback-status", evt);
                }
            }
        })
        .ok();
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn vpio_start(app: AppHandle, state: State<'_, VoiceIoState>) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Ok(()); // already running
    }

    unsafe {
        let au = create_vpio()?;

        // Enable input (bus 1) and output (bus 0).
        set_u32(au, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, 1, 1)?;
        set_u32(au, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, 0, 1)?;

        // Bind the hardware devices BEFORE Initialize. On macOS (unlike
        // iOS), VPIO does NOT auto-discover the default devices.
        bind_devices(au, &app)?;

        // Query the device's nominal sample rate so we can set client
        // formats at the right rate. macOS VPIO refuses to initialize if
        // the client-facing format rate differs from the device rate.
        let input_id = get_default_input_device()?;
        let device_rate = get_device_nominal_sample_rate(input_id).unwrap_or(48_000.0);
        log::info!("[vpio] device nominal sample rate: {device_rate} Hz");

        // --- Set client-side formats at the device rate ---
        //
        // Bus 1 output scope = what we *read* from VPIO (device rate).
        // Request mono; VPIO may override to multi-channel after init.
        let mic_fmt = make_pcm_format(device_rate, 1);
        set_format(au, kAudioUnitScope_Output, 1, &mic_fmt)?;

        // Bus 0 input scope = what we *feed* to VPIO (device rate, mono).
        let spk_fmt = make_pcm_format(device_rate, 1);
        set_format(au, kAudioUnitScope_Input, 0, &spk_fmt)?;

        // Tell VPIO we will provide our own buffer for the input callback.
        // ShouldAllocateBuffer = 0 on output scope bus 1 means we supply
        // the ABL to AudioUnitRender. This is the safest mode because we
        // control the layout and channel count of the buffer.
        set_u32(au, kAudioUnitProperty_ShouldAllocateBuffer, kAudioUnitScope_Output, 1, 0)?;

        // Initialize the audio unit. This finalises the negotiated format.
        let s = AudioUnitInitialize(au);
        if s != 0 {
            AudioComponentInstanceDispose(au);
            return Err(au_err("AudioUnitInitialize", s));
        }
        log::info!("[vpio] AudioUnitInitialize succeeded");

        // Disable system-wide audio ducking. VPIO by default tells macOS
        // to reduce the volume of all other apps (same as a phone call).
        // Property 3601 = kAudioUnitProperty_VoiceProcessingOtherAudioDucking
        // (macOS 14+). Value 0 = no ducking.
        const VPIO_OTHER_AUDIO_DUCKING: u32 = 3601;
        if let Err(e) = set_u32(au, VPIO_OTHER_AUDIO_DUCKING, kAudioUnitScope_Global, 0, 0) {
            log::warn!("[vpio] failed to disable other-audio ducking (macOS <14?): {e}");
        }

        // Query the ACTUAL negotiated formats after init. VPIO may have
        // overridden our mono request to match the hardware.
        let mut negotiated_channels: u32 = 1;
        let mut negotiated_bytes_per_frame: u32 = 4;
        let mut negotiated_non_interleaved = false;
        const NON_INTERLEAVED_FLAG: u32 = 32;

        // Collect format info for the debug event.
        let mut format_events: Vec<VpioDebugFormat> = Vec::new();

        if let Ok(f) = get_format(au, kAudioUnitScope_Input, 1) {
            log::info!("[vpio] bus 1 input  (hw->VPIO): {:.0} Hz, {} ch, {} bytes/frame, flags=0x{:X}",
                f.mSampleRate, f.mChannelsPerFrame, f.mBytesPerFrame, f.mFormatFlags);
            format_events.push(fmt_to_debug("bus1_input_hw_to_vpio", &f));
        }
        if let Ok(f) = get_format(au, kAudioUnitScope_Output, 1) {
            log::info!("[vpio] bus 1 output (VPIO->us): {:.0} Hz, {} ch, {} bytes/frame, flags=0x{:X}",
                f.mSampleRate, f.mChannelsPerFrame, f.mBytesPerFrame, f.mFormatFlags);
            format_events.push(fmt_to_debug("bus1_output_vpio_to_us", &f));
            // This is the format we must match in our ABL for AudioUnitRender.
            negotiated_channels = f.mChannelsPerFrame;
            negotiated_bytes_per_frame = f.mBytesPerFrame;
            negotiated_non_interleaved = (f.mFormatFlags & NON_INTERLEAVED_FLAG) != 0;
        }
        if let Ok(f) = get_format(au, kAudioUnitScope_Input, 0) {
            log::info!("[vpio] bus 0 input  (us->VPIO): {:.0} Hz, {} ch, {} bytes/frame, flags=0x{:X}",
                f.mSampleRate, f.mChannelsPerFrame, f.mBytesPerFrame, f.mFormatFlags);
            format_events.push(fmt_to_debug("bus0_input_us_to_vpio", &f));
        }
        if let Ok(f) = get_format(au, kAudioUnitScope_Output, 0) {
            log::info!("[vpio] bus 0 output (VPIO->spk): {:.0} Hz, {} ch, {} bytes/frame, flags=0x{:X}",
                f.mSampleRate, f.mChannelsPerFrame, f.mBytesPerFrame, f.mFormatFlags);
            format_events.push(fmt_to_debug("bus0_output_vpio_to_spk", &f));
        }

        // Emit negotiated formats as a Tauri event so they show up in
        // DevTools (log::info only goes to stderr, invisible to the user).
        let _ = app.emit("vpio-debug-formats", &format_events);

        log::info!(
            "[vpio] negotiated: channels={negotiated_channels} bytes_per_frame={negotiated_bytes_per_frame} \
             non_interleaved={negotiated_non_interleaved}"
        );

        // If VPIO overrode our mono request, log a prominent warning.
        if negotiated_channels > 1 {
            log::warn!(
                "[vpio] VPIO negotiated {negotiated_channels} channels instead of 1 — \
                 input callback will handle multi-channel ABL"
            );
        }

        // Allocate context and get a stable raw pointer for the callbacks.
        let ctx = Arc::new(Ctx {
            au,
            output_ring: Mutex::new(VecDeque::with_capacity(OUTPUT_RING_MAX)),
            output_phase: Mutex::new(0.0),
            mic_accum: Mutex::new(Vec::with_capacity(MIC_EMIT_SAMPLES * 2)),
            playback_accum: Mutex::new(Vec::with_capacity(PLAYBACK_EMIT_SAMPLES * 2)),
            app,
            device_rate,
            input_cb_count: AtomicU64::new(0),
            render_cb_count: AtomicU64::new(0),
            debug_queue: Mutex::new(Vec::with_capacity(DIAG_CB_LIMIT as usize)),
            render_debug_queue: Mutex::new(Vec::with_capacity(DIAG_CB_LIMIT as usize)),
            status_queue: Mutex::new(Vec::with_capacity(STATUS_EVENT_LIMIT as usize)),
            status_events_emitted: AtomicU64::new(0),
            status_drained_acc: AtomicU64::new(0),
            status_silence_acc: AtomicU64::new(0),
            alive: AtomicBool::new(true),
            negotiated_channels,
            negotiated_bytes_per_frame,
            negotiated_non_interleaved,
            // Pre-size scratch buffers for the typical 48 kHz / 512-frame
            // callback so the first call doesn't need to grow either Vec.
            cb_buf: Mutex::new(Vec::with_capacity(2048)),
            cb_extra_bufs: Mutex::new(Vec::new()),
            cb_abl_dyn: Mutex::new(Vec::with_capacity(8)),
        });
        let ref_con = Arc::as_ptr(&ctx) as *mut c_void;

        // Input + render callback registration. On any failure we must
        // tear down the audio unit and drop the Arc so we don't leak
        // CoreAudio resources or the spawned poller (which we delay until
        // after Start succeeds, see below).
        let cb_result: Result<(), String> = (|| {
            // Input callback — register on element 0. For VPIO (unlike
            // raw AUHAL), the SetInputCallback property always fires for
            // bus 1 (mic) regardless of which element you register on.
            // Apple's aurioTouch sample registers on element 0.
            set_callback(
                au,
                kAudioOutputUnitProperty_SetInputCallback,
                kAudioUnitScope_Global,
                0,
                input_callback,
                ref_con,
            )?;
            set_callback(
                au,
                kAudioUnitProperty_SetRenderCallback,
                kAudioUnitScope_Input,
                0,
                render_callback,
                ref_con,
            )?;
            Ok(())
        })();
        if let Err(e) = cb_result {
            // Stop is a no-op since the unit was never started, but it
            // returns an error code we ignore — the failure path here
            // is "set_callback rejected our setup", not a started unit.
            ctx.alive.store(false, Ordering::Relaxed);
            let _ = AudioOutputUnitStop(au);
            let _ = AudioUnitUninitialize(au);
            AudioComponentInstanceDispose(au);
            // Drop the Arc explicitly so the Ctx is freed before we
            // return — no callbacks ever fired so the raw `ref_con`
            // pointer is no longer aliased.
            drop(ctx);
            return Err(e);
        }

        let s = AudioOutputUnitStart(au);
        if s != 0 {
            ctx.alive.store(false, Ordering::Relaxed);
            let _ = AudioUnitUninitialize(au);
            AudioComponentInstanceDispose(au);
            drop(ctx);
            return Err(au_err("AudioOutputUnitStart", s));
        }
        log::info!("[vpio] AudioOutputUnitStart succeeded — AEC + NS + AGC active");

        // Spawn the debug poller AFTER Start succeeds so failure paths
        // never leak a thread observing a half-built context.
        spawn_debug_poller(Arc::clone(&ctx));

        *guard = Some(ctx);
    }
    Ok(())
}

#[tauri::command]
pub fn vpio_stop(state: State<'_, VoiceIoState>) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    let Some(ctx) = guard.take() else {
        return Ok(());
    };
    // Signal the debug poller to exit.
    ctx.alive.store(false, Ordering::Relaxed);
    unsafe {
        let s = AudioOutputUnitStop(ctx.au);
        if s != 0 {
            log::warn!("[vpio] AudioOutputUnitStop failed: {s:#x}");
        }
        let s = AudioUnitUninitialize(ctx.au);
        if s != 0 {
            log::warn!("[vpio] AudioUnitUninitialize failed: {s:#x}");
        }
        // Defense-in-depth before AudioComponentInstanceDispose. The
        // raw `ref_con` pointer aliases the `Arc<Ctx>` interior, and
        // CoreAudio's contract is "after Stop+Uninitialize the
        // callbacks no longer fire" — but in practice we've seen
        // race-y edge cases where one in-flight callback can still
        // be running on the audio thread when Dispose is invoked
        // from the main thread. The fence flushes any prior writes
        // (`alive.store(false)`, etc.) so the audio thread sees a
        // consistent view, and the brief sleep gives an in-flight
        // callback time to drain. This is NOT the full mitigation
        // for the Arc::as_ptr lifetime architecture issue (tracked
        // separately) — just a guardrail until that lands.
        std::sync::atomic::fence(std::sync::atomic::Ordering::SeqCst);
        std::thread::sleep(std::time::Duration::from_millis(20));
        AudioComponentInstanceDispose(ctx.au);
    }
    // Dropping the Arc here releases the context now that both callbacks
    // have stopped firing.
    drop(ctx);
    Ok(())
}

/// Queue an s16le 24 kHz mono PCM chunk for playback through VPIO.
/// Chunks are appended to an internal ring; the render callback drains
/// it. Overflow (ring > 2 s) drops the oldest audio rather than blocking
/// so callers never stall.
#[tauri::command]
pub fn vpio_play_chunk(
    pcm: Vec<u8>,
    state: State<'_, VoiceIoState>,
) -> Result<(), String> {
    if pcm.len() < 2 {
        return Ok(());
    }
    let guard = state.inner.lock().map_err(|e| e.to_string())?;
    let Some(ctx) = guard.as_ref() else {
        return Err("VPIO not running".into());
    };
    let sample_count = pcm.len() / 2;
    let mut ring = ctx.output_ring.lock().map_err(|e| e.to_string())?;
    // Drop oldest if we'd exceed the cap — prevents unbounded growth if
    // the UI pushes faster than the device consumes.
    let overflow = ring.len() + sample_count;
    if overflow > OUTPUT_RING_MAX {
        let drop = overflow - OUTPUT_RING_MAX;
        for _ in 0..drop {
            ring.pop_front();
        }
    }
    for chunk in pcm.chunks_exact(2) {
        let s = i16::from_le_bytes([chunk[0], chunk[1]]);
        ring.push_back(s as f32 / 32_768.0);
    }
    Ok(())
}

/// Drop every queued sample immediately (barge-in).
#[tauri::command]
pub fn vpio_flush_output(state: State<'_, VoiceIoState>) -> Result<(), String> {
    let guard = state.inner.lock().map_err(|e| e.to_string())?;
    if let Some(ctx) = guard.as_ref() {
        ctx.output_ring.lock().map_err(|e| e.to_string())?.clear();
        // Reset the fractional phase so the next chunk starts clean.
        *ctx.output_phase.lock().map_err(|e| e.to_string())? = 0.0;
    }
    Ok(())
}

/// Return the current number of samples in the output ring.
/// Used by the frontend `flush()` to poll until the ring drains before
/// transitioning state on `turn_end`.
#[tauri::command]
pub fn vpio_ring_len(state: State<'_, VoiceIoState>) -> Result<usize, String> {
    let guard = state.inner.lock().map_err(|e| e.to_string())?;
    if let Some(ctx) = guard.as_ref() {
        let ring = ctx.output_ring.lock().map_err(|e| e.to_string())?;
        Ok(ring.len())
    } else {
        Ok(0)
    }
}
}
#[cfg(target_os = "macos")]
pub use imp::*;
