"""Tests for ``OpenRouterChatClient`` — the OpenRouter-backed main-chat client
that matches the conversation engine's ``llm.chat`` contract.

Covers:
  - text deltas streamed as ``Token(text=...)``;
  - a tool call streamed across two deltas (name in the first, arguments split)
    accumulated into a single terminal ``Token(done=True, tool_calls=[...])``
    whose shape is directly consumable by the engine's ``_parse_tool_call``;
  - a clean ``Token(done=True)`` when no tool calls occur;
  - a non-200 response raising (so the engine can surface / fall back).
"""

from __future__ import annotations

import json

import httpx
import pytest
import respx

from llm_adapters.types import ChatMessage, Token
from seraphine.conversation.engine import _parse_tool_call
from seraphine.deepsearch.providers import OpenRouterChatClient


def _sse(*lines: str) -> bytes:
    return ("\n".join([*lines, ""])).encode("utf-8")


@pytest.mark.asyncio
@respx.mock
async def test_chat_streams_text_then_done():
    body = _sse(
        ": keepalive",  # SSE comment — ignored
        'data: {"choices":[{"delta":{"content":"Olá"}}]}',
        'data: {"choices":[]}',  # usage-only / empty-choices — skipped
        "data: {not json",  # malformed — skipped, stream stays alive
        'data: {"choices":[{"delta":{"content":" mundo"}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
        "data: [DONE]",
    )
    respx.post("https://openrouter.ai/api/v1/chat/completions").mock(
        return_value=httpx.Response(
            200, headers={"content-type": "text/event-stream"}, content=body
        )
    )

    c = OpenRouterChatClient(api_key="sk-or-x")
    toks = [
        t
        async for t in c.chat(
            [ChatMessage(role="user", content="oi")],
            model="openai/gpt-4o-mini",
        )
    ]

    text = "".join(t.text for t in toks if t.text)
    assert text == "Olá mundo"
    assert toks[-1].done is True
    assert toks[-1].tool_calls is None

    # Headers + body sanity.
    req = respx.calls.last.request
    assert req.headers["authorization"] == "Bearer sk-or-x"
    assert req.headers["http-referer"]
    sent = json.loads(req.content)
    assert sent["stream"] is True
    assert sent["model"] == "openai/gpt-4o-mini"
    assert sent["messages"] == [{"role": "user", "content": "oi"}]


@pytest.mark.asyncio
@respx.mock
async def test_chat_tool_call_accumulated_across_deltas():
    # Tool call streamed in pieces: id+name in the first delta, arguments split
    # across two deltas (OpenAI streams function arguments as fragments).
    body = _sse(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1",'
        '"type":"function","function":{"name":"get_weather","arguments":"{\\"ci"}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,'
        '"function":{"arguments":"ty\\": \\"SP\\"}"}}]}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        "data: [DONE]",
    )
    respx.post("https://openrouter.ai/api/v1/chat/completions").mock(
        return_value=httpx.Response(
            200, headers={"content-type": "text/event-stream"}, content=body
        )
    )

    c = OpenRouterChatClient(api_key="sk-or-x")
    tools = [
        {
            "type": "function",
            "function": {
                "name": "get_weather",
                "description": "weather",
                "parameters": {"type": "object", "properties": {}},
            },
        }
    ]
    toks = [
        t
        async for t in c.chat(
            [ChatMessage(role="user", content="clima?")],
            model="openai/gpt-4o-mini",
            tools=tools,
        )
    ]

    # No text content in this stream — only a terminal tool-call token.
    assert all(not t.text for t in toks)
    final = toks[-1]
    assert final.done is True
    assert final.tool_calls is not None
    assert len(final.tool_calls) == 1

    tc = final.tool_calls[0]
    assert tc["type"] == "function"
    assert tc["function"]["name"] == "get_weather"
    # Arguments accumulated into a single valid JSON string.
    assert tc["function"]["arguments"] == '{"city": "SP"}'

    # The terminal token shape passes the engine's parser directly.
    name, args = _parse_tool_call(tc)
    assert name == "get_weather"
    assert args == {"city": "SP"}

    # tools forwarded + tool_choice auto.
    sent = json.loads(respx.calls.last.request.content)
    assert sent["tools"] == tools
    assert sent["tool_choice"] == "auto"


@pytest.mark.asyncio
@respx.mock
async def test_chat_raises_on_non_200():
    respx.post("https://openrouter.ai/api/v1/chat/completions").mock(
        return_value=httpx.Response(401, json={"error": "bad key"})
    )
    c = OpenRouterChatClient(api_key="sk-or-x")
    with pytest.raises(RuntimeError):
        async for _ in c.chat(
            [ChatMessage(role="user", content="hi")], model="openai/gpt-4o-mini"
        ):
            pass


class _SentinelLLM:
    """Stand-in for the cliproxy AnthropicClient (app.state.llm)."""


