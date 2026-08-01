#!/usr/bin/env python3
"""Ground truth for the Rust wake-word port.

Streams the committed fixture audio through openWakeWord's *own* Python
preprocessor plus the ei_seraphine_v9 classifier and writes every stage
(mel rows, embedding rows, classifier scores) to `expected.json`. The Rust
chain in `src/wakeword/chain.rs` is asserted against this file — the
failure mode being ruled out is a chain that runs cleanly and scores wrong.

    pip install openwakeword 'onnxruntime>=1.28'
    python generate_reference.py                # recompute expected.json
    python generate_reference.py --synth        # also re-synthesise the audio (needs macOS `say`)

=== READ THIS BEFORE TOUCHING THE onnxruntime VERSION ===

onnxruntime 1.27.0 computes `embedding_model.onnx` WRONG on macOS/arm64.
Not "slightly different" — completely different tensors. Verified two ways:

  * openWakeWord's own pretrained `hey_jarvis_v0.1` classifier scores 0.999
    on a TTS "hey jarvis" under 1.28.0 and 0.0002 under 1.27.0.
  * ei_seraphine_v9 scores 0.993 on a TTS "Ei Seraphine" under 1.28.0 and
    0.0019 under 1.27.0.
  * Under 1.27.0 the same model returns different values depending on the
    graph optimisation level, which is what an uninitialised read looks like.

`melspectrogram.onnx` and `ei_seraphine_v9.onnx` are unaffected; only the
embedding model is. If you regenerate this file with 1.27.0 the fixtures
will encode garbage and the Rust parity test will "fail" against a broken
reference. The version guard below exists for exactly that reason.
"""
import argparse
import json
import os
import subprocess
import wave

import numpy as np
import onnxruntime as ort

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.abspath(os.path.join(HERE, "..", "..", "..", "models", "wakeword"))
MEL = os.path.join(MODELS, "melspectrogram.onnx")
EMB = os.path.join(MODELS, "embedding_model.onnx")
CLS = os.path.join(MODELS, "ei_seraphine_v9.onnx")

# First chunk index whose 20-frame classifier window contains no warm-up
# noise. openWakeWord seeds `feature_buffer` with the embeddings of 4 s of
# *random* audio (utils.py:169), 41 rows of it; after 20 real chunks the
# last-20 window is entirely real. The Rust chain simply stays silent until
# it has 20 real embeddings, so both sides are comparable from here on.
WARM_FROM = 20
THRESHOLD = 0.92
PROBE_CHUNK = 30

FIXTURES = {
    # name: (text, macOS `say` voice, PRNG seed for the room-noise padding)
    "wake_positive": ("Ei Seraphine", "Luciana", 11),
    "neg_speech": ("O tempo hoje esta bom para uma caminhada no parque com o cachorro",
                   "Luciana", 21),
}


def require_onnxruntime():
    major, minor = (int(p) for p in ort.__version__.split(".")[:2])
    if (major, minor) < (1, 28):
        raise SystemExit(
            f"onnxruntime {ort.__version__} miscomputes embedding_model.onnx — "
            "see the module docstring. Install >= 1.28 before regenerating."
        )


def synth(text, voice, seed, lead_s=2.5, tail_s=1.0):
    aiff, wav = os.path.join(HERE, "_tmp.aiff"), os.path.join(HERE, "_tmp.wav")
    subprocess.run(["say", "-v", voice, "-o", aiff, text], check=True)
    if os.path.exists(wav):
        os.remove(wav)
    subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav],
                   check=True)
    with wave.open(wav, "rb") as w:
        speech = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    os.remove(aiff)
    os.remove(wav)
    rng = np.random.default_rng(seed)
    lead = rng.normal(0, 60, int(16000 * lead_s)).astype(np.int16)
    tail = rng.normal(0, 60, int(16000 * tail_s)).astype(np.int16)
    pcm = np.concatenate([lead, speech, tail]).astype(np.int16)
    return pcm[:(len(pcm) // 1280) * 1280]


def run_chain(pcm16):
    """Stream `pcm16` through openWakeWord 1280 samples (80 ms) at a time."""
    from openwakeword.utils import AudioFeatures

    feats = AudioFeatures(melspec_model_path=MEL, embedding_model_path=EMB,
                          inference_framework="onnx")
    cls = ort.InferenceSession(CLS, providers=["CPUExecutionProvider"])
    cls_in = cls.get_inputs()[0].name

    scores, mels, embs = [], [], []
    for i in range(len(pcm16) // 1280):
        before = feats.melspectrogram_buffer.shape[0]
        feats(pcm16[i * 1280:(i + 1) * 1280])
        added = feats.melspectrogram_buffer.shape[0] - before
        n_new = added if added > 0 else 8  # buffer saturates at 970 rows
        mels.append(feats.melspectrogram_buffer[-n_new:].astype(np.float64).tolist())
        embs.append(feats.feature_buffer[-1].astype(np.float64).tolist())
        x = feats.get_features(20)
        scores.append(float(cls.run(None, {cls_in: x.astype(np.float32)})[0][0][0]))
    return scores, mels, embs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--synth", action="store_true",
                    help="re-synthesise the fixture audio with macOS `say`")
    args = ap.parse_args()
    require_onnxruntime()

    manifest = {
        "_readme": "Generated by generate_reference.py — openWakeWord ground truth "
                   "for the Rust port. Requires onnxruntime >= 1.28; read the "
                   "script docstring before regenerating.",
        "onnxruntime": ort.__version__,
        "warm_from": WARM_FROM,
        "threshold": THRESHOLD,
        "fixtures": {},
    }

    for name, (text, voice, seed) in FIXTURES.items():
        path = os.path.join(HERE, f"{name}.s16le")
        if args.synth:
            synth(text, voice, seed).tofile(path)
        pcm = np.fromfile(path, dtype=np.int16)
        scores, mels, embs = run_chain(pcm)
        warm = scores[WARM_FROM:]
        manifest["fixtures"][name] = {
            "text": text,
            "voice": voice,
            "samples": int(len(pcm)),
            "chunks": len(scores),
            "scores": [float(s) for s in scores],
            # One full mel block (8 rows x 32) and one embedding (96) at a warm
            # chunk. Without these a preprocessing drift could hide behind two
            # near-zero classifier scores agreeing.
            "probe_chunk": PROBE_CHUNK,
            "mel_at_probe": mels[PROBE_CHUNK],
            "embedding_at_probe": embs[PROBE_CHUNK],
            "max_score": float(max(warm)),
            "argmax_chunk": int(np.argmax(warm)) + WARM_FROM,
        }
        print(f"{name:15} chunks={len(scores):3} max(warm)={max(warm):.4f}")

    # Classifier-stage fixture: a 20x96 window that drives the classifier
    # above its operating point, so the classifier can be pinned on its own
    # without depending on the two upstream models.
    x = np.fromfile(os.path.join(HERE, "classifier_high.f32"),
                    dtype=np.float32).reshape(1, 20, 96)
    cls = ort.InferenceSession(CLS, providers=["CPUExecutionProvider"])
    v = float(cls.run(None, {cls.get_inputs()[0].name: x})[0][0][0])
    manifest["classifier_high"] = {"shape": [1, 20, 96], "score": v}
    print(f"classifier_high score={v:.4f}")

    with open(os.path.join(HERE, "expected.json"), "w") as f:
        json.dump(manifest, f, indent=1)


if __name__ == "__main__":
    main()
