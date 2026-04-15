from __future__ import annotations

from pathlib import Path
from typing import Any, AsyncIterator

import pytest

from seraphine.conversation.engine import (
    ConversationEngine,
    ErrorEvent,
    TokenEvent,
    TurnEndEvent,
)
from llm_adapters.types import ChatMessage, LLMUnavailableError, Token
from seraphine.memory.store import MemoryStore


class FakeLLM:
    def __init__(self, chunks: list[str]) -> None:
        self.chunks = chunks

    async def chat(
        self,
        messages: list[ChatMessage],
        *,
        model: str | None = None,
        temperature: float = 0.7, **kwargs: Any,
    ) -> AsyncIterator[Token]:
        for c in self.chunks:
            yield Token(text=c, done=False)
        yield Token(text="", done=True)


class BrokenLLM:
    async def chat(
        self,
        messages: list[ChatMessage],
        *,
        model: str | None = None,
        temperature: float = 0.7, **kwargs: Any,
    ) -> AsyncIterator[Token]:
        raise LLMUnavailableError("boom")
        yield  # pragma: no cover


@pytest.mark.asyncio
async def test_happy_path(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "t.sqlite")
    await store.ensure_schema()
    engine = ConversationEngine(FakeLLM(["Hel", "lo", "!"]), store)

    events = [e async for e in engine.handle_user_message(None, "hi")]
    token_events = [e for e in events if isinstance(e, TokenEvent)]
    end_events = [e for e in events if isinstance(e, TurnEndEvent)]

    assert len(token_events) == 3
    assert "".join(t.text for t in token_events) == "Hello!"
    assert len(end_events) == 1

    conv_id = token_events[0].conversation_id
    turns = await store.get_turns(conv_id)
    assert [t.role for t in turns] == ["user", "assistant"]
    assert turns[0].content == "hi"
    assert turns[1].content == "Hello!"


@pytest.mark.asyncio
async def test_llm_error_path(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "t.sqlite")
    await store.ensure_schema()
    engine = ConversationEngine(BrokenLLM(), store)

    events = [e async for e in engine.handle_user_message(None, "hi")]
    assert len(events) == 1
    assert isinstance(events[0], ErrorEvent)
    assert events[0].code == "llm_unavailable"

    # Only user turn persisted
    conv_id = (await _only_conversation(store))
    turns = await store.get_turns(conv_id)
    assert [t.role for t in turns] == ["user"]


async def _only_conversation(store: MemoryStore) -> str:
    import sqlite3

    conn = sqlite3.connect(store.path)
    try:
        row = conn.execute("SELECT id FROM conversations LIMIT 1").fetchone()
    finally:
        conn.close()
    assert row is not None
    return row[0]
