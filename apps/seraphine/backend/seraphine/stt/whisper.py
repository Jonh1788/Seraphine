"""Local speech-to-text via mlx-whisper.

Background: we originally tried to feed raw PCM to Gemma 4 via an
"audio" field on the Ollama /api/chat message. That field does not
exist in Ollama's current Message struct (confirmed by reading
github.com/ollama/ollama/blob/main/api/types.go) — only `Images` is
there, so the audio payload was silently discarded and the model
always saw the placeholder "[audio]".

Fix: transcribe the user's mic PCM locally with Whisper, hand the
resulting TEXT to the existing ConversationEngine.handle_user_message
path, and drop the fake Ollama audio field entirely. This also
replaces the "[audio]" user-turn placeholder with the real
transcription, finally cleaning up the Phase 5 memory pollution
we'd flagged as a known defect.

mlx-whisper is a pure-Python MLX port from the mlx-examples repo.
Runs on Apple Silicon natively via Metal, much faster than
whisper.cpp for the same model. First use downloads the requested
checkpoint from Hugging Face to ~/.cache/huggingface/hub.
"""

from __future__ import annotations

import asyncio
import io
import logging
import wave
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger("seraphine.stt")


class STTUnavailableError(Exception):
    pass


@dataclass
class Transcription:
    text: str
    language: str | None = None
    duration_seconds: float = 0.0


class WhisperSTT:
    """Thin async wrapper around mlx_whisper.transcribe().

    The mlx-whisper CLI accepts audio file paths. It can also accept
    a numpy array directly via the Python API. We always take PCM
    bytes (s16le mono) + a sample rate and convert on the fly:
    either via an in-memory numpy array (fast path) or by writing a
    temp WAV and pointing transcribe() at it (safe fallback).

    The heavy torch / mlx imports happen lazily on first transcribe()
    call so the backend startup stays fast when voice input isn't
    exercised.
    """

    def __init__(
        self,
        *,
        model: str = "mlx-community/whisper-small-mlx-q4",
        language: str | None = "pt",
        initial_prompt: str | None = None,
    ) -> None:
        self.model = model
        self.language = language
        self.initial_prompt = initial_prompt
        self._transcribe: Any | None = None  # lazily bound callable

    async def transcribe(self, pcm_bytes: bytes, sample_rate: int = 16000) -> Transcription:
        """Transcribe s16le mono PCM. Returns text + metadata."""
        if not pcm_bytes:
            return Transcription(text="", duration_seconds=0.0)

        duration = len(pcm_bytes) / 2 / float(sample_rate)

        def _work() -> Transcription:
            import numpy as np

            if self._transcribe is None:
                try:
                    import mlx_whisper  # type: ignore[import-not-found]
                except ImportError as e:  # pragma: no cover
                    raise STTUnavailableError(
                        f"mlx_whisper not importable: {e}"
                    ) from e
                self._transcribe = mlx_whisper.transcribe

            # Decode s16le PCM into a float32 numpy array in [-1, 1],
            # which is the format mlx-whisper's transcribe() accepts
            # directly via the `audio` kwarg (no file round-trip).
            arr = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0

            # mlx-whisper always resamples internally to 16 kHz; if
            # we hand it something at a different rate, we must
            # upsample / downsample first. In practice we only ever
            # feed it 16 kHz (the browser MicCapture output).
            if sample_rate != 16000:
                # Very rough linear resample; fine for fallback since
                # the WS path always sends 16 kHz anyway.
                ratio = 16000 / sample_rate
                new_len = int(len(arr) * ratio)
                if new_len > 0:
                    idx = np.linspace(0, len(arr) - 1, new_len).astype(np.int64)
                    arr = arr[idx]

            kwargs: dict[str, Any] = {"path_or_hf_repo": self.model}
            if self.language:
                kwargs["language"] = self.language
            if self.initial_prompt:
                kwargs["initial_prompt"] = self.initial_prompt
            try:
                assert self._transcribe is not None
                result = self._transcribe(arr, **kwargs)
            except Exception as e:
                raise STTUnavailableError(f"whisper transcribe failed: {e}") from e

            text = str(result.get("text", "")).strip() if isinstance(result, dict) else ""
            lang = (
                str(result.get("language")) if isinstance(result, dict) and result.get("language") else None
            )
            return Transcription(text=text, language=lang, duration_seconds=duration)

        return await asyncio.to_thread(_work)

    @staticmethod
    def pcm_to_wav_bytes(pcm_bytes: bytes, sample_rate: int = 16000) -> bytes:
        """Wrap raw s16le PCM in a WAV container. Utility for callers
        that want to persist the original audio alongside its transcript."""
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sample_rate)
            w.writeframes(pcm_bytes)
        return buf.getvalue()
