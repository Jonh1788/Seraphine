//! Parity + behaviour tests for the wake-word chain.
//!
//! The one that matters is the parity test. A chain that runs cleanly and
//! scores wrong is the failure mode this port has to rule out, and
//! "returns a float in [0, 1]" would not catch it. `expected.json` holds
//! per-stage output produced by openWakeWord's own Python preprocessor
//! (see `tests/fixtures/wakeword/generate_reference.py`) over the same
//! committed audio these tests replay.

use std::path::PathBuf;

use serde::Deserialize;

use super::chain::{
    Detection, Detector, FrameScorer, WakeWordChain, CLASSIFIER_FRAMES, DEFAULT_REFRACTORY_S,
    DEFAULT_THRESHOLD, FRAME_SAMPLES,
};

// Absolute agreement required between Python (onnxruntime) and Rust
// (tract) at every stage. The two runtimes accumulate f32 in a different
// order so bit-identity is not on the table, but anything looser than this
// would stop being evidence.
const SCORE_TOL: f64 = 1e-5;
const MEL_TOL: f64 = 1e-4;
const EMBEDDING_TOL: f64 = 1e-3;

#[derive(Deserialize)]
struct Expected {
    warm_from: usize,
    threshold: f64,
    fixtures: std::collections::HashMap<String, FixtureExpectation>,
    classifier_high: ClassifierHigh,
}

#[derive(Deserialize)]
struct FixtureExpectation {
    samples: usize,
    chunks: usize,
    scores: Vec<f64>,
    probe_chunk: usize,
    mel_at_probe: Vec<Vec<f64>>,
    embedding_at_probe: Vec<f64>,
    max_score: f64,
    argmax_chunk: usize,
}

#[derive(Deserialize)]
struct ClassifierHigh {
    score: f64,
}

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/wakeword")
}

fn expected() -> Expected {
    let raw = std::fs::read_to_string(fixtures_dir().join("expected.json"))
        .expect("read tests/fixtures/wakeword/expected.json");
    serde_json::from_str(&raw).expect("parse expected.json")
}

fn read_pcm(name: &str) -> Vec<i16> {
    let bytes =
        std::fs::read(fixtures_dir().join(name)).unwrap_or_else(|e| panic!("read {name}: {e}"));
    assert!(bytes.len() % 2 == 0, "{name}: not whole s16le samples");
    bytes
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]))
        .collect()
}

fn read_f32(name: &str) -> Vec<f32> {
    let bytes =
        std::fs::read(fixtures_dir().join(name)).unwrap_or_else(|e| panic!("read {name}: {e}"));
    assert!(bytes.len() % 4 == 0, "{name}: not whole f32s");
    bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect()
}

/// Replay a fixture through the Rust chain, checking every stage against
/// the Python reference. Returns the worst score disagreement.
fn assert_parity(fixture: &str, exp: &Expected) -> f64 {
    let expectation = exp.fixtures.get(fixture).expect("fixture in expected.json");
    let pcm = read_pcm(&format!("{fixture}.s16le"));
    assert_eq!(
        pcm.len(),
        expectation.samples,
        "{fixture}: fixture length drifted"
    );

    let mut chain = WakeWordChain::new().expect("build chain");
    let mut worst = 0.0_f64;
    let mut compared = 0usize;

    for chunk in 0..expectation.chunks {
        let frame = &pcm[chunk * FRAME_SAMPLES..(chunk + 1) * FRAME_SAMPLES];
        let score = chain.score_frame(frame).expect("score frame");

        if chunk == expectation.probe_chunk {
            // Mel stage. Without this a preprocessing drift could hide
            // behind two near-zero classifier scores agreeing.
            let rows = chain.mel_tail(expectation.mel_at_probe.len());
            assert_eq!(rows.len(), expectation.mel_at_probe.len());
            for (r, (got, want)) in rows.iter().zip(&expectation.mel_at_probe).enumerate() {
                for (c, (g, w)) in got.iter().zip(want).enumerate() {
                    let d = (*g as f64 - *w).abs();
                    assert!(
                        d <= MEL_TOL,
                        "{fixture}: mel[{r}][{c}] rust={g} python={w} delta={d}"
                    );
                }
            }
            // Embedding stage — the one an ONNX runtime is most likely to
            // get wrong (see generate_reference.py's docstring).
            let emb = chain.last_embedding().expect("embedding present");
            for (i, (g, w)) in emb.iter().zip(&expectation.embedding_at_probe).enumerate() {
                let d = (*g as f64 - *w).abs();
                assert!(
                    d <= EMBEDDING_TOL,
                    "{fixture}: embedding[{i}] rust={g} python={w} delta={d}"
                );
            }
        }

        if chunk < exp.warm_from {
            continue;
        }
        let score = score.unwrap_or_else(|| {
            panic!("{fixture}: chunk {chunk} is past warm_from but produced no score")
        });
        let want = expectation.scores[chunk];
        let d = (score as f64 - want).abs();
        worst = worst.max(d);
        compared += 1;
        assert!(
            d <= SCORE_TOL,
            "{fixture}: score[{chunk}] rust={score} python={want} delta={d}"
        );
    }

    assert!(compared > 20, "{fixture}: only {compared} scores compared");
    worst
}

