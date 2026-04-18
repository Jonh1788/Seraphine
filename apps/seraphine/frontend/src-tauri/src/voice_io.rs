//! Apple VoiceProcessingIO audio unit — AEC + noise suppression + AGC.
//!
//! Used by the realtime voice path instead of cpal when we need echo
//! cancellation (user without headphones). The same AEC FaceTime, Siri,
//! and Zoom use on Apple devices; nothing to install, nothing to tune
//! — CoreAudio does the room calibration.
//!
//! Wiring:
//!   • Input bus 1 → AEC-cleaned mic @ 16 kHz Float32 mono. Emitted to
//!     the frontend as `mic-pcm-chunk` events (same format as mic.rs)
//!     so tauriVad can consume it unchanged.
//!   • Output bus 0 → PCM from TTS. We accept 24 kHz s16le chunks (the
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
}
#[cfg(not(target_os = "macos"))]
pub use stubs::*;

#[cfg(target_os = "macos")]
mod imp {

use std::collections::VecDeque;
use std::ffi::c_void;
use std::mem::size_of;
use std::ptr;
use std::sync::{Arc, Mutex};

use coreaudio_sys::{
    kAudioFormatFlagIsFloat, kAudioFormatFlagIsPacked, kAudioFormatLinearPCM,
    kAudioOutputUnitProperty_EnableIO, kAudioOutputUnitProperty_SetInputCallback,
    kAudioUnitManufacturer_Apple, kAudioUnitProperty_SetRenderCallback,
    kAudioUnitProperty_StreamFormat, kAudioUnitScope_Global, kAudioUnitScope_Input,
    kAudioUnitScope_Output, kAudioUnitSubType_VoiceProcessingIO, kAudioUnitType_Output,
    AURenderCallbackStruct, AudioBuffer, AudioBufferList, AudioComponentDescription,
    AudioComponentFindNext, AudioComponentInstance, AudioComponentInstanceDispose,
    AudioComponentInstanceNew, AudioOutputUnitStart, AudioOutputUnitStop,
    AudioStreamBasicDescription, AudioTimeStamp, AudioUnitInitialize, AudioUnitRender,
    AudioUnitSetProperty, AudioUnitUninitialize, OSStatus,
};
use tauri::{AppHandle, Emitter, State};

// Native I/O rates. VPIO re-samples internally to its AEC rate.
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
// Output ring: keep ~2 seconds of TTS buffered so brief scheduler jitter
// never starves the render callback. We drop oldest audio if overfilled.
const OUTPUT_RING_MAX: usize = 24_000 * 2;

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

struct Ctx {
    au: AudioComponentInstance,
    output_ring: Mutex<VecDeque<f32>>,
    mic_accum: Mutex<Vec<f32>>,
    /// Samples just handed to the audio device; emitted in fixed chunks
    /// to the frontend so the avatar's JS lipsync analyser sees audio
    /// at actual playback time rather than WS arrival time.
    playback_accum: Mutex<Vec<f32>>,
    app: AppHandle,
}

// Safety: we hand a `*mut c_void` to the audio unit callbacks. The
// callbacks only touch `output_ring`, `mic_accum`, `app` (all internally
// thread-safe) and the raw `au` pointer (only for AudioUnitRender). No
// &mut aliasing.
unsafe impl Send for Ctx {}
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

/// Input callback — VPIO tells us "there are N AEC'd mic frames ready".
/// We pull them with `AudioUnitRender` into our own buffer, accumulate,
/// emit to the frontend every `MIC_EMIT_SAMPLES` (100 ms @ 16 kHz).
unsafe extern "C" fn input_callback(
    ref_con: *mut c_void,
    flags: *mut u32,
    timestamp: *const AudioTimeStamp,
    _bus: u32,
    num_frames: u32,
    _io_data: *mut AudioBufferList,
) -> OSStatus {
    if ref_con.is_null() {
        return 0;
    }
    let ctx = unsafe { &*(ref_con as *const Ctx) };

    // Pull mic audio into a locally-allocated buffer.
    let frames = num_frames as usize;
    let mut buf: Vec<f32> = vec![0.0; frames];
    let mut abl = AudioBufferList {
        mNumberBuffers: 1,
        mBuffers: [AudioBuffer {
            mNumberChannels: 1,
            mDataByteSize: (frames * size_of::<f32>()) as u32,
            mData: buf.as_mut_ptr() as *mut c_void,
        }],
    };

    let status = unsafe {
        AudioUnitRender(ctx.au, flags, timestamp, 1, num_frames, &mut abl)
    };
    if status != 0 {
        return status;
    }

    // Accumulate and emit fixed-size chunks.
    let mut accum = ctx.mic_accum.lock().unwrap();
    accum.extend_from_slice(&buf);
    while accum.len() >= MIC_EMIT_SAMPLES {
        let chunk: Vec<i16> = accum
            .drain(..MIC_EMIT_SAMPLES)
            .map(|s| (s.clamp(-1.0, 1.0) * 32_767.0) as i16)
            .collect();
        let _ = ctx.app.emit("mic-pcm-chunk", chunk);
    }
    0
}

/// Render callback — VPIO wants N frames to play through the speaker.
/// We drain from `output_ring`; if empty, output silence (safe — no glitch
/// because VPIO's output is mostly quiet between utterances anyway).
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

