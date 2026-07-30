"""Testes do transporte da casa.

O transporte nunca abre conexão: ele delega ao cliente Tauri pelo broker
de proxy. Aqui o broker é substituído por uma função falsa que grava os
args e devolve o ToolResult combinado.
"""

from __future__ import annotations

import base64
from typing import Any

import pytest

from seraphine.home.transport import (
    DEFAULT_BASE,
    HomeHTTPError,
    HomeUnreachable,
    LanTransport,
)
from seraphine.tools.base import ToolResult


class FakeProxy:
    """Substitui `_proxy_tool_via_client`, gravando a última chamada."""

    def __init__(self, result: ToolResult) -> None:
        self.result = result
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def __call__(
        self, app_state: Any, tool_name: str, tool_args: dict[str, Any]
    ) -> ToolResult:
        self.calls.append((tool_name, tool_args))
        return self.result


@pytest.fixture()
def patch_proxy(monkeypatch):
    def _install(result: ToolResult) -> FakeProxy:
        fake = FakeProxy(result)
        monkeypatch.setattr(
            "seraphine.conversation.engine._proxy_tool_via_client", fake
        )
        return fake

    return _install


async def test_get_returns_the_decoded_json_body(patch_proxy):
    patch_proxy(
        ToolResult(ok=True, output='{"volume": 0.5}', metadata={"status": 200})
    )
    t = LanTransport(app_state=object())
    assert await t.request("GET", "/api/status") == {"volume": 0.5}


async def test_it_calls_the_lan_request_capability_not_a_tool(patch_proxy):
    fake = patch_proxy(ToolResult(ok=True, output="{}", metadata={"status": 200}))
    t = LanTransport(app_state=object())
    await t.request("POST", "/api/next", json_body={})
    tool_name, args = fake.calls[0]
    assert tool_name == "lan_request"
    assert args["base"] == DEFAULT_BASE
    assert args["method"] == "POST"
    assert args["path"] == "/api/next"


async def test_audio_travels_as_base64_with_a_filename(patch_proxy):
    fake = patch_proxy(ToolResult(ok=True, output="{}", metadata={"status": 200}))
    t = LanTransport(app_state=object())
    await t.request("POST", "/api/announce", audio=b"RIFFdata", audio_filename="a.ogg")
    _, args = fake.calls[0]
    assert base64.b64decode(args["audio_b64"]) == b"RIFFdata"
    assert args["audio_filename"] == "a.ogg"
    assert "json" not in args


async def test_a_device_error_status_raises_home_http_error(patch_proxy):
    patch_proxy(
        ToolResult(
            ok=False,
            output='{"error": "nada encontrado"}',
            error="HTTP 404",
            metadata={"status": 404},
        )
    )
    t = LanTransport(app_state=object())
    with pytest.raises(HomeHTTPError) as exc:
        await t.request("POST", "/api/play", json_body={"query": "x"})
    assert exc.value.status == 404
    assert "nada encontrado" in exc.value.body


async def test_a_redirect_is_an_answer_from_the_device_not_unreachability(patch_proxy):
    """O relé não segue redirect: um 3xx é resposta do aparelho.

    Se caísse no ramo de `not ok`, a tool diria "não alcanço a casa" para
    um aparelho que respondeu.
    """
    patch_proxy(
        ToolResult(ok=False, output="", error="HTTP 302", metadata={"status": 302})
    )
    t = LanTransport(app_state=object())
    with pytest.raises(HomeHTTPError) as exc:
        await t.request("GET", "/api/status")
    assert exc.value.status == 302


async def test_no_client_connected_raises_home_unreachable(patch_proxy):
    patch_proxy(
        ToolResult(
            ok=False,
            error="tool 'lan_request' needs a Mac client but no Tauri WebSocket is connected",
        )
    )
    t = LanTransport(app_state=object())
    with pytest.raises(HomeUnreachable):
        await t.request("GET", "/api/status")


async def test_an_empty_body_decodes_to_an_empty_dict(patch_proxy):
    patch_proxy(ToolResult(ok=True, output="", metadata={"status": 204}))
    t = LanTransport(app_state=object())
    assert await t.request("POST", "/api/mute", json_body={}) == {}


async def test_a_non_json_body_is_returned_raw(patch_proxy):
    patch_proxy(ToolResult(ok=True, output="pong", metadata={"status": 200}))
    t = LanTransport(app_state=object())
    assert await t.request("GET", "/api/ping") == {"raw": "pong"}
