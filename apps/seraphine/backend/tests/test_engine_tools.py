from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, AsyncIterator

import pytest

from seraphine.conversation.engine import (
    ConversationEngine,
    TokenEvent,
    ToolRequestEvent,
    ToolResultEvent,
    TurnEndEvent,
)
from llm_adapters.types import ChatMessage, Token
from seraphine.memory.store import MemoryStore
from seraphine.tools.filesystem import ListDirTool, WriteFileTool
from seraphine.tools.registry import ToolRegistry


class ScriptedLLM:
    def __init__(self, scripts: list[list[Token]]) -> None:
        self.scripts = scripts
        self.calls: list[list[ChatMessage]] = []

    async def chat(
        self,
        messages: list[ChatMessage],
        *,
        model: str | None = None,
        temperature: float = 0.7,
        tools: list[dict[str, Any]] | None = None, **kwargs: Any,
    ) -> AsyncIterator[Token]:
        self.calls.append(list(messages))
        idx = len(self.calls) - 1
        script = self.scripts[min(idx, len(self.scripts) - 1)]
        for tok in script:
            yield tok


def _tool_call(name: str, args: dict[str, Any]) -> dict[str, Any]:
    return {"function": {"name": name, "arguments": args}}


@pytest.mark.asyncio
async def test_engine_tool_no_confirmation(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "t.sqlite")
    await store.ensure_schema()
    (tmp_path / "foo.txt").write_text("x")

    reg = ToolRegistry()
    reg.register(ListDirTool([tmp_path]))

    llm = ScriptedLLM(
        [
            [Token(text="", done=True, tool_calls=[_tool_call("list_dir", {"path": str(tmp_path)})])],
            [Token(text="ok ", done=False), Token(text="done", done=False), Token(text="", done=True)],
        ]
    )
    engine = ConversationEngine(llm, store, tools=reg)

    events = [e async for e in engine.handle_user_message(None, "list")]
    assert any(isinstance(e, ToolResultEvent) and e.ok for e in events)
    assert not any(isinstance(e, ToolRequestEvent) for e in events)
    token_texts = [e.text for e in events if isinstance(e, TokenEvent)]
    assert "".join(token_texts) == "ok done"
    assert any(isinstance(e, TurnEndEvent) for e in events)

    audits = await store.list_tool_audit()
    assert len(audits) == 1
    assert audits[0].approved is None
    assert audits[0].ok == 1


@pytest.mark.asyncio
async def test_engine_tool_approved(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "t.sqlite")
    await store.ensure_schema()
    target = tmp_path / "out.txt"

    reg = ToolRegistry()
    reg.register(WriteFileTool([tmp_path]))

    llm = ScriptedLLM(
        [
            [
                Token(
                    text="",
                    done=True,
                    tool_calls=[_tool_call("write_file", {"path": str(target), "content": "hi"})],
                )
            ],
            [Token(text="done", done=False), Token(text="", done=True)],
        ]
    )
    engine = ConversationEngine(llm, store, tools=reg)

    events: list[Any] = []
    gen = engine.handle_user_message(None, "write")

    async def _collect() -> None:
        async for e in gen:
            events.append(e)
            if isinstance(e, ToolRequestEvent):
                asyncio.get_event_loop().call_soon(
                    lambda rid=e.request_id: asyncio.create_task(
                        engine.submit_approval(rid, True)
                    )
                )

    await _collect()

    assert target.read_text() == "hi"
    audits = await store.list_tool_audit()
    assert len(audits) == 1
    assert audits[0].approved == 1
    assert audits[0].ok == 1


@pytest.mark.asyncio
async def test_engine_tool_rejected(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "t.sqlite")
    await store.ensure_schema()
    target = tmp_path / "out.txt"

    reg = ToolRegistry()
    reg.register(WriteFileTool([tmp_path]))

    llm = ScriptedLLM(
        [
            [
                Token(
                    text="",
                    done=True,
                    tool_calls=[_tool_call("write_file", {"path": str(target), "content": "hi"})],
                )
            ],
            [Token(text="nope", done=False), Token(text="", done=True)],
        ]
    )
    engine = ConversationEngine(llm, store, tools=reg)

    gen = engine.handle_user_message(None, "write")
    events: list[Any] = []
    async for e in gen:
        events.append(e)
        if isinstance(e, ToolRequestEvent):
            asyncio.get_event_loop().call_soon(
                lambda rid=e.request_id: asyncio.create_task(
                    engine.submit_approval(rid, False)
                )
            )

    assert not target.exists()
    audits = await store.list_tool_audit()
    assert len(audits) == 1
    assert audits[0].approved == 0
    assert audits[0].ok == 0
    assert audits[0].error == "rejected by user"
