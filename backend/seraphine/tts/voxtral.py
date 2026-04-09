"""TTSAdapter for Voxtral 4B TTS via the second-state/voxtral_tts_rs server.

The server exposes an OpenAI-compatible /v1/audio/speech endpoint with two
output modes:

  - Non-streaming: returns a binary body in the requested format (wav, pcm,
    mp3, flac, ogg, opus).
  - Streaming SSE (`stream: true`): emits frames of the form
        data: {"type":"speech.audio.delta","delta":"<base64 16-bit LE PCM>"}
        data: {"type":"speech.audio.done"}

We always request streaming PCM and decode the base64 chunks back to raw
bytes so the rest of the pipeline (spec 002) sees PCM s16le @ 24 kHz mono.

The same adapter works against any OpenAI-compatible TTS server (e.g. the
Mistral hosted API or mlx-omni-server) — only the base URL and voice id
change. That preserves the seam from the original plan.
"""

from __future__ import annotations

import base64
import json
from collections.abc import AsyncIterator

import httpx

from seraphine.tts.base import TTSAdapter


class TTSUnavailableError(Exception):
    pass


class VoxtralTTSAdapter(TTSAdapter):
    def __init__(
        self,
        base_url: str,
        *,
        default_voice_id: str = "pt_female",
        model: str = "voxtral-4b-tts",
        timeout: float = 120.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.default_voice_id = default_voice_id
        self.model = model
        self.timeout = timeout
        self._client = httpx.AsyncClient(base_url=self.base_url, timeout=timeout)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def synthesize_stream(  # type: ignore[override]
        self,
        text: str | AsyncIterator[str],
        *,
        voice_id: str | None = None,
    ) -> AsyncIterator[bytes]:
        if isinstance(text, str):
            full_text = text
        else:
            parts: list[str] = []
            async for chunk in text:
                parts.append(chunk)
            full_text = "".join(parts)

        body = {
            "model": self.model,
            "input": full_text,
            "voice": voice_id if voice_id is not None else self.default_voice_id,
            "response_format": "pcm",
            "stream": True,
        }

        try:
            async with self._client.stream(
                "POST",
                "/v1/audio/speech",
                json=body,
                headers={"Accept": "text/event-stream"},
            ) as resp:
                resp.raise_for_status()
                async for raw_line in resp.aiter_lines():
                    if not raw_line or not raw_line.startswith("data:"):
                        continue
                    payload = raw_line[5:].strip()
                    if not payload or payload == "[DONE]":
                        continue
                    try:
                        event = json.loads(payload)
                    except json.JSONDecodeError:
                        continue
                    etype = event.get("type")
                    if etype == "speech.audio.delta":
                        b64 = event.get("delta")
                        if not isinstance(b64, str):
                            continue
                        try:
                            chunk = base64.b64decode(b64)
                        except (ValueError, base64.binascii.Error):
                            continue
                        if chunk:
                            yield chunk
                    elif etype == "speech.audio.done":
                        return
                    elif etype == "error":
                        raise TTSUnavailableError(
                            event.get("message", "voxtral server error")
                        )
        except httpx.HTTPError as e:
            raise TTSUnavailableError(str(e)) from e
