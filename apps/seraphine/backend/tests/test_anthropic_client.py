from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from llm_adapters.anthropic import AnthropicClient, _convert_tools
from llm_adapters.types import ChatMessage, LLMUnavailableError, Token


def _sse(events: list[dict[str, Any]]) -> bytes:
    """Build an SSE payload in Anthropic's wire format.

    Each event is rendered as ``event: <type>\ndata: <json>\n\n``.
    """
    parts: list[str] = []
    for evt in events:
        parts.append(f"event: {evt['type']}")
        parts.append(f"data: {json.dumps(evt)}")
        parts.append("")
        parts.append("")
    return "\n".join(parts).encode("utf-8")


def _make_client(handler) -> AnthropicClient:
    client = AnthropicClient(api_key="test-key", model="claude-sonnet-4-6")
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


@pytest.mark.asyncio
async def test_anthropic_request_shape_and_text_stream() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["method"] = request.method
        captured["headers"] = dict(request.headers)
        captured["body"] = json.loads(request.content)
        events = [
            {"type": "message_start", "message": {"id": "m1"}},
            {"type": "content_block_start", "index": 0, "content_block": {"type": "text"}},
            {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "ola"}},
            {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": " mundo"}},
            {"type": "content_block_stop", "index": 0},
            {"type": "message_delta", "delta": {"stop_reason": "end_turn"}},
            {"type": "message_stop"},
        ]
        return httpx.Response(200, content=_sse(events), headers={"content-type": "text/event-stream"})

    client = _make_client(handler)
    try:
        tokens: list[Token] = []
        async for tok in client.chat(
            [
                ChatMessage(role="system", content="be nice"),
                ChatMessage(role="user", content="oi"),
            ]
        ):
            tokens.append(tok)
    finally:
        await client.aclose()

    assert captured["method"] == "POST"
    assert captured["url"].endswith("/v1/messages")
    assert captured["headers"]["x-api-key"] == "test-key"
    assert captured["headers"]["anthropic-version"] == "2023-06-01"
    body = captured["body"]
    assert body["model"] == "claude-sonnet-4-6"
    assert body["stream"] is True
    # system is a list of content blocks so cache_control can attach.
    assert body["system"] == [
        {"type": "text", "text": "be nice", "cache_control": {"type": "ephemeral"}}
    ]
    assert body["messages"] == [{"role": "user", "content": "oi"}]
    assert "max_tokens" in body

    texts = [t.text for t in tokens if t.text and not t.done]
    assert texts == ["ola", " mundo"]
    assert tokens[-1].done is True
    assert tokens[-1].text == ""
    assert tokens[-1].tool_calls is None


@pytest.mark.asyncio
async def test_anthropic_merges_multiple_system_messages() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        events = [
            {"type": "message_start", "message": {"id": "m1"}},
            {"type": "message_stop"},
        ]
        return httpx.Response(200, content=_sse(events), headers={"content-type": "text/event-stream"})

    client = _make_client(handler)
    try:
        async for _ in client.chat(
            [
                ChatMessage(role="system", content="be nice"),
                ChatMessage(role="system", content="reply in PT"),
                ChatMessage(role="user", content="oi"),
            ]
        ):
            pass
    finally:
        await client.aclose()
    assert captured["body"]["system"] == [
        {
            "type": "text",
            "text": "be nice\n\nreply in PT",
            "cache_control": {"type": "ephemeral"},
        }
    ]
    assert captured["body"]["messages"] == [{"role": "user", "content": "oi"}]


def test_convert_tools_openai_to_anthropic() -> None:
    openai_tools = [
        {
            "type": "function",
            "function": {
                "name": "list_dir",
                "description": "List a directory",
                "parameters": {
                    "type": "object",
                    "properties": {"path": {"type": "string"}},
                    "required": ["path"],
                },
            },
        }
    ]
    out = _convert_tools(openai_tools)
    assert out == [
        {
            "name": "list_dir",
            "description": "List a directory",
            "input_schema": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
        }
    ]


@pytest.mark.asyncio
async def test_anthropic_tool_use_streaming() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        events = [
            {"type": "message_start", "message": {"id": "m1"}},
            {
                "type": "content_block_start",
                "index": 0,
                "content_block": {"type": "tool_use", "id": "toolu_1", "name": "list_dir"},
            },
            {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "input_json_delta", "partial_json": '{"path": '},
            },
            {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "input_json_delta", "partial_json": '"/tmp"}'},
            },
            {"type": "content_block_stop", "index": 0},
            {"type": "message_delta", "delta": {"stop_reason": "tool_use"}},
            {"type": "message_stop"},
        ]
        return httpx.Response(200, content=_sse(events), headers={"content-type": "text/event-stream"})

    tools = [
        {
            "type": "function",
            "function": {
                "name": "list_dir",
                "description": "List a dir",
                "parameters": {"type": "object", "properties": {"path": {"type": "string"}}},
            },
        }
    ]

    client = _make_client(handler)
    try:
        tokens: list[Token] = []
        async for tok in client.chat(
            [ChatMessage(role="user", content="list /tmp")], tools=tools
        ):
            tokens.append(tok)
    finally:
        await client.aclose()

    # Request body carries Anthropic-shaped tools
    assert captured["body"]["tools"][0]["name"] == "list_dir"
    assert "input_schema" in captured["body"]["tools"][0]

    # Final token is the tool call
    assert tokens[-1].done is True
    assert tokens[-1].tool_calls is not None
    assert len(tokens[-1].tool_calls) == 1
    call = tokens[-1].tool_calls[0]
    assert call["function"]["name"] == "list_dir"
    assert json.loads(call["function"]["arguments"]) == {"path": "/tmp"}


