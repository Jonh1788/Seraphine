import pytest
import httpx
from aura.whatsapp.client import EvolutionClient, EvolutionError


def _client(handler):
    transport = httpx.MockTransport(handler)
    http = httpx.AsyncClient(transport=transport, base_url="http://evo")
    return EvolutionClient(
        base_url="http://evo",
        api_key="key123",
        instance="aura-main",
        http_client=http,
    )


@pytest.mark.asyncio
async def test_send_text_success():
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["url"] = str(req.url)
        seen["headers"] = dict(req.headers)
        seen["body"] = req.read()
        return httpx.Response(200, json={"key": {"id": "MSG_ABC"}})

    client = _client(handler)
    msg_id = await client.send_text("+5511987654321", "oi")
    assert msg_id == "MSG_ABC"
    assert "/message/sendText/aura-main" in seen["url"]
    assert seen["headers"]["apikey"] == "key123"
    assert b"5511987654321" in seen["body"]
    assert b"oi" in seen["body"]


@pytest.mark.asyncio
async def test_send_text_error_maps_to_evolution_error():
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"message": "nope"})

    client = _client(handler)
    with pytest.raises(EvolutionError) as exc:
        await client.send_text("+5511987654321", "oi")
    assert exc.value.status_code == 401
    assert "nope" in exc.value.reason


@pytest.mark.asyncio
async def test_get_status_returns_connected_flag():
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"instance": {"state": "open", "wuid": "5511987654321@s.whatsapp.net"}}
        )

    client = _client(handler)
    status = await client.get_status()
    assert status["connected"] is True
    assert status["phone"] == "+5511987654321"


@pytest.mark.asyncio
async def test_get_status_disconnected():
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"instance": {"state": "close"}})

    client = _client(handler)
    status = await client.get_status()
    assert status["connected"] is False
    assert status["phone"] is None


@pytest.mark.asyncio
async def test_get_qr_returns_base64_when_present():
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"base64": "iVBORw0KGgo=AAAA"})

    client = _client(handler)
    qr = await client.get_qr()
    assert qr == "iVBORw0KGgo=AAAA"


@pytest.mark.asyncio
async def test_get_qr_returns_none_when_already_connected():
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"instance": {"state": "open"}})

    client = _client(handler)
    qr = await client.get_qr()
    assert qr is None