#[test]
fn python_and_rust_chains_agree_on_the_wake_word() {
    let exp = expected();
    let delta = assert_parity("wake_positive", &exp);
    println!("wake_positive: max |rust - python| = {delta:e}");
}

#[test]
fn python_and_rust_chains_agree_on_negative_speech() {
    let exp = expected();
    let delta = assert_parity("neg_speech", &exp);
    println!("neg_speech: max |rust - python| = {delta:e}");
}

/// End to end: real audio of the wake phrase drives the real chain past
/// the real operating point, exactly once.
#[test]
fn wake_word_audio_fires_once() {
    let exp = expected();
    let expectation = exp.fixtures.get("wake_positive").unwrap();
    assert!(
        expectation.max_score >= exp.threshold,
        "reference itself never crosses threshold — fixture is wrong"
    );

    let pcm = read_pcm("wake_positive.s16le");
    let chain = WakeWordChain::new().expect("build chain");
    let mut detector = Detector::new(chain, DEFAULT_THRESHOLD, DEFAULT_REFRACTORY_S);

    // Feed in 100 ms slices, the cadence the native mic paths emit at, so
    // the frame re-cutting inside `feed` is exercised too.
    let mut hits = Vec::new();
    for slice in pcm.chunks(1_600) {
        if let Some(d) = detector.feed(slice).expect("feed") {
            hits.push(d);
        }
    }
    assert_eq!(hits.len(), 1, "one utterance must fire once, got {hits:?}");
    assert!(
        hits[0].score >= DEFAULT_THRESHOLD,
        "fired below threshold: {hits:?}"
    );
    println!(
        "wake_positive fired at {:.4} (python peak {:.4} at chunk {})",
        hits[0].score, expectation.max_score, expectation.argmax_chunk
    );
}

/// Non-wake-word speech must stay under the validated operating point.
#[test]
fn negative_speech_never_reaches_the_operating_point() {
    let exp = expected();
    let expectation = exp.fixtures.get("neg_speech").unwrap();
    assert!(
        expectation.max_score < exp.threshold,
        "reference itself is above threshold — fixture is wrong"
    );

    let pcm = read_pcm("neg_speech.s16le");
    let chain = WakeWordChain::new().expect("build chain");
    let mut detector = Detector::new(chain, DEFAULT_THRESHOLD, DEFAULT_REFRACTORY_S);
    for slice in pcm.chunks(1_600) {
        assert_eq!(
            detector.feed(slice).expect("feed"),
            None,
            "unrelated speech triggered the wake word"
        );
    }
}

/// The classifier on its own, pinned above the operating point, so a
/// classifier regression is caught without depending on the two upstream
/// models.
#[test]
fn classifier_matches_python_above_the_operating_point() {
    let exp = expected();
    let window = read_f32("classifier_high.f32");
    assert_eq!(window.len(), CLASSIFIER_FRAMES * 96);
    let chain = WakeWordChain::new().expect("build chain");
    let got = chain.classify(&window).expect("classify");
    let d = (got as f64 - exp.classifier_high.score).abs();
    assert!(
        d <= SCORE_TOL,
        "classifier rust={got} python={} delta={d}",
        exp.classifier_high.score
    );
    assert!(
        got >= DEFAULT_THRESHOLD,
        "fixture should be above threshold, got {got}"
    );
}

// ---------------------------------------------------------------------------
// Detector behaviour — scripted scorer, so threshold and refractory are
// tested as logic, independent of the model.
// ---------------------------------------------------------------------------

struct ScriptedScorer {
    scores: Vec<Option<f32>>,
    idx: usize,
    resets: usize,
}

impl ScriptedScorer {
    fn new(scores: Vec<Option<f32>>) -> Self {
        Self {
            scores,
            idx: 0,
            resets: 0,
        }
    }
}

impl FrameScorer for ScriptedScorer {
    fn score_frame(&mut self, frame: &[i16]) -> Result<Option<f32>, String> {
        assert_eq!(frame.len(), FRAME_SAMPLES);
        let s = self.scores.get(self.idx).copied().flatten();
        self.idx += 1;
        Ok(s)
    }
    fn reset(&mut self) {
        self.idx = 0;
        self.resets += 1;
    }
}

fn silence(frames: usize) -> Vec<i16> {
    vec![0; frames * FRAME_SAMPLES]
}

