//! openWakeWord inference chain, ported to Rust.
//!
//! audio -> melspectrogram -> speech embedding -> custom classifier
//!
//! The two upstream models (`melspectrogram.onnx`, `embedding_model.onnx`)
//! are openWakeWord's shared models; `ei_seraphine_v9.onnx` is our own
//! classifier, trained against those embeddings. Feeding raw audio to the
//! classifier returns confident garbage — the whole point of this module is
//! that the preprocessing matches openWakeWord *exactly*.
//!
//! Everything here is a faithful port of openWakeWord's
//! `utils.AudioFeatures._streaming_features` (+ `_streaming_melspectrogram`,
//! `_get_melspectrogram`, `get_features`) and `model.Model.predict`. The
//! parity test in `tests.rs` pins the port against scores produced by the
//! Python implementation over committed fixture audio.
//!
//! Details that silently wreck accuracy if you get them wrong, all derived
//! from that source:
//!
//! * The melspectrogram model is fed **raw int16 magnitudes cast to f32**
//!   (range ±32768), not samples normalised to ±1.0.
//! * Its output is transformed by `spec / 10 + 2` before anything else sees
//!   it (`_get_melspectrogram`'s default `melspec_transform`).
//! * Each 1280-sample chunk is melspec'd together with the **previous 480
//!   samples** (`160 * 3`) so it yields exactly 8 new mel frames. The very
//!   first chunk has no history, so it yields only 5.
//! * The mel buffer starts as a 76x32 block of **ones**, and one embedding
//!   consumes the **last 76 mel frames**.
//! * The classifier consumes the **last 20 embeddings**, newest last.

use std::collections::HashMap;
use std::io::Cursor;

use tract_onnx::prelude::*;

/// 16 kHz mono — the only rate the chain accepts.
pub const SAMPLE_RATE: usize = 16_000;
/// openWakeWord's native chunk: 80 ms @ 16 kHz.
pub const FRAME_SAMPLES: usize = 1280;
/// Extra history samples prepended to each chunk before the mel model
/// (`160 * 3` in `_streaming_melspectrogram`).
const MEL_CONTEXT_SAMPLES: usize = 480;
/// Mel bins, fixed by the melspectrogram model.
const MEL_BINS: usize = 32;
/// Mel frames consumed by one embedding, fixed by the embedding model.
const EMBED_WINDOW: usize = 76;
/// Embedding dimensionality, fixed by the embedding model.
const EMBED_DIM: usize = 96;
/// `melspectrogram_max_len` — 10 s of mel history.
const MEL_BUFFER_MAX: usize = 10 * 97;
/// `feature_buffer_max_len` — ~10 s of embedding history.
const FEATURE_BUFFER_MAX: usize = 120;
/// Embeddings the ei_seraphine_v9 classifier consumes per prediction.
pub const CLASSIFIER_FRAMES: usize = 20;

// The three models ship inside the binary rather than as bundled
// resources. Reasons, in order of weight:
//   1. iOS. A Tauri resource has to be resolved through the app bundle at
//      runtime; `include_bytes!` cannot fail to find its file, on any
//      platform, including when the wake word is armed from a background
//      audio callback with no window attached.
//   2. `cargo test` has no Tauri resource resolver at all, so the parity
//      test would have to reach outside the crate to find them — the exact
//      kind of path fragility that makes a parity test rot.
// The cost is ~2.8 MB of binary. The bytes live in the executable's
// read-only data and are memory-mapped by the loader, so there is no
// runtime copy and no heap cost for holding them.
const MELSPEC_ONNX: &[u8] = include_bytes!("../../models/wakeword/melspectrogram.onnx");
const EMBEDDING_ONNX: &[u8] = include_bytes!("../../models/wakeword/embedding_model.onnx");
const CLASSIFIER_ONNX: &[u8] = include_bytes!("../../models/wakeword/ei_seraphine_v9.onnx");

/// Validated operating point for `ei_seraphine_v9`, from
/// `models/wakeword/ei_seraphine_v9.metrics.json`:
/// `fp_per_hour 0.454 · recall 0.96875 · n_pos 32 · neg_hours 11.0`.
///
/// openWakeWord's README uses 0.6 in its examples. That is not this
/// model's operating point and would flood the user with false triggers.
pub const DEFAULT_THRESHOLD: f32 = 0.92;
/// `refractory_s` from the engine's outer loop — how long detection stays
/// muted after a hit, so one utterance fires once.
pub const DEFAULT_REFRACTORY_S: f32 = 2.0;

