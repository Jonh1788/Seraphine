"""Tests for incremental reflection via cursor (Item B / task #10).

reflect() should skip turns already processed by a previous call,
avoiding redundant LLM invocations. The cursor is global (no per-conv).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, AsyncIterator

import pytest

from llm_adapters.types import ChatMessage, Token
from seraphine.memory import FakeEmbeddings, MemoryManager, MemoryStore
from tests.test_memory_manager import FakeCollection


class CountingLLM:
    """LLM that counts calls and returns a configurable fact JSON."""

    def __init__(self, response: str = '{"facts": []}') -> None:
        self.response = response
        self.call_count = 0

    async def chat(
        self,
        messages: list[ChatMessage],
        *,
        model: str | None = None,
        temperature: float = 0.7,
        **kwargs: Any,
    ) -> AsyncIterator[Token]:
        self.call_count += 1
        for ch in self.response:
            yield Token(text=ch, done=False)
        yield Token(text="", done=True)


@pytest.fixture
async def store(tmp_path: Path) -> MemoryStore:
    s = MemoryStore(tmp_path / "incr.sqlite")
    await s.ensure_schema()
    return s


async def _seed_turns(store: MemoryStore, n: int = 10) -> str:
    conv_id = await store.create_conversation()
    for i in range(n):
        role = "user" if i % 2 == 0 else "assistant"
        content = f"detalhe tecnico numero {i} sobre arquitetura do sistema cloud"
        await store.add_turn(conv_id, role, content)
    return conv_id


async def test_first_reflect_processes_all_turns(
    store: MemoryStore, tmp_path: Path,
) -> None:
    """First reflect() with no cursor should call the LLM."""
    await _seed_turns(store, 10)
    llm = CountingLLM('{"facts": [{"text": "user discusses cloud architecture", "confidence": 0.8}]}')
    mgr = MemoryManager(store, FakeEmbeddings(dim=8), tmp_path / "chroma", llm=llm)
    mgr.set_collection_for_tests(FakeCollection())

    inserted = await mgr.reflect()
    assert inserted >= 1
    assert llm.call_count >= 1


async def test_second_reflect_no_new_turns_skips_llm(
    store: MemoryStore, tmp_path: Path,
) -> None:
    """Second reflect() without new turns should return 0, no LLM call."""
    await _seed_turns(store, 10)
    llm = CountingLLM('{"facts": [{"text": "user discusses cloud architecture", "confidence": 0.8}]}')
    mgr = MemoryManager(store, FakeEmbeddings(dim=8), tmp_path / "chroma", llm=llm)
    mgr.set_collection_for_tests(FakeCollection())

    first = await mgr.reflect()
    assert first >= 1
    calls_after_first = llm.call_count

    # Second reflect — no new turns
    second = await mgr.reflect()
    assert second == 0
    assert llm.call_count == calls_after_first  # LLM not called again


async def test_third_reflect_processes_only_new_turns(
    store: MemoryStore, tmp_path: Path,
) -> None:
    """After adding new turns, reflect() should process only those."""
    conv_id = await _seed_turns(store, 10)
    llm = CountingLLM('{"facts": [{"text": "user discusses infra", "confidence": 0.85}]}')
    mgr = MemoryManager(store, FakeEmbeddings(dim=8), tmp_path / "chroma", llm=llm)
    mgr.set_collection_for_tests(FakeCollection())

    await mgr.reflect()
    calls_after_first = llm.call_count

    # Add 2 new turns
    await store.add_turn(conv_id, "user", "quero migrar pra kubernetes no proximo quarter")
    await store.add_turn(conv_id, "assistant", "vamos planejar a migracao juntos entao, massa!")

    # Change response so new fact is distinct (avoids dedup)
    llm.response = '{"facts": [{"text": "user plans k8s migration", "confidence": 0.9}]}'

    third = await mgr.reflect()
    # LLM was called at least once more (for the new turns)
    assert llm.call_count > calls_after_first
    # Should have processed and inserted new fact
    assert third >= 1

    # Cursor should have advanced
    cursor = await store.get_reflect_cursor(None)
    assert cursor is not None


async def test_cursor_persists_in_store(
    store: MemoryStore, tmp_path: Path,
) -> None:
    """The reflect cursor is persisted in SQLite, survives manager rebuild."""
    await _seed_turns(store, 10)
    llm = CountingLLM('{"facts": [{"text": "cloud fact", "confidence": 0.8}]}')
    mgr = MemoryManager(store, FakeEmbeddings(dim=8), tmp_path / "chroma", llm=llm)
    mgr.set_collection_for_tests(FakeCollection())

    await mgr.reflect()
    cursor = await store.get_reflect_cursor(None)
    assert cursor is not None

    # Simulate app restart — new manager, same store
    mgr2 = MemoryManager(store, FakeEmbeddings(dim=8), tmp_path / "chroma2", llm=llm)
    mgr2.set_collection_for_tests(FakeCollection())

    # No new turns → returns 0 even with fresh manager
    result = await mgr2.reflect()
    assert result == 0
