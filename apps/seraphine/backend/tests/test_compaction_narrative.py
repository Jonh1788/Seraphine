"""Tests for compaction -> narrative persistence (Item C / task #11).

When _compact_context generates a summary, the summary should also be
persisted as a durable narrative via store.add_narrative — but only once
per conversation (idempotent).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, AsyncIterator

import pytest

from llm_adapters.types import ChatMessage, Token
from seraphine.memory import FakeEmbeddings, MemoryManager, MemoryStore
from seraphine.memory.store import Turn
from seraphine.conversation.engine import (
    ConversationEngine,
    COMPACTION_CHAR_THRESHOLD,
    COMPACTION_KEEP_RECENT,
)
from tests.test_memory_manager import FakeCollection


class _SummarizerLLM:
    """LLM that returns a fixed summary for compaction prompts and a
    simple response for regular chat."""

    def __init__(self, summary: str = "Resumo da conversa anterior.") -> None:
        self.summary = summary

    async def chat(
        self,
        messages: list[ChatMessage],
        *,
        model: str | None = None,
        temperature: float = 0.7,
        **kwargs: Any,
    ) -> AsyncIterator[Token]:
        # If the system prompt contains "summarizer", it's a compaction call.
        sys_content = messages[0].content if messages else ""
        if "summariz" in sys_content.lower():
            text = self.summary
        else:
            text = "OK, entendi."
        for ch in text:
            yield Token(text=ch, done=False)
        yield Token(text="", done=True)


@pytest.fixture
async def store(tmp_path: Path) -> MemoryStore:
    s = MemoryStore(tmp_path / "compact.sqlite")
    await s.ensure_schema()
    return s


async def test_compaction_creates_narrative(
    store: MemoryStore, tmp_path: Path,
) -> None:
    """After compacting old turns, a narrative should appear in the store."""
    llm = _SummarizerLLM("O usuario discutiu arquitetura cloud e kubernetes.")
    memory = MemoryManager(store, FakeEmbeddings(dim=8), tmp_path / "chroma")
    memory.set_collection_for_tests(FakeCollection())

    engine = ConversationEngine(llm, store, memory=memory)

    conv_id = await store.create_conversation()
    # Create enough turns to exceed COMPACTION_CHAR_THRESHOLD.
    # Each turn needs to be big enough; COMPACTION_CHAR_THRESHOLD = 400_000 chars.
    # We'll call _compact_context directly with a synthetic list of Turn objects.
    turns_data: list[Turn] = []
    char_per_turn = (COMPACTION_CHAR_THRESHOLD // 30) + 100
    for i in range(40):
        role = "user" if i % 2 == 0 else "assistant"
        content = f"turn{i} " + ("x" * char_per_turn)
        t = await store.add_turn(conv_id, role, content)
        turns_data.append(t)

    # Verify we exceed the threshold
    total = sum(len(t.content) for t in turns_data)
    assert total > COMPACTION_CHAR_THRESHOLD

    # Trigger compaction
    await engine._compact_context(conv_id, turns_data)

    # A narrative should now exist for this conversation
    narratives = await store.list_narratives()
    assert len(narratives) >= 1
    narr = [n for n in narratives if n["conversation_id"] == conv_id]
    assert len(narr) == 1
    assert "discutiu" in narr[0]["text"] or "cloud" in narr[0]["text"]


async def test_compaction_idempotent(
    store: MemoryStore, tmp_path: Path,
) -> None:
    """Second compaction on the same conversation should NOT create a second narrative."""
    llm = _SummarizerLLM("Resumo repetido.")
    memory = MemoryManager(store, FakeEmbeddings(dim=8), tmp_path / "chroma")
    memory.set_collection_for_tests(FakeCollection())

    engine = ConversationEngine(llm, store, memory=memory)

    conv_id = await store.create_conversation()
    char_per_turn = (COMPACTION_CHAR_THRESHOLD // 30) + 100
    turns_data: list[Turn] = []
    for i in range(40):
        role = "user" if i % 2 == 0 else "assistant"
        t = await store.add_turn(conv_id, role, f"turn{i} " + "y" * char_per_turn)
        turns_data.append(t)

    await engine._compact_context(conv_id, turns_data)
    narratives_1 = await store.list_narratives()
    count_1 = len([n for n in narratives_1 if n["conversation_id"] == conv_id])
    assert count_1 == 1

    # Second compaction — should reuse cached summary, narrative already exists
    await engine._compact_context(conv_id, turns_data)
    narratives_2 = await store.list_narratives()
    count_2 = len([n for n in narratives_2 if n["conversation_id"] == conv_id])
    assert count_2 == 1  # still only one


async def test_no_narrative_without_memory(
    store: MemoryStore, tmp_path: Path,
) -> None:
    """If the engine has no memory module, compaction should still work
    without errors — just no narrative created."""
    llm = _SummarizerLLM("Resumo sem memoria.")
    engine = ConversationEngine(llm, store, memory=None)

    conv_id = await store.create_conversation()
    char_per_turn = (COMPACTION_CHAR_THRESHOLD // 30) + 100
    turns_data: list[Turn] = []
    for i in range(40):
        role = "user" if i % 2 == 0 else "assistant"
        t = await store.add_turn(conv_id, role, f"turn{i} " + "z" * char_per_turn)
        turns_data.append(t)

    result = await engine._compact_context(conv_id, turns_data)
    # Should succeed and return compacted messages
    assert len(result) > 0
    # No narratives since memory is None
    narratives = await store.list_narratives()
    assert len(narratives) == 0
