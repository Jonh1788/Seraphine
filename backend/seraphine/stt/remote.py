"""Remote speech-to-text adapter.

Talks to the Whisper HTTP service spec'd in `specs/007-remote-whisper-rtx.md`
and running on the RTX box (default `http://192.168.15.6:8012`). Mirrors
the shape of :class:`seraphine.stt.whisper.WhisperSTT` so it can be dropped
into the same call sites (AudioEngine, WS audio_end handler) via the
`stt_backend` env switch.

Wire format (matches the spec exactly):

    POST /transcribe
      Content-Type: audio/pcm
      X-Sample-Rate: 16000
      X-Language: pt
      Body: raw s16le mono bytes

    200 {"text":"...","language":"pt","duration_seconds":3.24, ...}

We post PCM as-is — no WAV framing, no base64 — matching the existing
browser pipeline (MicCapture emits 16 kHz s16le mono). The service handles
any resampling if the sample rate differs.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from seraphine.stt.whisper import STTUnavailableError, Transcription

logger = logging.getLogger("seraphine.stt.remote")


class RemoteWhisperSTT:
    """HTTP client for the remote Whisper STT service."""

    def __init__(
        self,
        *,
        base_url: str,
        language: str | None = "pt",
        timeout: float = 10.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.language = language
        self.timeout = timeout
        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            timeout=timeout,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def warmup(self) -> None:
        """Ping /health so the caller can assert reachability at startup.

        Errors are swallowed — the bootstrap layer does its own reachability
        check with louder failure semantics. We just want the httpx client
        to have a live connection to the box.
        """
        try:
            r = await self._client.get("/health", timeout=5.0)
            r.raise_for_status()
            data = r.json()
            logger.info(
                "remote whisper OK: model=%s device=%s warm=%s",
                data.get("model"),
                data.get("device"),
                data.get("warm"),
            )
        except Exception as e:  # pragma: no cover
            logger.warning("remote whisper warmup failed: %s", e)

    async def transcribe(
        self, pcm_bytes: bytes, sample_rate: int = 16000
    ) -> Transcription:
        """POST raw PCM to the remote service, return a :class:`Transcription`.

        Matches :meth:`WhisperSTT.transcribe` signature exactly so callers
        don't care which backend is wired.
        """
        if not pcm_bytes:
            return Transcription(text="", duration_seconds=0.0)

        headers: dict[str, str] = {
            "Content-Type": "audio/pcm",
            "X-Sample-Rate": str(sample_rate),
        }
        if self.language:
            headers["X-Language"] = self.language

        try:
            resp = await self._client.post(
                "/transcribe",
                content=pcm_bytes,
                headers=headers,
            )
        except httpx.ConnectError as e:
            raise STTUnavailableError(
                f"remote whisper unreachable at {self.base_url}: {e}"
            ) from e
        except httpx.HTTPError as e:
            raise STTUnavailableError(
                f"remote whisper request failed: {e}"
            ) from e

        if resp.status_code == 503:
            raise STTUnavailableError(
                "remote whisper still warming up (503) — retry in a few seconds"
            )
        if resp.status_code >= 400:
            body = resp.text[:200]
            raise STTUnavailableError(
                f"remote whisper HTTP {resp.status_code}: {body}"
            )

        try:
            data: Any = resp.json()
        except ValueError as e:
            raise STTUnavailableError(
                f"remote whisper response was not JSON: {e}"
            ) from e

        if not isinstance(data, dict):
            raise STTUnavailableError(
                f"remote whisper response shape unexpected: {type(data).__name__}"
            )

        return Transcription(
            text=str(data.get("text", "")).strip(),
            language=data.get("language") or None,
            duration_seconds=float(data.get("duration_seconds", 0.0) or 0.0),
        )
