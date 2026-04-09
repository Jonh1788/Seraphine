from __future__ import annotations

from collections.abc import AsyncIterator

import httpx

from seraphine.tts.base import TTSAdapter


class TTSUnavailableError(Exception):
    pass


class MossTTSAdapter(TTSAdapter):
    def __init__(
        self,
        base_url: str,
        *,
        default_voice_id: str | None = None,
        timeout: float = 60.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.default_voice_id = default_voice_id
        self.timeout = timeout
        self._client: httpx.AsyncClient = httpx.AsyncClient(
            base_url=self.base_url, timeout=timeout
        )

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
            "text": full_text,
            "voice_id": voice_id if voice_id is not None else self.default_voice_id,
            "format": "pcm_s16le",
            "sample_rate": 24000,
        }

        try:
            async with self._client.stream("POST", "/v1/synthesize", json=body) as resp:
                resp.raise_for_status()
                async for chunk in resp.aiter_bytes():
                    if chunk:
                        yield chunk
        except httpx.HTTPError as e:
            raise TTSUnavailableError(str(e)) from e


class FakeTTSAdapter(TTSAdapter):
    def __init__(self, chunks: list[bytes]) -> None:
        self.chunks = chunks

    async def synthesize_stream(  # type: ignore[override]
        self,
        text: str | AsyncIterator[str],
        *,
        voice_id: str | None = None,
    ) -> AsyncIterator[bytes]:
        if not isinstance(text, str):
            async for _ in text:
                pass
        for c in self.chunks:
            yield c
