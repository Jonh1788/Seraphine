"""Tests for facts as third recall modality (Item A / task #9).

Facts are curated, high-signal memories. When they appear in the fact
embedding cache, recall() should surface them alongside turns and
windows via RRF. Recalled facts should also bump last_used_at.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from seraphine.memory import FakeEmbeddings, MemoryManager, MemoryStore
from seraphine.memory.store import Turn
from tests.test_memory_manager import FakeCollection


@pytest.fixture
async def store(tmp_path: Path) -> MemoryStore:
    s = MemoryStore(tmp_path / "fact_recall.sqlite")
    await s.ensure_schema()
    return s


@pytest.fixture
async def manager(store: MemoryStore, tmp_path: Path) -> MemoryManager:
    mgr = MemoryManager(store, FakeEmbeddings(dim=8), tmp_path / "chroma")
    mgr.set_collection_for_tests(FakeCollection())
    return mgr


async def test_fact_appears_in_recall(
    store: MemoryStore, manager: MemoryManager,
) -> None:
    """A fact in the embedding cache should be surfaced in recall results."""
    # Seed a turn so vector retrieval has something
    conv_id = await store.create_conversation()
    noisy = Turn(
        id="t-weather",
        conversation_id=conv_id,
        role="user",
        content="falamos sobre o clima de ontem e a previsao",
        created_at="2026-04-18T10:00:00+00:00",
    )
    await manager.remember_episode(noisy)

    # Learn a fact — it enters the fact embedding cache
    fact = await manager.learn_fact(
        "user mora em SP", source="reflection", confidence=0.9,
    )

    results = await manager.recall("onde moro", k=5, decay_days=0)
    assert len(results) >= 1
    fact_results = [m for m in results if m.kind == "fact"]
    assert len(fact_results) >= 1
    assert fact_results[0].id == fact.id
    assert fact_results[0].text == "user mora em SP"
    assert fact_results[0].metadata.get("source") == "reflection"


async def test_recalled_fact_bumps_last_used_at(
    store: MemoryStore, manager: MemoryManager,
) -> None:
    """When a fact appears in the top-k recall, its last_used_at is updated."""
    fact = await manager.learn_fact(
        "user trabalha com Python", source="explicit", confidence=1.0,
    )
    # Confirm last_used_at is initially None
    f = await store.get_fact(fact.id)
    assert f is not None
    assert f.last_used_at is None

    await manager.recall("linguagem de programacao", k=5, decay_days=0)

    f2 = await store.get_fact(fact.id)
    assert f2 is not None
    assert f2.last_used_at is not None


async def test_superseded_facts_excluded_from_recall(
    store: MemoryStore, manager: MemoryManager,
) -> None:
    """Facts that have been superseded (soft-deleted) must not appear."""
    fact = await manager.learn_fact(
        "user mora em SP", source="reflection", confidence=0.9,
    )
    await manager.forget(fact.id)

    results = await manager.recall("onde moro", k=5, decay_days=0)
    fact_results = [m for m in results if m.kind == "fact"]
    assert len(fact_results) == 0


async def test_fact_dedup_keeps_higher_confidence(
    store: MemoryStore, manager: MemoryManager,
) -> None:
    """If two facts have cosine > 0.98 (identical text), only the one
    with higher confidence survives in the top-k."""
    # Same text -> FakeEmbeddings gives identical vectors -> cosine = 1.0
    await manager.learn_fact(
        "user mora em SP", source="reflection", confidence=0.7,
    )
    f2 = await manager.learn_fact(
        "user mora em SP", source="explicit", confidence=1.0,
    )

    results = await manager.recall("onde moro", k=5, decay_days=0)
    fact_results = [m for m in results if m.kind == "fact"]
    # Only one fact should survive dedup
    assert len(fact_results) == 1
    assert fact_results[0].id == f2.id  # higher confidence
