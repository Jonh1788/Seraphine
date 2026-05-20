"""Speech-to-text service backed by Groq's hosted Whisper.

Why: Groq's whisper-large-v3-turbo finishes a 30s clip in ~250 ms with
PT-BR WER on par with self-hosted large. The API is OpenAI-compatible
multipart so the drop-in is small. We pick this over local CTranslate2
when an API key is available — see main.py for the wiring.
"""

from __future__ import annotations

import logging

import httpx

logger = logging.getLogger(__name__)


class GroqSTTError(RuntimeError):
    """Raised when Groq returns a non-2xx or a malformed transcription."""

    def __init__(self, *, status_code: int, body: str) -> None:
        self.status_code = status_code
        self.body = body
        super().__init__(f"groq stt error {status_code}: {body[:200]}")


class GroqSTTService:
    """Thin async wrapper around Groq's /audio/transcriptions endpoint.

    Implements the same ``transcribe(audio_bytes, language)`` contract
    as ``STTService`` so the chat route doesn't care which is wired.
    """

    DEFAULT_URL = "https://api.groq.com/openai/v1/audio/transcriptions"

    def __init__(
        self,
        *,
        api_key: str,
        model: str = "whisper-large-v3-turbo",
        base_url: str = DEFAULT_URL,
        timeout: float = 30.0,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        if not api_key:
            raise ValueError("GroqSTTService requires a non-empty api_key")
        self._key = api_key
        self._model = model
        self._url = base_url
        self._http = http_client or httpx.AsyncClient(timeout=timeout)
        self._owns_http = http_client is None

    async def aclose(self) -> None:
        if self._owns_http:
            await self._http.aclose()

    async def transcribe(
        self,
        audio_bytes: bytes,
        language: str = "pt",
    ) -> str:
        if not audio_bytes:
            return ""
        # Groq probes the container, so the filename suffix is just a
        # hint. MediaRecorder on Chrome/Firefox emits webm; Safari emits
        # mp4/aac. Both work.
        files = {
            "file": ("audio.webm", audio_bytes, "audio/webm"),
        }
        data = {
            "model": self._model,
            "language": language,
            "response_format": "json",
            # temperature=0 → deterministic decode, lower WER on short clips
            "temperature": "0",
        }
        headers = {"Authorization": f"Bearer {self._key}"}
        resp = await self._http.post(
            self._url, headers=headers, data=data, files=files,
        )
        if resp.status_code >= 400:
            body = resp.text or ""
            logger.warning("groq stt %d: %s", resp.status_code, body[:200])
            raise GroqSTTError(status_code=resp.status_code, body=body)
        payload = resp.json() if resp.content else {}
        text = payload.get("text") if isinstance(payload, dict) else None
        if not isinstance(text, str):
            raise GroqSTTError(
                status_code=resp.status_code,
                body=f"missing text in response: {payload!r}",
            )
        return text.strip()
