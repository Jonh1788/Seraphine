"""TTSAdapter for Voxtral 4B TTS via any OpenAI-compatible /v1/audio/speech
server. Two streaming wire formats are supported and auto-detected from
the response Content-Type header:

1) **SSE base64 PCM** (e.g. second-state/voxtral_tts_rs Rust server)
       content-type: text/event-stream
       data: {"type":"speech.audio.delta","delta":"<b64 s16le PCM>"}
       data: {"type":"speech.audio.done"}
   The voxtral_tts_rs v0.1.1 server emits delta frames without the
   `type` field, so the parser tolerates `{"delta":"..."}` too.

2) **Raw PCM chunked** (e.g. vllm-omni serving mistralai/Voxtral-4B-TTS-2603)
       content-type: audio/pcm  +  transfer-encoding: chunked
   The body is the raw 16-bit LE 24 kHz mono PCM stream itself, no
   envelope. We forward the bytes directly via aiter_bytes().

In both cases the rest of the pipeline (spec 002) sees PCM s16le @ 24 kHz
mono on the TTSAdapter.synthesize_stream() async iterator. Switching
between a local Apple Silicon server and a remote CUDA box only requires
changing tts_base_url — no code changes.
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
                headers={"Accept": "text/event-stream, audio/pcm"},
            ) as resp:
                resp.raise_for_status()
                ctype = (resp.headers.get("content-type") or "").lower()
                if "event-stream" in ctype:
                    async for chunk in self._iter_sse_pcm(resp):
                        yield chunk
                else:
                    # Raw chunked audio body (vllm-omni / mlx-omni-server).
                    # Bytes ARE PCM s16le @ 24 kHz mono — forward directly.
                    async for chunk in resp.aiter_bytes():
                        if chunk:
                            yield chunk
        except httpx.HTTPError as e:
            raise TTSUnavailableError(str(e)) from e

    async def _iter_sse_pcm(self, resp: httpx.Response) -> AsyncIterator[bytes]:
        """Parse the voxtral_tts_rs SSE wire format and yield raw PCM."""
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
            # voxtral_tts_rs v0.1.1 emits delta frames without `type`, so
            # be tolerant of plain `{"delta": "<b64>"}` as well.
            etype = event.get("type")
            if etype == "speech.audio.done":
                return
            if etype == "error":
                raise TTSUnavailableError(
                    event.get("message", "voxtral server error")
                )
            b64 = event.get("delta")
            if not isinstance(b64, str):
                continue
            try:
                chunk = base64.b64decode(b64)
            except (ValueError, base64.binascii.Error):
                continue
            if chunk:
                yield chunk
