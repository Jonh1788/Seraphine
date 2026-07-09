from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, AsyncIterator

import pytest

from llm_adapters.types import ChatMessage, Token
from seraphine.conversation.engine import ConversationEngine
from seraphine.learning import schema as learning_schema
from seraphine.memory.store import MemoryStore
from seraphine.tools.filesystem import ListDirTool
from seraphine.tools.registry import ToolRegistry


class ScriptedLLM:
    def __init__(self, scripts: list[list[Token]]) -> None:
        self.scripts = scripts
        self.calls: list[list[ChatMessage]] = []

    async def chat(
        self, messages: list[ChatMessage], *, model: str | None = None,
        temperature: float = 0.7, tools: list[dict[str, Any]] | None = None,
        **kwargs: Any,
    ) -> AsyncIterator[Token]:
        self.calls.append(list(messages))
        idx = len(self.calls) - 1
        for tok in self.scripts[min(idx, len(self.scripts) - 1)]:
            yield tok


def _tool_call(name: str, args: dict[str, Any]) -> dict[str, Any]:
    return {"function": {"name": name, "arguments": args}}


async def _read_trace_tools(store: MemoryStore) -> list[str] | None:
    # record_trace is fire-and-forget (create_task + to_thread); poll briefly.
    for _ in range(30):
        rows = await asyncio.to_thread(
            lambda: store._connect().execute(
                "SELECT tools_json FROM learning_trace ORDER BY ts DESC LIMIT 1"
            ).fetchall()
        )
        if rows:
            return json.loads(rows[0][0])
        await asyncio.sleep(0.02)
    return None


@pytest.mark.asyncio
async def test_learning_trace_records_used_tool(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "t.sqlite")
    store.register_migrator("learning", learning_schema.migrate)
    await store.ensure_schema()
    (tmp_path / "foo.txt").write_text("x")

    reg = ToolRegistry()
    reg.register(ListDirTool([tmp_path]))
    llm = ScriptedLLM([
        [Token(text="", done=True, tool_calls=[_tool_call("list_dir", {"path": str(tmp_path)})])],
        [Token(text="ok", done=False), Token(text="", done=True)],
    ])
    engine = ConversationEngine(llm, store, tools=reg)

    _ = [e async for e in engine.handle_user_message(None, "liste os arquivos")]

    tools = await _read_trace_tools(store)
    assert tools is not None, "no learning_trace row recorded"
    assert "list_dir" in tools, f"tool name not recorded in trace; got {tools!r}"
