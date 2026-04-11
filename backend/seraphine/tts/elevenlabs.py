"""TTSAdapter for ElevenLabs streaming TTS.

Streams raw PCM (s16le mono @ 24kHz) directly from ElevenLabs'
``/v1/text-to-speech/{voice_id}/stream`` endpoint using ``output_format=
pcm_24000``. That rate matches the frontend ``PCMPlayback.INPUT_RATE`` so
the bytes can flow straight through to the browser without any resampling.

Consistent with the rest of the TTS stack this adapter yields ``bytes``
chunks from ``synthesize_stream()``. It is designed to coexist with the
local :class:`Qwen3TtsAdapter` — pick whichever via
``SERAPHINE_TTS_BACKEND``.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import httpx

from seraphine.tts.base import TTSAdapter


class ElevenLabsUnavailableError(Exception):
    pass


_DEFAULT_MODEL_ID = "eleven_turbo_v2_5"
_OUTPUT_FORMAT = "pcm_24000"  # raw s16le @ 24kHz — matches PCMPlayback.INPUT_RATE


class ElevenLabsAdapter(TTSAdapter):
    def __init__(
        self,
        api_key: str,
        voice_id: str,
        *,
        model_id: str = _DEFAULT_MODEL_ID,
        base_url: str = "https://api.elevenlabs.io",
        stability: float = 0.35,
        similarity_boost: float = 0.75,
        speed: float = 1.15,
        optimize_streaming_latency: int = 3,
        timeout: float = 180.0,
    ) -> None:
        if not voice_id:
            # Fail loud at construction time rather than on the first request.
            raise ValueError(
                "ElevenLabsAdapter requires a voice_id — set SERAPHINE_ELEVENLABS_VOICE_ID"
            )
        self.api_key = api_key
        self.voice_id = voice_id
        self.model_id = model_id
        self.base_url = base_url.rstrip("/")
        self.stability = stability
        self.similarity_boost = similarity_boost
        # Server-side speed (0.7..1.2 for eleven_turbo_v2_5). Setting this
        # server-side means the frontend can play at native rate (1.0x)
        # without the pitch shift that HTMLAudioElement.playbackRate causes.
        self.speed = max(0.7, min(1.2, speed))
        # 0..4. Higher = faster TTFB at the cost of some audio quality.
        # 3 disables the text normalizer, shaving ~300-500ms off first-
        # chunk latency which is crucial for realtime feel.
        self.optimize_streaming_latency = max(0, min(4, optimize_streaming_latency))
        self.timeout = timeout
        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            timeout=timeout,
            headers={
                "xi-api-key": api_key,
                "content-type": "application/json",
                "accept": "audio/pcm",
            },
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    def _build_body(self, text: str) -> dict:
        return {
            "text": text,
            "model_id": self.model_id,
            "voice_settings": {
                "stability": self.stability,
                "similarity_boost": self.similarity_boost,
                "speed": self.speed,
            },
        }

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
        if not full_text.strip():
            return

        effective_voice = voice_id or self.voice_id
        body = self._build_body(full_text)
        url = f"/v1/text-to-speech/{effective_voice}/stream"
        # ElevenLabs honors output_format and optimize_streaming_latency
        # as query string params, not body.
        params = {
            "output_format": _OUTPUT_FORMAT,
            "optimize_streaming_latency": str(self.optimize_streaming_latency),
        }

        try:
            async with self._client.stream(
                "POST", url, json=body, params=params
            ) as resp:
                if resp.status_code == 401:
                    raise ElevenLabsUnavailableError(
                        "ElevenLabs auth failed (401) — check SERAPHINE_ELEVENLABS_API_KEY"
                    )
                if resp.status_code == 429:
                    raise ElevenLabsUnavailableError(
                        "ElevenLabs rate limit exceeded (429)"
                    )
                resp.raise_for_status()
                async for chunk in resp.aiter_bytes():
                    if chunk:
                        yield chunk
        except httpx.ConnectError as e:
            raise ElevenLabsUnavailableError(f"ElevenLabs unreachable: {e}") from e
        except httpx.HTTPStatusError as e:
            raise ElevenLabsUnavailableError(
                f"ElevenLabs HTTP {e.response.status_code}: {e}"
            ) from e
        except httpx.HTTPError as e:
            raise ElevenLabsUnavailableError(str(e)) from e