@pytest.mark.asyncio
async def test_anthropic_thinking_wraps_in_think_tags() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        events = [
            {"type": "message_start", "message": {"id": "m1"}},
            {
                "type": "content_block_start",
                "index": 0,
                "content_block": {"type": "thinking"},
            },
            {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "thinking_delta", "thinking": "let me think"},
            },
            {"type": "content_block_stop", "index": 0},
            {
                "type": "content_block_start",
                "index": 1,
                "content_block": {"type": "text"},
            },
            {
                "type": "content_block_delta",
                "index": 1,
                "delta": {"type": "text_delta", "text": "answer"},
            },
            {"type": "content_block_stop", "index": 1},
            {"type": "message_delta", "delta": {"stop_reason": "end_turn"}},
            {"type": "message_stop"},
        ]
        return httpx.Response(200, content=_sse(events), headers={"content-type": "text/event-stream"})

    client = _make_client(handler)
    try:
        tokens: list[Token] = []
        async for tok in client.chat(
            [ChatMessage(role="user", content="hi")], think=True
        ):
            tokens.append(tok)
    finally:
        await client.aclose()

    # think body field set with enabled + budget
    assert captured["body"]["thinking"] == {"type": "enabled", "budget_tokens": 4000}
    # Temperature forced to 1.0 when thinking is enabled
    assert captured["body"]["temperature"] == 1.0

    texts = [t.text for t in tokens if t.text]
    joined = "".join(texts)
    assert "<think>" in joined
    assert "</think>" in joined
    assert "let me think" in joined
    # Order: think open → thought → think close → answer
    assert texts.index("<think>") < texts.index("let me think") < texts.index("</think>")
    assert texts.index("</think>") < texts.index("answer")


@pytest.mark.asyncio
async def test_anthropic_image_content_converted_to_base64() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        events = [
            {"type": "message_start", "message": {"id": "m1"}},
            {"type": "message_stop"},
        ]
        return httpx.Response(200, content=_sse(events), headers={"content-type": "text/event-stream"})

    client = _make_client(handler)
    try:
        async for _ in client.chat(
            [
                ChatMessage(
                    role="user",
                    content=[
                        {"type": "text", "text": "what's this?"},
                        {
                            "type": "image_url",
                            "image_url": {"url": "data:image/png;base64,AAAABBBB"},
                        },
                    ],
                )
            ]
        ):
            pass
    finally:
        await client.aclose()

    msg = captured["body"]["messages"][0]
    assert msg["role"] == "user"
    blocks = msg["content"]
    assert blocks[0] == {"type": "text", "text": "what's this?"}
    img = blocks[1]
    assert img["type"] == "image"
    assert img["source"]["type"] == "base64"
    assert img["source"]["media_type"] == "image/png"
    assert img["source"]["data"] == "AAAABBBB"


@pytest.mark.asyncio
async def test_anthropic_audio_input_raises() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"", headers={"content-type": "text/event-stream"})

    client = _make_client(handler)
    try:
        with pytest.raises(LLMUnavailableError, match="audio"):
            async for _ in client.chat(
                [ChatMessage(role="user", content="oi")], audio=b"\x00\x00"
            ):
                pass
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_anthropic_401_raises_llm_unavailable() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": {"message": "invalid api key"}})

    client = _make_client(handler)
    try:
        with pytest.raises(LLMUnavailableError):
            async for _ in client.chat([ChatMessage(role="user", content="oi")]):
                pass
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_anthropic_429_raises_llm_unavailable() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, json={"error": {"message": "rate limited"}})

    client = _make_client(handler)
    try:
        with pytest.raises(LLMUnavailableError):
            async for _ in client.chat([ChatMessage(role="user", content="oi")]):
                pass
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_anthropic_connection_error_raises_llm_unavailable() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    client = _make_client(handler)
    try:
        with pytest.raises(LLMUnavailableError):
            async for _ in client.chat([ChatMessage(role="user", content="oi")]):
                pass
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_tool_call_json_forces_tool_and_caches_system() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        body = {
            "content": [
                {
                    "type": "tool_use",
                    "id": "toolu_1",
                    "name": "score_candidate",
                    "input": {"candidate_name": "João", "score": 87},
                }
            ]
        }
        return httpx.Response(200, json=body)

    tool = {
        "name": "score_candidate",
        "description": "score a candidate",
        "input_schema": {"type": "object", "properties": {}},
    }

    client = _make_client(handler)
    try:
        out = await client.tool_call_json(
            system="rubric",
            user="cv text",
            tool=tool,
            cache_system=True,
        )
    finally:
        await client.aclose()

    assert out == {"candidate_name": "João", "score": 87}
    body = captured["body"]
    assert body["system"][0]["cache_control"] == {"type": "ephemeral"}
    assert body["tool_choice"] == {"type": "tool", "name": "score_candidate"}


@pytest.mark.asyncio
async def test_tool_call_json_raises_when_no_tool_use_block() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = {
            "content": [
                {"type": "text", "text": "I refuse to use the tool."},
            ]
        }
        return httpx.Response(200, json=body)

    tool = {
        "name": "score_candidate",
        "description": "score a candidate",
        "input_schema": {"type": "object", "properties": {}},
    }

    client = _make_client(handler)
    try:
        with pytest.raises(RuntimeError, match="score_candidate"):
            await client.tool_call_json(system="r", user="u", tool=tool)
    finally:
        await client.aclose()
