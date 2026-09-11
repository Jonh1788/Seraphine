"""Task 2: per-call token usage capture in the LLM adapters via an OPTIONAL
telemetry sink.

The sink is a plain ``Callable[[dict], None]`` (default ``None``). When ``None``
the adapters emit nothing and behave identically to before — this is what keeps
Aura (which shares ``packages/llm-adapters``) completely unaffected.

Covered here:
  - ``AnthropicClient.tool_call_json`` emits one usage record from the response
    ``usage`` block (backend derived from base_url);
  - ``telemetry=None`` is a true no-op (no crash, sink never called);
  - ``AnthropicClient._emit_usage`` shape + backend derivation (cliproxy vs
    api.anthropic.com) and int-coercion / try-except safety;
  - ``AnthropicClient.chat`` streaming usage captured from ``message_start``
    (input) + final ``message_delta`` (cumulative output);
  - ``OpenRouterChatClient.chat`` emits ``prompt_tokens``/``completion_tokens``
    mapped to ``input_tokens``/``output_tokens`` from the stream's usage frame.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
import respx

from llm_adapters.anthropic import AnthropicClient
from llm_adapters.types import ChatMessage
from seraphine.deepsearch.providers import OpenRouterChatClient


# ----------------------------------------------------------------------
# helpers
# ----------------------------------------------------------------------

def _sse(events: list[dict[str, Any]]) -> bytes:
    """Anthropic wire format: ``event: <type>\ndata: <json>\n\n`` per event."""
    parts: list[str] = []
    for evt in events:
        parts.append(f"event: {evt['type']}")
        parts.append(f"data: {json.dumps(evt)}")
        parts.append("")
        parts.append("")
    return "\n".join(parts).encode("utf-8")


def _make_client(handler, *, telemetry=None, base_url: str | None = None) -> AnthropicClient:
    kwargs: dict[str, Any] = {"api_key": "test-key", "model": "claude-sonnet-4-6"}
    if base_url is not None:
        kwargs["base_url"] = base_url
    if telemetry is not None:
        kwargs["telemetry"] = telemetry
    client = AnthropicClient(**kwargs)
    client._client = httpx.AsyncClient(
        base_url=client.base_url,
        headers={
            "x-api-key": "test-key",
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        transport=httpx.MockTransport(handler),
    )
    return client


# ----------------------------------------------------------------------
# AnthropicClient.tool_call_json — non-streaming capture
# ----------------------------------------------------------------------

@pytest.mark.asyncio
async def test_tool_call_json_emits_usage_to_sink() -> None:
    records: list[dict] = []
    sink = records.append

    def handler(request: httpx.Request) -> httpx.Response:
        body = {
            "content": [{"type": "tool_use", "name": "t", "input": {}}],
            "usage": {"input_tokens": 10, "output_tokens": 20},
        }
        return httpx.Response(200, json=body)

    tool = {"name": "t", "description": "x", "input_schema": {"type": "object", "properties": {}}}
    client = _make_client(handler, telemetry=sink)
    try:
        out = await client.tool_call_json(system="s", user="u", tool=tool)
    finally:
        await client.aclose()

    assert out == {}
    assert len(records) == 1
    # base_url defaults to api.anthropic.com → backend 'anthropic'.
    assert records[0] == {
        "backend": "anthropic",
        "model": "claude-sonnet-4-6",
        "input_tokens": 10,
        "output_tokens": 20,
    }


@pytest.mark.asyncio
async def test_tool_call_json_no_telemetry_is_noop() -> None:
    records: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = {
            "content": [{"type": "tool_use", "name": "t", "input": {}}],
            "usage": {"input_tokens": 10, "output_tokens": 20},
        }
        return httpx.Response(200, json=body)

    tool = {"name": "t", "description": "x", "input_schema": {"type": "object", "properties": {}}}
    client = _make_client(handler, telemetry=None)  # no sink → Aura-safe no-op
    try:
        out = await client.tool_call_json(system="s", user="u", tool=tool)
    finally:
        await client.aclose()

    assert out == {}
    assert records == []


# ----------------------------------------------------------------------
# AnthropicClient._emit_usage — unit (shape + backend derivation + safety)
# ----------------------------------------------------------------------

def test_emit_usage_backend_anthropic_for_public_base_url() -> None:
    records: list[dict] = []
    client = AnthropicClient(
        api_key="k", model="claude-opus-4-8",
        base_url="https://api.anthropic.com", telemetry=records.append,
    )
    client._emit_usage("claude-opus-4-8", 3, 9)
    assert records == [
        {"backend": "anthropic", "model": "claude-opus-4-8",
         "input_tokens": 3, "output_tokens": 9}
    ]


def test_emit_usage_backend_cliproxy_for_localhost_base_urls() -> None:
    for url in (
        "http://127.0.0.1:8317",
        "http://localhost:8317",
        "http://cliproxy:8317",
    ):
        records: list[dict] = []
        client = AnthropicClient(
            api_key="k", model="claude-haiku-4-5",
            base_url=url, telemetry=records.append,
        )
        client._emit_usage("claude-haiku-4-5", 1, 2)
        assert records == [
            {"backend": "cliproxy", "model": "claude-haiku-4-5",
             "input_tokens": 1, "output_tokens": 2}
        ], f"expected cliproxy backend for {url}"


def test_emit_usage_coerces_none_tokens_to_zero() -> None:
    records: list[dict] = []
    client = AnthropicClient(
        api_key="k", model="m", base_url="https://api.anthropic.com",
        telemetry=records.append,
    )
    client._emit_usage("m", None, None)
    assert records == [
        {"backend": "anthropic", "model": "m", "input_tokens": 0, "output_tokens": 0}
    ]


def test_emit_usage_no_sink_is_noop() -> None:
    client = AnthropicClient(api_key="k", model="m")  # telemetry defaults to None
    # must not raise and must do nothing observable
    client._emit_usage("m", 5, 5)


def test_emit_usage_swallows_sink_exceptions() -> None:
    def boom(_rec: dict) -> None:
        raise RuntimeError("sink exploded")

    client = AnthropicClient(
        api_key="k", model="m", base_url="https://api.anthropic.com", telemetry=boom,
    )
    # telemetry must NEVER break a call — exception is swallowed.
    client._emit_usage("m", 1, 1)


# ----------------------------------------------------------------------
# AnthropicClient.chat — streaming capture (message_start + message_delta)
# ----------------------------------------------------------------------

@pytest.mark.asyncio
async def test_chat_streaming_emits_usage_from_message_start_and_delta() -> None:
    records: list[dict] = []
    sink = records.append

    def handler(request: httpx.Request) -> httpx.Response:
        events = [
            {"type": "message_start", "message": {"id": "m1", "usage": {"input_tokens": 42}}},
            {"type": "content_block_start", "index": 0, "content_block": {"type": "text"}},
            {"type": "content_block_delta", "index": 0,
             "delta": {"type": "text_delta", "text": "hi"}},
            {"type": "content_block_stop", "index": 0},
            # cumulative output_tokens arrives on the final message_delta
            {"type": "message_delta", "delta": {"stop_reason": "end_turn"},
             "usage": {"output_tokens": 99}},
            {"type": "message_stop"},
        ]
        return httpx.Response(
            200, content=_sse(events), headers={"content-type": "text/event-stream"}
        )

    client = _make_client(handler, telemetry=sink)
    try:
        async for _ in client.chat([ChatMessage(role="user", content="oi")]):
            pass
    finally:
        await client.aclose()

    assert records == [
        {
            "backend": "anthropic",
            "model": "claude-sonnet-4-6",
            "input_tokens": 42,
            "output_tokens": 99,
        }
    ]


@pytest.mark.asyncio
async def test_chat_streaming_no_telemetry_is_noop() -> None:
    records: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        events = [
            {"type": "message_start", "message": {"id": "m1", "usage": {"input_tokens": 42}}},
            {"type": "message_delta", "delta": {"stop_reason": "end_turn"},
             "usage": {"output_tokens": 99}},
            {"type": "message_stop"},
        ]
        return httpx.Response(
            200, content=_sse(events), headers={"content-type": "text/event-stream"}
        )

    client = _make_client(handler, telemetry=None)
    try:
        async for _ in client.chat([ChatMessage(role="user", content="oi")]):
            pass
    finally:
        await client.aclose()

    assert records == []


@pytest.mark.asyncio
async def test_chat_streaming_tool_use_path_emits_usage() -> None:
    """The early-return tool_use path must still emit usage."""
    records: list[dict] = []
    sink = records.append

    def handler(request: httpx.Request) -> httpx.Response:
        events = [
            {"type": "message_start", "message": {"id": "m1", "usage": {"input_tokens": 11}}},
            {"type": "content_block_start", "index": 0,
             "content_block": {"type": "tool_use", "id": "toolu_1", "name": "t"}},
            {"type": "content_block_delta", "index": 0,
             "delta": {"type": "input_json_delta", "partial_json": "{}"}},
            {"type": "content_block_stop", "index": 0},
            {"type": "message_delta", "delta": {"stop_reason": "tool_use"},
             "usage": {"output_tokens": 22}},
            {"type": "message_stop"},
        ]
        return httpx.Response(
            200, content=_sse(events), headers={"content-type": "text/event-stream"}
        )

    tools = [{
        "type": "function",
        "function": {"name": "t", "description": "x",
                     "parameters": {"type": "object", "properties": {}}},
    }]
    client = _make_client(handler, telemetry=sink)
    try:
        async for _ in client.chat(
            [ChatMessage(role="user", content="go")], tools=tools
        ):
            pass
    finally:
        await client.aclose()

    assert records == [
        {
            "backend": "anthropic",
            "model": "claude-sonnet-4-6",
            "input_tokens": 11,
            "output_tokens": 22,
        }
    ]


# ----------------------------------------------------------------------
# OpenRouterChatClient.chat — streaming usage capture
# ----------------------------------------------------------------------

def _or_sse(*lines: str) -> bytes:
    return ("\n".join([*lines, ""])).encode("utf-8")


@pytest.mark.asyncio
@respx.mock
async def test_openrouter_chat_emits_usage_to_sink() -> None:
    records: list[dict] = []
    sink = records.append

    body = _or_sse(
        'data: {"choices":[{"delta":{"content":"hi"}}]}',
        # OpenRouter sends a final usage frame (usually with empty choices).
        'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":34}}',
        "data: [DONE]",
    )
    respx.post("https://openrouter.ai/api/v1/chat/completions").mock(
        return_value=httpx.Response(
            200, headers={"content-type": "text/event-stream"}, content=body
        )
    )

    c = OpenRouterChatClient(api_key="sk-or-x", telemetry=sink)
    async for _ in c.chat(
        [ChatMessage(role="user", content="oi")], model="openai/gpt-4o-mini"
    ):
        pass

    assert records == [
        {
            "backend": "openrouter",
            "model": "openai/gpt-4o-mini",
            "input_tokens": 12,
            "output_tokens": 34,
            # Cache de prompt: zero quando o usage não traz os contadores.
            "cache_read_tokens": 0,
            "cache_write_tokens": 0,
        }
    ]


@pytest.mark.asyncio
@respx.mock
async def test_openrouter_chat_no_telemetry_is_noop() -> None:
    records: list[dict] = []

    body = _or_sse(
        'data: {"choices":[{"delta":{"content":"hi"}}]}',
        'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":34}}',
        "data: [DONE]",
    )
    respx.post("https://openrouter.ai/api/v1/chat/completions").mock(
        return_value=httpx.Response(
            200, headers={"content-type": "text/event-stream"}, content=body
        )
    )

    c = OpenRouterChatClient(api_key="sk-or-x")  # telemetry defaults to None
    async for _ in c.chat(
        [ChatMessage(role="user", content="oi")], model="openai/gpt-4o-mini"
    ):
        pass

    assert records == []