type Runnable = std::sync::Arc<TypedRunnableModel>;

/// Anything that turns an 80 ms frame into a wake-word score.
///
/// `None` means "not enough history yet" — the chain needs
/// [`CLASSIFIER_FRAMES`] embeddings before it can say anything. Callers
/// must still feed every frame so the internal state advances.
pub trait FrameScorer {
    fn score_frame(&mut self, frame: &[i16]) -> Result<Option<f32>, String>;
    fn reset(&mut self);
}

/// The full audio -> score chain, holding the streaming buffers.
pub struct WakeWordChain {
    mel_plans: HashMap<usize, Runnable>,
    /// Kept un-concretised: the melspectrogram model's sample count is a
    /// symbolic dim, and two different lengths are fed to it.
    mel_source: InferenceModel,
    embedding: Runnable,
    classifier: Runnable,

    /// Raw int16 history. Only the newest `FRAME_SAMPLES + MEL_CONTEXT_SAMPLES`
    /// are ever read; openWakeWord keeps 10 s but never looks further back.
    raw: Vec<i16>,
    /// Mel frames, row-major `[frames][MEL_BINS]`. Seeded with 76 rows of
    /// ones exactly like `AudioFeatures.__init__`.
    mel: Vec<[f32; MEL_BINS]>,
    /// Embedding history, newest last.
    features: Vec<[f32; EMBED_DIM]>,
}

impl WakeWordChain {
    /// Parse and optimise all three models. Costs a few hundred ms — do it
    /// once, off the audio thread.
    pub fn new() -> Result<Self, String> {
        let mel_source = tract_onnx::onnx()
            .model_for_read(&mut Cursor::new(MELSPEC_ONNX))
            .map_err(|e| format!("wakeword: parse melspectrogram.onnx: {e}"))?;

        let embedding = tract_onnx::onnx()
            .model_for_read(&mut Cursor::new(EMBEDDING_ONNX))
            .map_err(|e| format!("wakeword: parse embedding_model.onnx: {e}"))?
            .with_input_fact(
                0,
                f32::fact([1, EMBED_WINDOW, MEL_BINS, 1]).into(),
            )
            .map_err(|e| format!("wakeword: shape embedding_model.onnx: {e}"))?
            .into_optimized()
            .map_err(|e| format!("wakeword: optimize embedding_model.onnx: {e}"))?
            .into_runnable()
            .map_err(|e| format!("wakeword: plan embedding_model.onnx: {e}"))?;

        let classifier = tract_onnx::onnx()
            .model_for_read(&mut Cursor::new(CLASSIFIER_ONNX))
            .map_err(|e| format!("wakeword: parse classifier: {e}"))?
            .with_input_fact(0, f32::fact([1, CLASSIFIER_FRAMES, EMBED_DIM]).into())
            .map_err(|e| format!("wakeword: shape classifier: {e}"))?
            .into_optimized()
            .map_err(|e| format!("wakeword: optimize classifier: {e}"))?
            .into_runnable()
            .map_err(|e| format!("wakeword: plan classifier: {e}"))?;

        Ok(Self {
            mel_plans: HashMap::new(),
            mel_source,
            embedding,
            classifier,
            raw: Vec::with_capacity(FRAME_SAMPLES + MEL_CONTEXT_SAMPLES),
            mel: vec![[1.0_f32; MEL_BINS]; EMBED_WINDOW],
            features: Vec::with_capacity(FEATURE_BUFFER_MAX),
        })
    }

    /// The melspectrogram model takes a dynamic sample count. Exactly two
    /// lengths ever occur (1280 for the first chunk, 1760 afterwards), so
    /// concretise and cache a plan per length.
    fn mel_plan(&mut self, len: usize) -> Result<&Runnable, String> {
        if !self.mel_plans.contains_key(&len) {
            let plan = self
                .mel_source
                .clone()
                .with_input_fact(0, f32::fact([1, len]).into())
                .map_err(|e| format!("wakeword: shape melspectrogram({len}): {e}"))?
                .into_optimized()
                .map_err(|e| format!("wakeword: optimize melspectrogram({len}): {e}"))?
                .into_runnable()
                .map_err(|e| format!("wakeword: plan melspectrogram({len}): {e}"))?;
            self.mel_plans.insert(len, plan);
        }
        Ok(self.mel_plans.get(&len).expect("just inserted"))
    }