    {
        let mut ring = ctx.output_ring.lock().unwrap();
        for s in out.iter_mut() {
            *s = ring.pop_front().unwrap_or(0.0);
        }
    }

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
// AudioUnit setup
// ---------------------------------------------------------------------------

fn make_pcm_format(sample_rate: f64) -> AudioStreamBasicDescription {
    AudioStreamBasicDescription {
        mSampleRate: sample_rate,
        mFormatID: kAudioFormatLinearPCM,
        mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
        mBytesPerPacket: 4,
        mFramesPerPacket: 1,
        mBytesPerFrame: 4,
        mChannelsPerFrame: 1,
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
        return Err(format!("AudioComponentInstanceNew: {status}"));
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
        return Err(format!("AudioUnitSetProperty({prop},{scope},{element}) → {status}"));
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
        return Err(format!("set_format({scope},{element}) → {status}"));
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
        return Err(format!("set_callback({prop},{scope},{element}) → {status}"));
    }
    Ok(())
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

        // Mic side: 16 kHz Float32 mono on the output scope of bus 1
        // (what we *read* from VPIO).
        let mic_fmt = make_pcm_format(MIC_SAMPLE_RATE);
        set_format(au, kAudioUnitScope_Output, 1, &mic_fmt)?;

        // Speaker side: 24 kHz Float32 mono on the input scope of bus 0
        // (what we *feed* to VPIO). VPIO/CoreAudio handles resampling
        // to the device's native rate.
        let spk_fmt = make_pcm_format(TTS_SAMPLE_RATE);
        set_format(au, kAudioUnitScope_Input, 0, &spk_fmt)?;

        // Allocate context and get a stable raw pointer for the callbacks.
        let ctx = Arc::new(Ctx {
            au,
            output_ring: Mutex::new(VecDeque::with_capacity(OUTPUT_RING_MAX)),
            mic_accum: Mutex::new(Vec::with_capacity(MIC_EMIT_SAMPLES * 2)),
            playback_accum: Mutex::new(Vec::with_capacity(PLAYBACK_EMIT_SAMPLES * 2)),
            app,
        });
        let ref_con = Arc::as_ptr(&ctx) as *mut c_void;

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

        let s = AudioUnitInitialize(au);
        if s != 0 {
            AudioComponentInstanceDispose(au);
            return Err(format!("AudioUnitInitialize: {s}"));
        }
        let s = AudioOutputUnitStart(au);
        if s != 0 {
            AudioUnitUninitialize(au);
            AudioComponentInstanceDispose(au);
            return Err(format!("AudioOutputUnitStart: {s}"));
        }

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
    unsafe {
        AudioOutputUnitStop(ctx.au);
        AudioUnitUninitialize(ctx.au);
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
    }
    Ok(())
}
}
#[cfg(target_os = "macos")]
pub use imp::*;
