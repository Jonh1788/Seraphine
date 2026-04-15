"""Speech-to-text service backed by faster-whisper.

Design notes:
- The WhisperModel ctor downloads the weights (~500MB for ``small``)
  the first time it sees an unknown model. Wiring it at lifespan
  startup would stall the container boot for minutes, so we lazy-load
  on the first transcription. The loaded model is cached on the
  instance for the process lifetime.
- ``model.transcribe`` is CPU-bound and blocking. We run it via
  ``asyncio.to_thread`` so concurrent HTTP requests aren't starved
  while a single transcription is in flight.
- faster-whisper shells out to ffmpeg for non-PCM inputs (webm/opus
  is what MediaRecorder emits on Chrome/Firefox). The runtime image
  must have ``ffmpeg`` on PATH — see the Aura backend Dockerfile.
"""

from __future__ import annotations

import asyncio
import logging
import os
import tempfile
import threading
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


class STTService:
    def __init__(
        self,
        model_name: str,
        compute_type: str,
        cache_dir: Path,
    ) -> None:
        self._model_name = model_name
        self._compute_type = compute_type
        self._cache_dir = cache_dir
        self._model: Optional[object] = None  # WhisperModel, lazy
        # Guard concurrent first-calls from racing on the download.
        self._load_lock = threading.Lock()

    # ------------------------------------------------------------------
    # Model lifecycle
    # ------------------------------------------------------------------

    def _load_model_blocking(self) -> object:
        """Load (or return cached) WhisperModel. Blocks on first call."""
        if self._model is not None:
            return self._model
        with self._load_lock:
            if self._model is not None:
                return self._model
            # Import inside the method so startup doesn't pay the
            # ctranslate2 import cost unless STT is actually used.
            from faster_whisper import WhisperModel

            logger.info(
                "STT: loading whisper model=%s compute=%s cache=%s "
                "(first run downloads ~500MB)",
                self._model_name, self._compute_type, self._cache_dir,
            )
            model = WhisperModel(
                self._model_name,
                device="cpu",
                compute_type=self._compute_type,
                download_root=str(self._cache_dir),
            )
            self._model = model
            logger.info("STT: model ready")
            return model

    # ------------------------------------------------------------------
    # Transcription
    # ------------------------------------------------------------------

    def _transcribe_blocking(self, path: str, language: str) -> str:
        model = self._load_model_blocking()
        # faster-whisper returns (segments, info). segments is a
        # generator — consume it before the file is removed.
        segments, _info = model.transcribe(  # type: ignore[attr-defined]
            path,
            language=language,
            beam_size=5,
        )
        parts = [seg.text for seg in segments]
        return "".join(parts).strip()

    async def transcribe(
        self,
        audio_bytes: bytes,
        language: str = "pt",
    ) -> str:
        """Transcribe an audio blob. Returns the recognized text.

        Uses a NamedTemporaryFile to hand the bytes to ffmpeg via a
        path (faster-whisper / ctranslate2 don't accept raw webm from
        a BytesIO). Runs the blocking call on a worker thread.
        """
        if not audio_bytes:
            return ""

        # suffix=".webm" is a hint for the occasional tool that sniffs
        # extensions; ffmpeg probes the container regardless.
        tmp = tempfile.NamedTemporaryFile(
            prefix="aura-stt-", suffix=".webm", delete=False,
        )
        path = tmp.name
        try:
            tmp.write(audio_bytes)
            tmp.flush()
            tmp.close()
            text = await asyncio.to_thread(
                self._transcribe_blocking, path, language,
            )
            return text
        finally:
            try:
                os.unlink(path)
            except OSError:
                pass
