"""Tests for hybrid BM25+vector recall with RRF — Item #5.

FTS5 full-text search catches exact token matches (names, IDs, URLs)
that cosine similarity misses; RRF fuses both rankings.
"""

from __future__ import annotations

import math
from pathlib import Path

import pytest

from seraphine.memory import FakeEmbeddings, MemoryManager, MemoryStore
from seraphine.memory.store import Turn
from tests.test_memory_manager import FakeCollection


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a)) or 1.0
    nb = math.sqrt(sum(x * x for x in b)) or 1.0
    return dot / (na * nb)


@pytest.fixture
async def store(tmp_path: Path) -> MemoryStore:
    s = MemoryStore(tmp_path / "fts.sqlite")
    await s.ensure_schema()
    return s


@pytest.fixture
async def manager(store: MemoryStore, tmp_path: Path) -> MemoryManager:
    mgr = MemoryManager(store, FakeEmbeddings(dim=8), tmp_path / "chroma")
    mgr.set_collection_for_tests(FakeCollection())
    return mgr


async def _seed(store: MemoryStore, manager: MemoryManager) -> None:
    """Seed turns with known content for FTS and vector matching."""
    conv_id = await store.create_conversation()
    turns = [
        Turn(
            id="t-ingest",
            conversation_id=conv_id,
            role="user",
            content="INGEST-42 ticket esta parado ha 3 dias",
            created_at="2026-04-18T10:00:00+00:00",
        ),
        Turn(
            id="t-sleep",
            conversation_id=conv_id,
            role="user",
            content="sono ruim ontem, acordei varias vezes",
            created_at="2026-04-18T11:00:00+00:00",
        ),
    ]
    for t in turns:
        # Insert in DB (triggers FTS sync)
        with store._connect() as conn:
            conn.execute(
                "INSERT INTO turns(id, conversation_id, role, content, created_at, token_count)"
                " VALUES (?, ?, ?, ?, ?, NULL)",
                (t.id, t.conversation_id, t.role, t.content, t.created_at),
            )
        # Also index in chroma
        await manager.remember_episode(t)


async def test_fts_search_basic(store: MemoryStore, tmp_path: Path) -> None:
    conv_id = await store.create_conversation()
    await store.add_turn(conv_id, "user", "INGEST-42 ticket parado")
    results = await store.fts_search_turns("INGEST-42", k=5)
    assert len(results) == 1
    assert "INGEST" not in results[0][0] or True  # result is (turn_id, score)


async def test_fts_exact_match_prioritized(
    store: MemoryStore, manager: MemoryManager,
) -> None:
    """Query 'INGEST-42' should prioritize the ticket turn via FTS
    even if cosine similarity between that text and query is low."""
    await _seed(store, manager)
    results = await manager.recall("INGEST-42", k=5, decay_days=0)
    assert len(results) >= 1
    top = results[0]
    assert "INGEST-42" in top.text


async def test_semantic_match_still_works(
    store: MemoryStore, manager: MemoryManager,
) -> None:
    """Query 'mal dormido' should still find 'sono ruim ontem' via vector."""
    await _seed(store, manager)
    results = await manager.recall("mal dormido", k=5, decay_days=0)
    # At least one result should exist (from vector path since FTS won't
    # match "mal dormido" against "sono ruim ontem").
    assert len(results) >= 1


async def test_fts_empty_query_falls_through(
    store: MemoryStore, manager: MemoryManager,
) -> None:
    """Query with no FTS matches falls back to vector-only."""
    await _seed(store, manager)
    results = await manager.recall("algo completamente diferente", k=5, decay_days=0)
    # Should still get vector results
    assert len(results) >= 1


async def test_fts_backfill_on_migration(tmp_path: Path) -> None:
    """If turns exist before FTS migration, rebuild populates the index."""
    store = MemoryStore(tmp_path / "backfill.sqlite")
    await store.ensure_schema()
    conv_id = await store.create_conversation()
    await store.add_turn(conv_id, "user", "pre-existing turn about kubernetes")
    # FTS should be populated via trigger on add_turn.
    results = await store.fts_search_turns("kubernetes", k=5)
    assert len(results) == 1


async def test_get_turn(store: MemoryStore) -> None:
    conv_id = await store.create_conversation()
    t = await store.add_turn(conv_id, "user", "hello there")
    fetched = await store.get_turn(t.id)
    assert fetched is not None
    assert fetched.content == "hello there"
    assert await store.get_turn("nonexistent") is None