    /// `_get_melspectrogram` — int16 magnitudes in, `spec / 10 + 2` out.
    fn melspectrogram(&mut self, samples: &[i16]) -> Result<Vec<[f32; MEL_BINS]>, String> {
        let len = samples.len();
        let input: Tensor = tract_ndarray::Array2::from_shape_vec(
            (1, len),
            samples.iter().map(|&s| s as f32).collect(),
        )
        .map_err(|e| format!("wakeword: mel input shape: {e}"))?
        .into();

        let plan = self.mel_plan(len)?;
        let out = plan
            .run(tvec!(input.into()))
            .map_err(|e| format!("wakeword: run melspectrogram: {e}"))?;
        let view = out[0]
            .to_plain_array_view::<f32>()
            .map_err(|e| format!("wakeword: mel output: {e}"))?;
        let flat: Vec<f32> = view.iter().copied().collect();
        if flat.len() % MEL_BINS != 0 {
            return Err(format!(
                "wakeword: mel output len {} is not a multiple of {MEL_BINS}",
                flat.len()
            ));
        }
        Ok(flat
            .chunks_exact(MEL_BINS)
            .map(|row| {
                let mut out = [0.0_f32; MEL_BINS];
                for (o, v) in out.iter_mut().zip(row) {
                    // openWakeWord's default `melspec_transform`, which
                    // brings the ONNX melspectrogram closer to Google's
                    // native TF implementation the embedding model expects.
                    *o = v / 10.0 + 2.0;
                }
                out
            })
            .collect())
    }

    /// `_get_embeddings_from_melspec` over the newest 76 mel frames.
    fn embed_latest(&self) -> Result<[f32; EMBED_DIM], String> {
        let start = self.mel.len() - EMBED_WINDOW;
        let mut flat = Vec::with_capacity(EMBED_WINDOW * MEL_BINS);
        for row in &self.mel[start..] {
            flat.extend_from_slice(row);
        }
        let input: Tensor = tract_ndarray::Array4::from_shape_vec(
            (1, EMBED_WINDOW, MEL_BINS, 1),
            flat,
        )
        .map_err(|e| format!("wakeword: embedding input shape: {e}"))?
        .into();

        let out = self
            .embedding
            .run(tvec!(input.into()))
            .map_err(|e| format!("wakeword: run embedding: {e}"))?;
        let view = out[0]
            .to_plain_array_view::<f32>()
            .map_err(|e| format!("wakeword: embedding output: {e}"))?;
        let mut emb = [0.0_f32; EMBED_DIM];
        for (o, v) in emb.iter_mut().zip(view.iter()) {
            *o = *v;
        }
        Ok(emb)
    }

    /// Run the classifier over an explicit `[1, 20, 96]` window. Exposed so
    /// the classifier stage can be pinned on its own.
    pub fn classify(&self, window: &[f32]) -> Result<f32, String> {
        if window.len() != CLASSIFIER_FRAMES * EMBED_DIM {
            return Err(format!(
                "wakeword: classifier window must be {} floats, got {}",
                CLASSIFIER_FRAMES * EMBED_DIM,
                window.len()
            ));
        }
        let input: Tensor = tract_ndarray::Array3::from_shape_vec(
            (1, CLASSIFIER_FRAMES, EMBED_DIM),
            window.to_vec(),
        )
        .map_err(|e| format!("wakeword: classifier input shape: {e}"))?
        .into();
        let out = self
            .classifier
            .run(tvec!(input.into()))
            .map_err(|e| format!("wakeword: run classifier: {e}"))?;
        let view = out[0]
            .to_plain_array_view::<f32>()
            .map_err(|e| format!("wakeword: classifier output: {e}"))?;
        view.iter()
            .next()
            .copied()
            .ok_or_else(|| "wakeword: empty classifier output".to_string())
    }

    /// Latest embedding, for stage-level assertions.
    #[cfg(test)]
    pub fn last_embedding(&self) -> Option<&[f32; EMBED_DIM]> {
        self.features.last()
    }

    /// Mel rows appended by the most recent frame, for stage-level assertions.
    #[cfg(test)]
    pub fn mel_tail(&self, n: usize) -> Vec<[f32; MEL_BINS]> {
        let start = self.mel.len().saturating_sub(n);
        self.mel[start..].to_vec()
    }
}