#[test]
fn threshold_boundary_is_inclusive_and_tight() {
    // Exactly at 0.92 fires; a hair under does not.
    let mut just_under = Detector::new(
        ScriptedScorer::new(vec![Some(0.9199999)]),
        DEFAULT_THRESHOLD,
        DEFAULT_REFRACTORY_S,
    );
    assert_eq!(just_under.feed(&silence(1)).unwrap(), None);

    let mut exactly = Detector::new(
        ScriptedScorer::new(vec![Some(DEFAULT_THRESHOLD)]),
        DEFAULT_THRESHOLD,
        DEFAULT_REFRACTORY_S,
    );
    assert_eq!(
        exactly.feed(&silence(1)).unwrap(),
        Some(Detection {
            score: DEFAULT_THRESHOLD
        })
    );

    // 0.6 — the value openWakeWord's README uses in its examples — must NOT
    // be this model's operating point.
    let mut readme_value = Detector::new(
        ScriptedScorer::new(vec![Some(0.6)]),
        DEFAULT_THRESHOLD,
        DEFAULT_REFRACTORY_S,
    );
    assert_eq!(readme_value.feed(&silence(1)).unwrap(), None);
}

#[test]
fn warmup_none_scores_never_fire() {
    let mut d = Detector::new(
        ScriptedScorer::new(vec![None; 40]),
        DEFAULT_THRESHOLD,
        DEFAULT_REFRACTORY_S,
    );
    assert_eq!(d.feed(&silence(40)).unwrap(), None);
}

#[test]
fn refractory_swallows_the_rest_of_one_utterance() {
    // 2.0 s at 1280 samples/frame = 25 muted frames after a hit.
    let refractory_frames =
        (DEFAULT_REFRACTORY_S * 16_000.0 / FRAME_SAMPLES as f32).round() as usize;
    assert_eq!(refractory_frames, 25);

    let mut d = Detector::new(
        ScriptedScorer::new(vec![Some(0.99); 60]),
        DEFAULT_THRESHOLD,
        DEFAULT_REFRACTORY_S,
    );
    let mut hits = Vec::new();
    for _ in 0..60 {
        if let Some(det) = d.feed(&silence(1)).unwrap() {
            hits.push(det.score);
        }
    }
    // Frame 0 fires, 1..=25 are muted, 26 fires, 27..=51 muted, 52 fires.
    // Three hits across 60 frames of continuous speech, not sixty.
    assert_eq!(hits.len(), 3, "hits over 60 above-threshold frames: {hits:?}");
}

#[test]
fn refractory_counts_down_exactly() {
    let mut d = Detector::new(
        ScriptedScorer::new(vec![Some(0.95); 40]),
        DEFAULT_THRESHOLD,
        DEFAULT_REFRACTORY_S,
    );
    assert!(d.feed(&silence(1)).unwrap().is_some(), "frame 0 fires");
    for f in 1..=25 {
        assert!(
            d.feed(&silence(1)).unwrap().is_none(),
            "frame {f} must be muted"
        );
    }
    assert!(d.feed(&silence(1)).unwrap().is_some(), "frame 26 fires again");
}

#[test]
fn feed_cuts_arbitrary_pcm_into_1280_sample_frames() {
    let mut scores = vec![Some(0.0); 3];
    scores.push(Some(0.97));
    let mut d = Detector::new(
        ScriptedScorer::new(scores),
        DEFAULT_THRESHOLD,
        DEFAULT_REFRACTORY_S,
    );
    // 3 frames + 640 leftover samples: no hit yet.
    let mut pcm = silence(3);
    pcm.extend(vec![0_i16; 640]);
    assert_eq!(d.feed(&pcm).unwrap(), None);
    // 640 more completes frame 3, the scripted hit.
    assert_eq!(
        d.feed(&vec![0_i16; 640]).unwrap(),
        Some(Detection { score: 0.97 })
    );
}

#[test]
fn reset_clears_cooldown_and_scorer_state() {
    let mut d = Detector::new(
        ScriptedScorer::new(vec![Some(0.99); 10]),
        DEFAULT_THRESHOLD,
        DEFAULT_REFRACTORY_S,
    );
    assert!(d.feed(&silence(1)).unwrap().is_some());
    assert!(d.feed(&silence(1)).unwrap().is_none(), "cooldown active");
    d.reset();
    assert!(d.feed(&silence(1)).unwrap().is_some(), "reset clears cooldown");
    assert_eq!(d.scorer_mut().resets, 1);
}

#[test]
fn chain_rejects_wrong_frame_size() {
    let mut chain = WakeWordChain::new().expect("build chain");
    let err = chain.score_frame(&vec![0_i16; 512]).unwrap_err();
    assert!(err.contains("1280"), "{err}");
}
