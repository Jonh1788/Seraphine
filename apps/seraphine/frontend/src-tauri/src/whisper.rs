//! Embedded Whisper STT via whisper.cpp (whisper-rs) with Metal.
//!
//! Shipped inside the Seraphine Tauri app so STT works on a signed
//! release build without any backend process — same idea MacWhisper
//! uses. Apple Silicon runs the ggml model through Metal and hits
//! near-MLX speeds (~150-250 ms for a 5 s utterance on an M4 Max with
//! the q5_1 small model).
//!
//! First use on a machine downloads the model file to the user's
//! Caches directory (~/Library/Caches/seraphine/models/…) so the app
//! binary itself stays ~10 MB of native code. Subsequent runs load
//! the cached file lazily; the `WhisperContext` is held in a static
//! `OnceLock` so the model only warms up once per process.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Instant;

use whisper_rs::{
    FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters,
};

// ---------------------------------------------------------------------------
// Model registry
// ---------------------------------------------------------------------------

/// Small quantised multilingual model. 150 MB, good PT-BR, fast.
const DEFAULT_MODEL_ID: &str = "ggml-small-q5_1";
const MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin";

// ---------------------------------------------------------------------------
// Lazy-initialised singleton — load the context once per process.
// ---------------------------------------------------------------------------

static WHISPER_CTX: OnceLock<WhisperContext> = OnceLock::new();

fn cache_dir() -> Result<PathBuf, String> {
    let base = dirs::cache_dir()
        .ok_or_else(|| "no cache dir available".to_string())?;
    let dir = base.join("seraphine").join("models");
    fs::create_dir_all(&dir)
        .map_err(|e| format!("create cache dir {}: {e}", dir.display()))?;
    Ok(dir)
}

fn model_path(model_id: &str) -> Result<PathBuf, String> {
    Ok(cache_dir()?.join(format!("{model_id}.bin")))
}

fn download_model(model_id: &str) -> Result<PathBuf, String> {
    let target = model_path(model_id)?;
    if target.exists() && fs::metadata(&target).map(|m| m.len()).unwrap_or(0) > 0 {
        return Ok(target);
    }
    // Blocking download via ureq — keeps the Rust side dependency-light.
    // If the model id isn't the default we'd need a URL map; this function
    // is intentionally scoped to the single default model for now.
    if model_id != DEFAULT_MODEL_ID {
        return Err(format!("unknown model id: {model_id}"));
    }

    let tmp = target.with_extension("bin.partial");
    // Use reqwest/ureq lazily without adding a dep — fall back to `curl`.
    let status = std::process::Command::new("curl")
        .args([
            "-L",
            "--fail",
            "--silent",
            "--show-error",
            "-o",
        ])
        .arg(&tmp)
        .arg(MODEL_URL)
        .status()
        .map_err(|e| format!("curl spawn: {e}"))?;
    if !status.success() {
        let _ = fs::remove_file(&tmp);
        return Err(format!("curl exited {status}"));
    }
    fs::rename(&tmp, &target).map_err(|e| format!("rename: {e}"))?;
    Ok(target)
}

fn ensure_ctx(model_id: &str) -> Result<&'static WhisperContext, String> {
    if let Some(ctx) = WHISPER_CTX.get() {
        return Ok(ctx);
    }
    let path = download_model(model_id)?;
    let path_str = path
        .to_str()
        .ok_or_else(|| "non-utf8 model path".to_string())?;
    let ctx = WhisperContext::new_with_params(
        path_str,
        WhisperContextParameters::default(),
    )
    .map_err(|e| format!("whisper load: {e}"))?;
    let _ = WHISPER_CTX.set(ctx);
    WHISPER_CTX
        .get()
        .ok_or_else(|| "whisper ctx race".to_string())
}

// ---------------------------------------------------------------------------
// Transcription
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhisperStatus {
    pub ready: bool,
    pub model_id: String,
    pub model_path: String,
    pub model_present: bool,
    pub model_size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhisperTranscription {
    pub text: String,
    pub duration_s: f64,
    pub language: String,
}

async fn blocking<F, T>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("blocking task join: {e}"))?
}

/// Reports whether the default model is downloaded and (optionally) loaded.
#[tauri::command]
pub async fn whisper_status() -> Result<WhisperStatus, String> {
    blocking(|| {
        let path = model_path(DEFAULT_MODEL_ID)?;
        let (present, size) = match fs::metadata(&path) {
            Ok(m) => (true, m.len()),
            Err(_) => (false, 0u64),
        };
        Ok(WhisperStatus {
            ready: WHISPER_CTX.get().is_some(),
            model_id: DEFAULT_MODEL_ID.to_string(),
            model_path: path.to_string_lossy().into_owned(),
            model_present: present,
            model_size_bytes: size,
        })
    })
    .await
}

/// Kicks off model download (if not cached) and warms the context.
/// Idempotent — safe to call on every app launch.
#[tauri::command]
pub async fn whisper_prepare() -> Result<WhisperStatus, String> {
    blocking(|| {
        ensure_ctx(DEFAULT_MODEL_ID)?;
        let path = model_path(DEFAULT_MODEL_ID)?;
        let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        Ok(WhisperStatus {
            ready: true,
            model_id: DEFAULT_MODEL_ID.to_string(),
            model_path: path.to_string_lossy().into_owned(),
            model_present: true,
            model_size_bytes: size,
        })
    })
    .await
}

/// Transcribe a batch of s16le mono PCM. `sample_rate` must be 16000 —
/// the frontend's cpal pipeline already resamples to that.
#[tauri::command]
pub async fn whisper_transcribe_pcm(
    pcm: Vec<u8>,
    sample_rate: i32,
    language: Option<String>,
) -> Result<WhisperTranscription, String> {
    if pcm.len() < 2 {
        return Err("pcm payload is empty".to_string());
    }
    if sample_rate != 16000 {
        return Err(format!(
            "only 16 kHz PCM is supported — got {sample_rate}"
        ));
    }
    let lang = language.unwrap_or_else(|| "pt".to_string());

    blocking(move || {
        let ctx = ensure_ctx(DEFAULT_MODEL_ID)?;
        let mut state = ctx
            .create_state()
            .map_err(|e| format!("whisper state: {e}"))?;

        // i16 LE → f32 mono normalized to [-1, 1].
        let sample_count = pcm.len() / 2;
        let mut samples = Vec::with_capacity(sample_count);
        for chunk in pcm.chunks_exact(2) {
            let s = i16::from_le_bytes([chunk[0], chunk[1]]);
            samples.push(f32::from(s) / 32768.0);
        }

        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(Some(lang.as_str()));
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_special(false);
        params.set_print_timestamps(false);
        params.set_n_threads(4);
        params.set_suppress_blank(true);

        let start = Instant::now();
        state
            .full(params, &samples)
            .map_err(|e| format!("whisper full: {e}"))?;
        let elapsed = start.elapsed().as_secs_f64();

        // Concatenate all segments into one final transcript.
        let segments = state
            .full_n_segments()
            .map_err(|e| format!("segment count: {e}"))?;
        let mut text = String::new();
        for i in 0..segments {
            let seg = state
                .full_get_segment_text(i)
                .map_err(|e| format!("segment text: {e}"))?;
            text.push_str(&seg);
        }
        Ok(WhisperTranscription {
            text: text.trim().to_string(),
            duration_s: elapsed,
            language: lang,
        })
    })
    .await
}
