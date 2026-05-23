"""Tests for the cv_triage WhatsApp dispatch helper.

Mocks the whatsapp-bridge HTTP endpoints with respx and asserts the
helper's behaviour: text-first, sequential media, retry-then-fail
short-circuit, and per-PDF retry with backoff.
"""

import httpx
import pytest
import respx

from seraphine.cv_triage.whatsapp import (
    DispatchPayload,
    DispatchPdf,
    dispatch_to_whatsapp,
)


@pytest.mark.asyncio
@respx.mock
async def test_dispatches_text_then_media_in_order(tmp_path):
    pdf_a = tmp_path / "a.pdf"
    pdf_a.write_bytes(b"%PDF-1.4 a")
    pdf_b = tmp_path / "b.pdf"
    pdf_b.write_bytes(b"%PDF-1.4 b")
    text_route = respx.post("http://bridge/api/send").mock(
        return_value=httpx.Response(200, json={"ok": True})
    )
    media_route = respx.post("http://bridge/api/send-media").mock(
        return_value=httpx.Response(200, json={"ok": True, "id": "X"})
    )
    payload = DispatchPayload(
        chat_id="g@g.us",
        summary="Top 5...",
        pdfs=[
            DispatchPdf(rank=1, candidate_name="A", score=90, path=pdf_a, filename="a.pdf"),
            DispatchPdf(rank=2, candidate_name="B", score=80, path=pdf_b, filename="b.pdf"),
        ],
    )
    result = await dispatch_to_whatsapp(payload, bridge_url="http://bridge", sleep_between=0.0)
    assert result.text_sent is True
    assert result.media_sent == 2
    assert text_route.called and media_route.call_count == 2


@pytest.mark.asyncio
@respx.mock
async def test_text_fails_short_circuits():
    respx.post("http://bridge/api/send").mock(return_value=httpx.Response(503))
    payload = DispatchPayload(chat_id="g@g.us", summary="x", pdfs=[])
    result = await dispatch_to_whatsapp(payload, bridge_url="http://bridge", sleep_between=0.0)
    assert result.text_sent is False
    assert result.media_sent == 0
    assert result.error and "send" in result.error.lower()


@pytest.mark.asyncio
@respx.mock
async def test_media_retry_then_succeed(tmp_path):
    pdf = tmp_path / "a.pdf"
    pdf.write_bytes(b"%PDF-1.4")
    respx.post("http://bridge/api/send").mock(
        return_value=httpx.Response(200, json={"ok": True})
    )
    respx.post("http://bridge/api/send-media").mock(
        side_effect=[
            httpx.Response(500),
            httpx.Response(500),
            httpx.Response(200, json={"ok": True}),
        ]
    )
    payload = DispatchPayload(
        chat_id="g@g.us",
        summary="x",
        pdfs=[DispatchPdf(1, "A", 90, pdf, "a.pdf")],
    )
    result = await dispatch_to_whatsapp(
        payload,
        bridge_url="http://bridge",
        sleep_between=0.0,
        retry_backoff_base=0.0,
    )
    assert result.media_sent == 1
