from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from seraphine.tts.elevenlabs import ElevenLabsAdapter, ElevenLabsUnavailableError


def _make_adapter(handler, **overrides: Any) -> ElevenLabsAdapter:
    kwargs = {"api_key": "xi-test", "voice_id": "voice-1"}
    kwargs.update(overrides)
    adapter = ElevenLabsAdapter(**kwargs)
    adapter._client = httpx.AsyncClient(
        base_url=adapter.base_url,
        headers={
            "xi-api-key": adapter.api_key,
            "content-type": "application/json",
            "accept": "audio/pcm",
        },
        transport=httpx.MockTransport(handler),
    )
    return adapter


@pytest.mark.asyncio
async def test_elevenlabs_posts_correct_url_headers_body() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["method"] = request.method
        captured["headers"] = dict(request.headers)
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, content=b"\x00\x01\x02\x03")

    adapter = _make_adapter(handler)
    try:
        out = b"".join(
            [c async for c in adapter.synthesize_stream("oi mundo")]
        )
    finally:
        await adapter.aclose()

    assert out == b"\x00\x01\x02\x03"
    assert captured["method"] == "POST"
    assert "/v1/text-to-speech/voice-1/stream" in captured["url"]
    assert "output_format=pcm_24000" in captured["url"]
    assert "optimize_streaming_latency=" in captured["url"]
    assert captured["headers"]["xi-api-key"] == "xi-test"
    body = captured["body"]
    assert body["text"] == "oi mundo"
    assert body["model_id"] == "eleven_turbo_v2_5"
    assert body["voice_settings"] == {
        "stability": 0.35,
        "similarity_boost": 0.75,
        "speed": 1.15,
    }


@pytest.mark.asyncio
async def test_elevenlabs_yields_pcm_chunks_in_order() -> None:
    expected_chunks = [b"\x00\x01", b"\x02\x03", b"\x04\x05"]

    def handler(request: httpx.Request) -> httpx.Response:
        # httpx.MockTransport doesn't stream across multiple chunks at the
        # wire level, but aiter_bytes will yield the full body as one chunk
        # if it's delivered atomically. Here we emit a single contiguous
        # byte string and assert that all the expected bytes round-trip.
        return httpx.Response(200, content=b"".join(expected_chunks))

    adapter = _make_adapter(handler)
    try:
        out: list[bytes] = []
        async for chunk in adapter.synthesize_stream("oi"):
            out.append(chunk)
    finally:
        await adapter.aclose()
    assert b"".join(out) == b"".join(expected_chunks)
    # At least one non-empty chunk was yielded
    assert len(out) >= 1
    assert all(len(c) > 0 for c in out)


@pytest.mark.asyncio
async def test_elevenlabs_voice_override() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        return httpx.Response(200, content=b"\x00")

    adapter = _make_adapter(handler)
    try:
        async for _ in adapter.synthesize_stream("oi", voice_id="voice-2"):
            pass
    finally:
        await adapter.aclose()
    assert "/v1/text-to-speech/voice-2/stream" in captured["url"]


@pytest.mark.asyncio
async def test_elevenlabs_skips_empty_input() -> None:
    called = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        called["n"] += 1
        return httpx.Response(200, content=b"\x00")

    adapter = _make_adapter(handler)
    try:
        out = [c async for c in adapter.synthesize_stream("   ")]
    finally:
        await adapter.aclose()
    assert out == []
    assert called["n"] == 0


@pytest.mark.asyncio
async def test_elevenlabs_401_raises_clear_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"detail": "invalid key"})

    adapter = _make_adapter(handler)
    try:
        with pytest.raises(ElevenLabsUnavailableError, match="401"):
            async for _ in adapter.synthesize_stream("oi"):
                pass
    finally:
        await adapter.aclose()


@pytest.mark.asyncio
async def test_elevenlabs_429_raises_clear_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, json={"detail": "rate limited"})

    adapter = _make_adapter(handler)
    try:
        with pytest.raises(ElevenLabsUnavailableError, match="429|rate limit"):
            async for _ in adapter.synthesize_stream("oi"):
                pass
    finally:
        await adapter.aclose()


@pytest.mark.asyncio
async def test_elevenlabs_connection_error_raises_clear_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    adapter = _make_adapter(handler)
    try:
        with pytest.raises(ElevenLabsUnavailableError):
            async for _ in adapter.synthesize_stream("oi"):
                pass
    finally:
        await adapter.aclose()


def test_elevenlabs_requires_voice_id() -> None:
    with pytest.raises(ValueError, match="voice_id"):
        ElevenLabsAdapter(api_key="x", voice_id="")
