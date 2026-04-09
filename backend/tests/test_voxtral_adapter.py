from __future__ import annotations

import base64
import json

import httpx
import pytest

from seraphine.tts.voxtral import TTSUnavailableError, VoxtralTTSAdapter


def _sse(event: dict) -> bytes:
    return f"data: {json.dumps(event)}\n\n".encode("utf-8")


@pytest.mark.asyncio
async def test_voxtral_streams_pcm_chunks() -> None:
    chunks_pcm = [b"\x00\x01\x02\x03", b"\x04\x05\x06\x07"]
    body = b"".join(
        _sse({"type": "speech.audio.delta", "delta": base64.b64encode(c).decode()})
        for c in chunks_pcm
    ) + _sse({"type": "speech.audio.done"})

    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            200, content=body, headers={"content-type": "text/event-stream"}
        )

    transport = httpx.MockTransport(handler)
    adapter = VoxtralTTSAdapter("http://x")
    adapter._client = httpx.AsyncClient(base_url="http://x", transport=transport)
    try:
        out: list[bytes] = []
        async for chunk in adapter.synthesize_stream("olá"):
            out.append(chunk)
    finally:
        await adapter.aclose()

    assert out == chunks_pcm
    assert captured["url"].endswith("/v1/audio/speech")
    assert captured["body"]["input"] == "olá"
    assert captured["body"]["voice"] == "pt_female"
    assert captured["body"]["response_format"] == "pcm"
    assert captured["body"]["stream"] is True


@pytest.mark.asyncio
async def test_voxtral_accepts_typeless_delta_frames() -> None:
    """The voxtral_tts_rs server v0.1.1 emits delta frames without `type`,
    only `{"delta": "<b64>"}`. The adapter must still decode them."""
    chunks_pcm = [b"\xaa\xbb", b"\xcc\xdd"]
    body = b"".join(
        _sse({"delta": base64.b64encode(c).decode()}) for c in chunks_pcm
    ) + _sse({"type": "speech.audio.done"})

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})

    adapter = VoxtralTTSAdapter("http://x")
    adapter._client = httpx.AsyncClient(base_url="http://x", transport=httpx.MockTransport(handler))
    try:
        out = [c async for c in adapter.synthesize_stream("oi")]
    finally:
        await adapter.aclose()
    assert out == chunks_pcm


@pytest.mark.asyncio
async def test_voxtral_voice_override() -> None:
    body = _sse({"type": "speech.audio.delta", "delta": base64.b64encode(b"\x00").decode()}) + _sse(
        {"type": "speech.audio.done"}
    )
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})

    adapter = VoxtralTTSAdapter("http://x")
    adapter._client = httpx.AsyncClient(base_url="http://x", transport=httpx.MockTransport(handler))
    try:
        async for _ in adapter.synthesize_stream("oi", voice_id="pt_male"):
            pass
    finally:
        await adapter.aclose()
    assert captured["body"]["voice"] == "pt_male"


@pytest.mark.asyncio
async def test_voxtral_handles_error_event() -> None:
    body = _sse({"type": "error", "message": "boom"})

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})

    adapter = VoxtralTTSAdapter("http://x")
    adapter._client = httpx.AsyncClient(base_url="http://x", transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(TTSUnavailableError, match="boom"):
            async for _ in adapter.synthesize_stream("oi"):
                pass
    finally:
        await adapter.aclose()


@pytest.mark.asyncio
async def test_voxtral_handles_http_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="upstream down")

    adapter = VoxtralTTSAdapter("http://x")
    adapter._client = httpx.AsyncClient(base_url="http://x", transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(TTSUnavailableError):
            async for _ in adapter.synthesize_stream("oi"):
                pass
    finally:
        await adapter.aclose()
