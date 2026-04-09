from __future__ import annotations

from pathlib import Path
from typing import AsyncIterator

import pytest

from seraphine.llm.types import ChatMessage, Token
from seraphine.memory import FakeEmbeddings, MemoryManager, MemoryStore

from tests.test_memory_manager import FakeCollection


class CannedLLM:
    """Yields a fixed JSON-shaped response regardless of input."""

    def __init__(self, raw: str) -> None:
        self.raw = raw
        self.calls: list[list[ChatMessage]] = []

    async def chat(
        self,
        messages: list[ChatMessage],
        *,
        model: str | None = None,
        temperature: float = 0.7,
    ) -> AsyncIterator[Token]:
        self.calls.append(messages)
        for chunk in self.raw:
            yield Token(text=chunk, done=False)
        yield Token(text="", done=True)


@pytest.fixture
async def manager_with_history(tmp_path: Path) -> tuple[MemoryManager, MemoryStore, CannedLLM]:
    store = MemoryStore(tmp_path / "t.sqlite")
    await store.ensure_schema()
    # Seed enough turns to cross REFLECTION_MIN_TURNS=5.
    conv_id = await store.create_conversation()
    seeds = [
        ("user", "meu nome é João"),
        ("assistant", "Olá João"),
        ("user", "trabalho com Go há 10 anos"),
        ("assistant", "legal"),
        ("user", "uso um MacBook M3"),
        ("assistant", "ok"),
    ]
    for role, content in seeds:
        await store.add_turn(conv_id, role, content)

    llm = CannedLLM(
        '{"facts": ["user is named João",'
        ' "user has 10 years of Go experience",'
        ' "user works on a MacBook M3"]}'
    )
    mgr = MemoryManager(
        store,
        FakeEmbeddings(dim=8),
        tmp_path / "chroma",
        llm=llm,
    )
    mgr.set_collection_for_tests(FakeCollection())
    return mgr, store, llm


async def test_reflect_inserts_facts(
    manager_with_history: tuple[MemoryManager, MemoryStore, CannedLLM],
) -> None:
    mgr, store, llm = manager_with_history
    inserted = await mgr.reflect()
    assert inserted == 3
    facts = await store.list_facts()
    texts = sorted(f.text for f in facts)
    assert "user has 10 years of Go experience" in texts
    assert "user is named João" in texts
    assert "user works on a MacBook M3" in texts
    # All facts produced by reflection have source="reflection".
    assert all(f.source == "reflection" for f in facts)
    assert llm.calls, "LLM should have been called once"


async def test_reflect_dedup_against_existing(
    manager_with_history: tuple[MemoryManager, MemoryStore, CannedLLM],
) -> None:
    mgr, store, _ = manager_with_history
    # Pre-existing fact with the same text → fake embeddings give identical
    # vectors → cosine = 1.0 > 0.92 threshold → must be deduped.
    await mgr.learn_fact("user is named João", source="explicit", confidence=1.0)
    inserted = await mgr.reflect()
    assert inserted == 2  # only the two NEW ones
    facts = await store.list_facts()
    assert len(facts) == 3
    by_source = {f.text: f.source for f in facts}
    assert by_source["user is named João"] == "explicit"


async def test_reflect_no_llm_returns_zero(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "t.sqlite")
    await store.ensure_schema()
    mgr = MemoryManager(store, FakeEmbeddings(dim=8), tmp_path / "chroma")
    mgr.set_collection_for_tests(FakeCollection())
    inserted = await mgr.reflect()
    assert inserted == 0


async def test_reflect_too_few_turns_returns_zero(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "t.sqlite")
    await store.ensure_schema()
    conv_id = await store.create_conversation()
    await store.add_turn(conv_id, "user", "oi")
    mgr = MemoryManager(
        store,
        FakeEmbeddings(dim=8),
        tmp_path / "chroma",
        llm=CannedLLM('{"facts": []}'),
    )
    mgr.set_collection_for_tests(FakeCollection())
    inserted = await mgr.reflect()
    assert inserted == 0
