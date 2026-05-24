from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, AsyncIterator

import pytest

from seraphine.conversation.engine import ConversationEngine, TokenEvent, TurnEndEvent
from llm_adapters.types import ChatMessage, Token
from seraphine.memory import FakeEmbeddings, MemoryManager, MemoryStore
from seraphine.memory.store import Turn

from tests.test_memory_manager import FakeCollection


class RecordingLLM:
    def __init__(self, tokens: list[str]) -> None:
        self.tokens = tokens
        self.last_messages: list[ChatMessage] | None = None

    async def chat(
        self,
        messages: list[ChatMessage],
        *,
        model: str | None = None,
        temperature: float = 0.7, **kwargs: Any,
    ) -> AsyncIterator[Token]:
        self.last_messages = messages
        for t in self.tokens:
            yield Token(text=t, done=False)
        yield Token(text="", done=True)


@pytest.fixture
async def engine_with_memory(tmp_path: Path):
    store = MemoryStore(tmp_path / "t.sqlite")
    await store.ensure_schema()
    mgr = MemoryManager(store, FakeEmbeddings(dim=8), tmp_path / "chroma")
    mgr.set_collection_for_tests(FakeCollection())

    # Use a fresh timestamp — the engine's recall path now applies the
    # freshness policy's recency cutoff (Task 10). A stale seed would
    # be correctly filtered out, which is exactly the behavior change
    # being asserted in tests/freshness/test_recall_since.py.
    recent_iso = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    seed = Turn(
        id="seed-1",
        conversation_id="c0",
        role="user",
        content="user is a software engineer",
        created_at=recent_iso,
    )
    await mgr.remember_episode(seed)
    await mgr.learn_fact("user prefers PT-BR")

    llm = RecordingLLM(["O", "lá", "!"])
    eng = ConversationEngine(llm=llm, store=store, memory=mgr)
    return eng, llm, mgr


async def test_recall_block_injected_into_messages(engine_with_memory) -> None:
    engine, llm, _ = engine_with_memory
    events = []
    async for ev in engine.handle_user_message(None, "olá"):
        events.append(ev)

    assert any(isinstance(e, TokenEvent) for e in events)
    assert any(isinstance(e, TurnEndEvent) for e in events)

    assert llm.last_messages is not None
    system_messages = [m for m in llm.last_messages if m.role == "system"]
    combined = "\n".join(m.content for m in system_messages)
    assert "PT-BR" in combined
    assert "software engineer" in combined


async def test_new_turns_are_remembered(engine_with_memory) -> None:
    engine, _, mgr = engine_with_memory
    initial_docs = len(mgr._collection.docs)
    async for _ in engine.handle_user_message(None, "olá"):
        pass
    final_docs = len(mgr._collection.docs)
    assert final_docs == initial_docs + 2
