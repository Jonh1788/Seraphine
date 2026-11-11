"""Local Whisper for Windows/Linux, with CPU int8 inference by default."""
from __future__ import annotations

import asyncio
import io
import threading
from typing import Any

from seraphine.stt.whisper import STTUnavailableError, Transcription, WhisperSTT


class FasterWhisperSTT:
    def __init__(self, *, model: str = "small", language: str | None = "pt") -> None:
        self.model = model
        self.language = language
        self._model: Any = None
        self._lock = threading.Lock()

    async def transcribe(self, pcm_bytes: bytes, sample_rate: int = 16000) -> Transcription:
        if not pcm_bytes:
            return Transcription(text="", duration_seconds=0.0)
        if sample_rate <= 0 or len(pcm_bytes) % 2:
            raise STTUnavailableError("Expected mono s16le PCM and a positive sample rate")

        def work() -> Transcription:
            # PyAV decodes/resamples the WAV, including non-16 kHz browser audio.
            audio = io.BytesIO(WhisperSTT.pcm_to_wav_bytes(pcm_bytes, sample_rate))
            try:
                with self._lock:
                    if self._model is None:
                        from faster_whisper import WhisperModel

                        self._model = WhisperModel(self.model, device="cpu", compute_type="int8")
                    segments, info = self._model.transcribe(
                        audio, language=self.language, beam_size=1,
                        vad_filter=True, condition_on_previous_text=False,
                    )
                    text = " ".join(segment.text.strip() for segment in segments).strip()
                return Transcription(
                    text=text, language=info.language,
                    duration_seconds=len(pcm_bytes) / 2 / sample_rate,
                )
            except Exception as exc:
                raise STTUnavailableError(f"faster-whisper transcription failed: {exc}") from exc

        return await asyncio.to_thread(work)
