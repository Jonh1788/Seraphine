from __future__ import annotations

import io
import json
import wave

import httpx
import pytest

from seraphine.tts.qwen3 import Qwen3TtsAdapter, TTSUnavailableError


def _make_wav(rate: int = 24000, channels: int = 1, sampwidth: int = 2) -> tuple[bytes, bytes]:
    """Build a 0.1s sine-ish PCM and wrap it in a RIFF/WAV container.
    Returns (wav_bytes, raw_pcm_bytes_inside)."""
    n = int(rate * 0.1)
    pcm = bytes((i & 0xFF for i in range(n * channels * sampwidth)))
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(sampwidth)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue(), pcm


@pytest.mark.asyncio
async def test_qwen3_posts_correct_body_and_extracts_pcm() -> None:
    wav, raw_pcm = _make_wav()
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, content=wav, headers={"content-type": "audio/wav"})

    adapter = Qwen3TtsAdapter("http://x")
    adapter._client = httpx.AsyncClient(
        base_url="http://x", transport=httpx.MockTransport(handler)
    )
    try:
        out = b"".join([c async for c in adapter.synthesize_stream("oi mundo")])
    finally:
        await adapter.aclose()

    assert out == raw_pcm
    assert captured["url"].endswith("/v1/audio/voice-clone")
    body = captured["body"]
    assert body["input"] == "oi mundo"
    assert body["voice"] == "dubgrav"
    assert body["language"] == "Portuguese"
    assert body["x_vector_only_mode"] is True


@pytest.mark.asyncio
async def test_qwen3_voice_override() -> None:
    wav, _ = _make_wav()
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, content=wav, headers={"content-type": "audio/wav"})

    adapter = Qwen3TtsAdapter("http://x", default_voice="dubgrav")
    adapter._client = httpx.AsyncClient(
        base_url="http://x", transport=httpx.MockTransport(handler)
    )
    try:
        async for _ in adapter.synthesize_stream("oi", voice_id="aline"):
            pass
    finally:
        await adapter.aclose()
    assert captured["body"]["voice"] == "aline"


@pytest.mark.asyncio
async def test_qwen3_rejects_wrong_sample_rate() -> None:
    wav, _ = _make_wav(rate=16000)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=wav, headers={"content-type": "audio/wav"})

    adapter = Qwen3TtsAdapter("http://x")
    adapter._client = httpx.AsyncClient(
        base_url="http://x", transport=httpx.MockTransport(handler)
    )
    try:
        with pytest.raises(TTSUnavailableError, match="sample rate 16000"):
            async for _ in adapter.synthesize_stream("oi"):
                pass
    finally:
        await adapter.aclose()


@pytest.mark.asyncio
async def test_qwen3_handles_http_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="upstream down")

    adapter = Qwen3TtsAdapter("http://x")
    adapter._client = httpx.AsyncClient(
        base_url="http://x", transport=httpx.MockTransport(handler)
    )
    try:
        with pytest.raises(TTSUnavailableError):
            async for _ in adapter.synthesize_stream("oi"):
                pass
    finally:
        await adapter.aclose()


@pytest.mark.asyncio
async def test_qwen3_skips_empty_input() -> None:
    """Empty/whitespace input should not even hit the network."""
    called = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        called["n"] += 1
        return httpx.Response(200, content=b"", headers={"content-type": "audio/wav"})

    adapter = Qwen3TtsAdapter("http://x")
    adapter._client = httpx.AsyncClient(
        base_url="http://x", transport=httpx.MockTransport(handler)
    )
    try:
        out = [c async for c in adapter.synthesize_stream("   ")]
    finally:
        await adapter.aclose()
    assert out == []
    assert called["n"] == 0
