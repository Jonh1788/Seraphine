//! Embedded Whisper STT via whisper.cpp (whisper-rs) with Metal.
//!
//! Shipped inside the Seraphine Tauri app so STT works on a signed
//! release build without any backend process — same idea MacWhisper
//! uses. Apple Silicon runs the ggml model through Metal and hits
//! near-MLX speeds (~300-600 ms for a 5 s utterance on an M4 Max with
//! the `large-v3-turbo` FP16 model).
//!
//! First use on a machine downloads the model file to the user's
//! Caches directory (~/Library/Caches/seraphine/models/…) so the app
//! binary itself stays ~10 MB of native code. Subsequent runs load
//! the cached file lazily; the `WhisperContext` is held in a static
//! `OnceLock` so the model only warms up once per process.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Instant;

use whisper_rs::{
    FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters,
};

// ---------------------------------------------------------------------------
// Model registry
// ---------------------------------------------------------------------------

/// Large-v3 turbo — 1.62 GB FP16. Near-`large-v3` accuracy (WER ~5-7%
/// em PT-BR, vs ~13% do `small`) com ~6-8x realtime no M4 Max via Metal,
/// porque tem menos camadas de decoder. Sweet spot pra uso em voz
/// realtime num laptop Apple Silicon com RAM de sobra. Cache key muda
/// pro novo filename, entao a primeira execucao re-baixa.
const DEFAULT_MODEL_ID: &str = "ggml-large-v3-turbo";
const MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin";

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

// Sanity threshold for downloaded model integrity. The default model
// (`ggml-large-v3-turbo`) is ~1.62 GB; any partial transfer will be
// orders of magnitude smaller. 100 MB is conservative — well below the
// real size, well above any plausible HTML error page that a
// misconfigured CDN might serve with HTTP 200.
const MIN_MODEL_BYTES: u64 = 100_000_000;

// Serializes concurrent `download_model` calls so two callers racing
// `ensure_ctx` don't both download the same 1.6 GB blob.
static MODEL_DOWNLOAD_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Returns `Ok(true)` if `path` exists AND its size is at least
/// `MIN_MODEL_BYTES`. Returns `Ok(false)` if the file is missing or
/// short (i.e. needs re-download). Real IO errors (permission denied,
/// truncated read after the fact) are *logged* and treated as
/// "unusable" so the caller will re-download — but we do NOT swallow
/// them silently the way `unwrap_or(0)` did.
fn cached_model_is_complete(path: &Path) -> bool {
    if !path.exists() {
        return false;
    }
    match fs::metadata(path) {
        Ok(m) => m.len() >= MIN_MODEL_BYTES,
        Err(e) => {
            log::warn!(
                "[whisper] cached model {} present but metadata failed: {e} — will re-download",
                path.display()
            );
            false
        }
    }
}

fn download_model(model_id: &str) -> Result<PathBuf, String> {
    let target = model_path(model_id)?;
    if cached_model_is_complete(&target) {
        return Ok(target);
    }
    // Blocking download via ureq — keeps the Rust side dependency-light.
    // If the model id isn't the default we'd need a URL map; this function
    // is intentionally scoped to the single default model for now.
    if model_id != DEFAULT_MODEL_ID {
        return Err(format!("unknown model id: {model_id}"));
    }

    // Hold the lock for the entire download so a second concurrent caller
    // skips the (re)download once the first finishes successfully.
    let _guard = MODEL_DOWNLOAD_LOCK.lock().map_err(|e| format!("download lock: {e}"))?;

    // Re-check after acquiring the lock — another thread may have already
    // completed the download while we were waiting.
    if cached_model_is_complete(&target) {
        return Ok(target);
    }

    let tmp = target.with_extension("bin.partial");
    // `--fail` drops 4xx/5xx; `--fail-with-body` keeps the response body
    // for diagnostics. We ignore the printed line because we validate
    // the on-disk size below — that's the source of truth.
    let status = std::process::Command::new("curl")
        .args([
            "-L",
            "--fail",
            "--fail-with-body",
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

    // Validate the partial file is plausibly the full model before
    // promoting it to `model.bin`. A truncated download (curl exits 0
    // mid-transfer due to network blip on a chunk boundary) would
    // otherwise leave a permanently corrupt cache. We bail with the
    // real IO error instead of silently defaulting to 0 — a metadata
    // failure here means the partial file is unreadable, which is its
    // own diagnostic surface, not "size 0 → re-download forever".
    let size = fs::metadata(&tmp)
        .map(|m| m.len())
        .map_err(|e| format!("stat partial download {}: {e}", tmp.display()))?;
    if size < MIN_MODEL_BYTES {
        let _ = fs::remove_file(&tmp);
        return Err(format!(
            "downloaded model too small: {size} bytes (expected >= {MIN_MODEL_BYTES})"
        ));
    }

    fs::rename(&tmp, &target).map_err(|e| format!("rename: {e}"))?;
    Ok(target)
}

fn ensure_ctx(model_id: &str) -> Result<&'static WhisperContext, String> {
    if let Some(ctx) = WHISPER_CTX.get() {
        return Ok(ctx);
    }
    // `download_model` already serializes via MODEL_DOWNLOAD_LOCK, so a
    // race here only costs one extra `WhisperContext::new_with_params`
    // (~hundreds of MB mmap) — still wasteful. Use a separate init lock
    // so only one caller actually loads the model into memory.
    static INIT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = INIT_LOCK.lock().map_err(|e| format!("init lock: {e}"))?;
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
    // Under INIT_LOCK we're the only writer; `set` always succeeds here.
    WHISPER_CTX
        .set(ctx)
        .map_err(|_| "whisper ctx already set (race)".to_string())?;
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
        // `ensure_ctx` already loaded the model — the file MUST exist and
        // be readable here. Any metadata error is a real IO problem
        // (permission revoked, fs unmount); propagate instead of
        // silently reporting 0 bytes which would falsely look like a
        // missing/empty model in the UI.
        let size = fs::metadata(&path)
            .map(|m| m.len())
            .map_err(|e| format!("stat loaded model {}: {e}", path.display()))?;
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