@pytest.mark.asyncio
async def test_resolve_chat_llm(tmp_path):
    from seraphine.conversation.engine import ConversationEngine
    from seraphine.deepsearch import schema as deepsearch_schema
    from seraphine.deepsearch.providers import OpenRouterChatClient
    from seraphine.memory.store import MemoryStore

    store = MemoryStore(tmp_path / "resolve.sqlite")
    store.register_migrator("seraphine_deepsearch", deepsearch_schema.migrate)
    await store.ensure_schema()

    sentinel = _SentinelLLM()
    engine = ConversationEngine(sentinel, store)

    # 1. No setting → cliproxy default.
    llm, model = await engine._resolve_chat_llm()
    assert llm is sentinel and model is None

    # 2. Explicit cliproxy → default.
    await store.set_kv("chat_model", "cliproxy")
    llm, model = await engine._resolve_chat_llm()
    assert llm is sentinel and model is None

    # 3. openrouter requested but NO key configured → falls back to cliproxy.
    await store.set_kv("chat_model", "openrouter:openai/gpt-4o-mini")
    llm, model = await engine._resolve_chat_llm()
    assert llm is sentinel and model is None

    # 4. openrouter requested + key present → OpenRouterChatClient + model id.
    def _set_key() -> None:
        with store._connect() as conn:
            conn.execute(
                "UPDATE deepsearch_config SET openrouter_key = ? WHERE id = 1",
                ("sk-or-x",),
            )

    import asyncio

    await asyncio.to_thread(_set_key)
    llm, model = await engine._resolve_chat_llm()
    assert isinstance(llm, OpenRouterChatClient)
    assert model == "openai/gpt-4o-mini"

    # 5. Malformed setting → safe fallback.
    await store.set_kv("chat_model", "openrouter:")
    llm, model = await engine._resolve_chat_llm()
    assert llm is sentinel and model is None

    # 6. Prefixo duplicado gravado por cliente antigo → colapsa.
    #    Sem isso o model id sai como "openrouter:openai/gpt-4o-mini" e a
    #    OpenRouter devolve 400 "is not a valid model ID".
    await store.set_kv("chat_model", "openrouter:openrouter:openai/gpt-4o-mini")
    llm, model = await engine._resolve_chat_llm()
    assert isinstance(llm, OpenRouterChatClient)
    assert model == "openai/gpt-4o-mini"


@pytest.mark.asyncio
async def test_resolve_chat_llm_repassa_o_sink_de_telemetria(tmp_path):
    """O gasto do OpenRouter tem que aparecer em custo/energia.

    O cliente do cliproxy recebe o sink pela factory (`llm/factory.py`), mas o
    do OpenRouter é construído pelo próprio engine. Enquanto o engine o criava
    sem `telemetry=`, `_emit_usage` saía cedo e TODO turno roteado por
    OpenRouter ficava invisível no painel — foi o que aconteceu com o Gemini.
    """
    from seraphine.conversation.engine import ConversationEngine
    from seraphine.deepsearch import schema as deepsearch_schema
    from seraphine.deepsearch.providers import OpenRouterChatClient
    from seraphine.memory.store import MemoryStore

    store = MemoryStore(tmp_path / "sink.sqlite")
    store.register_migrator("seraphine_deepsearch", deepsearch_schema.migrate)
    await store.ensure_schema()

    engine = ConversationEngine(_SentinelLLM(), store)

    recebidos: list[dict] = []
    engine._telemetry_sink = recebidos.append

    def _set_key() -> None:
        with store._connect() as conn:
            conn.execute(
                "UPDATE deepsearch_config SET openrouter_key = ? WHERE id = 1",
                ("sk-or-x",),
            )

    import asyncio

    await asyncio.to_thread(_set_key)
    await store.set_kv("chat_model", "openrouter:google/gemini-2.5-flash")

    llm, model = await engine._resolve_chat_llm()
    assert isinstance(llm, OpenRouterChatClient)

    # O cliente tem que ter recebido ESTE sink, não None.
    assert llm._telemetry is not None, "cliente OpenRouter criado sem telemetria"

    # E o sink recebido tem que ser o do engine: emitir chega na nossa lista.
    llm._emit_usage(model, {"prompt_tokens": 11, "completion_tokens": 22})
    assert recebidos == [
        {
            "backend": "openrouter",
            "model": "google/gemini-2.5-flash",
            "input_tokens": 11,
            "output_tokens": 22,
            # Cache de prompt: zero quando o usage não traz os contadores.
            "cache_read_tokens": 0,
            "cache_write_tokens": 0,
        }
    ]


def test_token_tool_call_shape_is_engine_compatible():
    """A standalone guard: the documented terminal tool_calls shape parses."""
    tok = Token(
        text="",
        done=True,
        tool_calls=[
            {
                "id": "call_1",
                "type": "function",
                "function": {"name": "foo", "arguments": '{"a": 1}'},
            }
        ],
    )
    name, args = _parse_tool_call(tok.tool_calls[0])
    assert name == "foo"
    assert args == {"a": 1}
