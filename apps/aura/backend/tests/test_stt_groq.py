"""GroqSTTService — covers happy path, error mapping, language hint."""

from __future__ import annotations

import httpx
import pytest

from aura.stt.groq_service import GroqSTTError, GroqSTTService


@pytest.fixture
def mock_transport():
    """Capture the last request the service sent + drive the response."""

    captured: dict = {}

    def handler(req: httpx.Request) -> httpx.Response:
        captured["url"] = str(req.url)
        captured["auth"] = req.headers.get("authorization")
        # multipart bodies are streamed; just snapshot raw bytes for now.
        captured["body"] = req.content
        return captured.get("response") or httpx.Response(
            200, json={"text": " Olá mundo "},
        )

    return captured, httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
    )


@pytest.mark.asyncio
async def test_transcribe_happy_path(mock_transport):
    captured, http = mock_transport
    svc = GroqSTTService(api_key="k", http_client=http)

    text = await svc.transcribe(b"fake-audio-bytes", language="pt")
    assert text == "Olá mundo"
    assert captured["auth"] == "Bearer k"
    assert "/audio/transcriptions" in captured["url"]
    # Body should mention the model + language as form fields.
    body = captured["body"] or b""
    assert b"whisper-large-v3-turbo" in body
    assert b"pt" in body


@pytest.mark.asyncio
async def test_transcribe_empty_audio_short_circuits(mock_transport):
    _captured, http = mock_transport
    svc = GroqSTTService(api_key="k", http_client=http)
    assert await svc.transcribe(b"") == ""


@pytest.mark.asyncio
async def test_transcribe_raises_on_non_2xx(mock_transport):
    captured, http = mock_transport
    captured["response"] = httpx.Response(429, json={"error": "rate_limited"})
    svc = GroqSTTService(api_key="k", http_client=http)
    with pytest.raises(GroqSTTError) as ei:
        await svc.transcribe(b"audio")
    assert ei.value.status_code == 429


@pytest.mark.asyncio
async def test_transcribe_raises_on_missing_text_field(mock_transport):
    captured, http = mock_transport
    captured["response"] = httpx.Response(200, json={"unexpected": "shape"})
    svc = GroqSTTService(api_key="k", http_client=http)
    with pytest.raises(GroqSTTError):
        await svc.transcribe(b"audio")


def test_rejects_empty_key():
    with pytest.raises(ValueError):
        GroqSTTService(api_key="")