impl FrameScorer for WakeWordChain {
    fn score_frame(&mut self, frame: &[i16]) -> Result<Option<f32>, String> {
        if frame.len() != FRAME_SAMPLES {
            return Err(format!(
                "wakeword: frame must be {FRAME_SAMPLES} samples, got {}",
                frame.len()
            ));
        }

        // `_buffer_raw_data` + `_streaming_melspectrogram`: melspec the new
        // chunk together with the previous 480 samples. On the first chunk
        // there is no history, so only 1280 samples go in and the model
        // returns 5 frames instead of 8 — keeping that asymmetry is what
        // keeps the mel buffer aligned with Python's.
        self.raw.extend_from_slice(frame);
        let keep = FRAME_SAMPLES + MEL_CONTEXT_SAMPLES;
        if self.raw.len() > keep {
            let drop = self.raw.len() - keep;
            self.raw.drain(..drop);
        }
        // Copied out because `melspectrogram` needs `&mut self` to reach the
        // plan cache. 1760 samples = 3.5 kB per 80 ms frame; not worth
        // restructuring the borrow around.
        let window: Vec<i16> = self.raw.clone();

        let rows = self.melspectrogram(&window)?;
        self.mel.extend(rows);
        if self.mel.len() > MEL_BUFFER_MAX {
            let drop = self.mel.len() - MEL_BUFFER_MAX;
            self.mel.drain(..drop);
        }

        let emb = self.embed_latest()?;
        self.features.push(emb);
        if self.features.len() > FEATURE_BUFFER_MAX {
            let drop = self.features.len() - FEATURE_BUFFER_MAX;
            self.features.drain(..drop);
        }

        // openWakeWord seeds its feature buffer with the embeddings of 4 s
        // of *random* audio and then zeroes the first 5 predictions to hide
        // them. We simply stay silent until the window is entirely real
        // audio, which is strictly safer: the classifier saturates near 1.0
        // on out-of-distribution input, so scoring warm-up noise is a way to
        // manufacture false positives.
        if self.features.len() < CLASSIFIER_FRAMES {
            return Ok(None);
        }
        let start = self.features.len() - CLASSIFIER_FRAMES;
        let mut window = Vec::with_capacity(CLASSIFIER_FRAMES * EMBED_DIM);
        for row in &self.features[start..] {
            window.extend_from_slice(row);
        }
        self.classify(&window).map(Some)
    }

    fn reset(&mut self) {
        self.raw.clear();
        self.mel = vec![[1.0_f32; MEL_BINS]; EMBED_WINDOW];
        self.features.clear();
    }
}

/// A wake-word hit.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
pub struct Detection {
    pub score: f32,
}

/// Threshold + refractory cooldown around a [`FrameScorer`].
///
/// Port of `wakeword/engine/core.py::WakeWordEngine.feed`: PCM is cut into
/// 1280-sample frames, every frame advances the scorer (even during
/// cooldown, so the buffers never desync), and a hit mutes detection for
/// `refractory_frames` afterwards. Without the cooldown a single utterance
/// fires on every frame it stays above threshold.
pub struct Detector<S: FrameScorer> {
    scorer: S,
    threshold: f32,
    refractory_frames: usize,
    cooldown: usize,
    pending: Vec<i16>,
}

impl<S: FrameScorer> Detector<S> {
    pub fn new(scorer: S, threshold: f32, refractory_s: f32) -> Self {
        let refractory_frames =
            (refractory_s * SAMPLE_RATE as f32 / FRAME_SAMPLES as f32).round() as usize;
        Self {
            scorer,
            threshold,
            refractory_frames,
            cooldown: 0,
            pending: Vec::with_capacity(FRAME_SAMPLES * 2),
        }
    }

    /// Feed arbitrary-length 16 kHz PCM. Returns the best detection across
    /// the frames this call completed, mirroring `WakeWordEngine.feed`.
    pub fn feed(&mut self, pcm: &[i16]) -> Result<Option<Detection>, String> {
        self.pending.extend_from_slice(pcm);
        let mut best: Option<Detection> = None;
        while self.pending.len() >= FRAME_SAMPLES {
            let frame: Vec<i16> = self.pending.drain(..FRAME_SAMPLES).collect();
            let score = self.scorer.score_frame(&frame)?;
            if self.cooldown > 0 {
                self.cooldown -= 1;
                continue;
            }
            let Some(score) = score else { continue };
            if score >= self.threshold {
                let candidate = Detection { score };
                if best.map_or(true, |b| candidate.score > b.score) {
                    best = Some(candidate);
                }
                self.cooldown = self.refractory_frames;
            }
        }
        Ok(best)
    }

    pub fn reset(&mut self) {
        self.scorer.reset();
        self.pending.clear();
        self.cooldown = 0;
    }

    #[cfg(test)]
    pub fn scorer_mut(&mut self) -> &mut S {
        &mut self.scorer
    }
}
