from __future__ import annotations

from pathlib import Path
from typing import Any, AsyncIterator

import pytest

from seraphine.conversation.engine import (
    ConversationEngine,
    ErrorEvent,
    TokenEvent,
    TurnEndEvent,
    _strip_tool_markup,
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


def test_strip_tool_markup_removes_card_html() -> None:
    """Multi-line card blocks are fully removed."""
    content = (
        '<think>Vou criar.</think>\n'
        '<!--card--><div class="rich-card rich-card--tasks">'
        '<span>Tarefa X</span></div><!--/card-->\n'
        '[confident] Pronto! Adicionei X.'
    )
    out = _strip_tool_markup(content)
    assert "rich-card" not in out
    assert "<!--card-->" not in out and "<!--/card-->" not in out
    assert "[confident] Pronto! Adicionei X." in out
    assert "<think>Vou criar.</think>" in out


def test_strip_tool_markup_removes_data_comments() -> None:
    """task-data / recurring-data / reminder-data comments all stripped."""
    content = (
        'Texto A '
        '<!--task-data:{"id": 24, "title": "x"}--> '
        'Texto B '
        '<!--recurring-data:{"id": 5}--> '
        'Texto C '
        '<!--reminder-data:{"at": "2026-04-22"}--> '
        'Texto D'
    )
    out = _strip_tool_markup(content)
    assert "task-data" not in out
    assert "recurring-data" not in out
    assert "reminder-data" not in out
    assert "Texto A" in out and "Texto D" in out


def test_strip_tool_markup_handles_empty_and_no_markup() -> None:
    assert _strip_tool_markup("") == ""
    assert _strip_tool_markup("só texto normal") == "só texto normal"


def test_strip_tool_markup_idempotent() -> None:
    """Applying strip twice produces the same result as once."""
    content = (
        '<!--card-->X<!--/card--> keep me '
        '<!--task-data:{"id":1}--> tail'
    )
    once = _strip_tool_markup(content)
    twice = _strip_tool_markup(once)
    assert once == twice


async def _only_conversation(store: MemoryStore) -> str:
    import sqlite3

    conn = sqlite3.connect(store.path)
    try:
        row = conn.execute("SELECT id FROM conversations LIMIT 1").fetchone()
    finally:
        conn.close()
    assert row is not None
    return row[0]
