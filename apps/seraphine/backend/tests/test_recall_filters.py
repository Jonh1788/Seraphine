"""Tests for filtered recall (Item E / task #13).

recall() now accepts optional conversation_id, role, since, and until
kwargs to narrow results. These propagate to Chroma (where clause),
FTS (SQL WHERE), and fact time filtering.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from seraphine.memory import FakeEmbeddings, MemoryManager, MemoryStore
from seraphine.memory.store import Turn
from tests.test_memory_manager import FakeCollection


@pytest.fixture
async def store(tmp_path: Path) -> MemoryStore:
    s = MemoryStore(tmp_path / "filters.sqlite")
    await s.ensure_schema()
    return s


@pytest.fixture
async def manager(store: MemoryStore, tmp_path: Path) -> MemoryManager:
    mgr = MemoryManager(store, FakeEmbeddings(dim=8), tmp_path / "chroma")
    mgr.set_collection_for_tests(FakeCollection())
    return mgr


async def _seed_two_conversations(
    store: MemoryStore, manager: MemoryManager,
) -> tuple[str, str]:
    """Create two conversations with turns and index them."""
    c1 = await store.create_conversation()
    c2 = await store.create_conversation()

    turns_c1 = [
        Turn(
            id="t1-c1",
            conversation_id=c1,
            role="user",
            content="quero comprar um notebook novo para programar",
            created_at="2026-04-10T10:00:00+00:00",
        ),
        Turn(
            id="t2-c1",
            conversation_id=c1,
            role="assistant",
            content="recomendo MacBook Pro M4 para desenvolvimento",
            created_at="2026-04-10T10:01:00+00:00",
        ),
    ]
    turns_c2 = [
        Turn(
            id="t1-c2",
            conversation_id=c2,
            role="user",
            content="como esta o tempo hoje em Sao Paulo",
            created_at="2026-04-15T14:00:00+00:00",
        ),
        Turn(
            id="t2-c2",
            conversation_id=c2,
            role="assistant",
            content="esta nublado com chance de chuva em SP",
            created_at="2026-04-15T14:01:00+00:00",
        ),
    ]

    for t in turns_c1 + turns_c2:
        # Insert in DB (triggers FTS sync).
        with store._connect() as conn:
            conn.execute(
                "INSERT INTO turns(id, conversation_id, role, content, created_at, token_count)"
                " VALUES (?, ?, ?, ?, ?, NULL)",
                (t.id, t.conversation_id, t.role, t.content, t.created_at),
            )
        await manager.remember_episode(t)

    return c1, c2


async def test_filter_by_conversation_id(
    store: MemoryStore, manager: MemoryManager,
) -> None:
    """recall with conversation_id should only return results from that conversation."""
    c1, c2 = await _seed_two_conversations(store, manager)

    results = await manager.recall(
        "notebook", k=10, decay_days=0, conversation_id=c1,
    )
    # Should only have c1 results (episodes/windows).
    episode_results = [m for m in results if m.kind in ("episode", "window")]
    for m in episode_results:
        assert m.metadata.get("conversation_id") == c1


async def test_filter_by_since(
    store: MemoryStore, manager: MemoryManager,
) -> None:
    """recall with since should exclude older turns."""
    await _seed_two_conversations(store, manager)

    # since=2026-04-12 should exclude c1 turns (April 10)
    results = await manager.recall(
        "notebook programar tempo", k=10, decay_days=0,
        since="2026-04-12T00:00:00+00:00",
    )
    episode_results = [m for m in results if m.kind in ("episode", "window")]
    for m in episode_results:
        assert m.metadata.get("created_at", "") >= "2026-04-12"


async def test_filter_by_role(
    store: MemoryStore, manager: MemoryManager,
) -> None:
    """recall with role=user should only return user turns."""
    await _seed_two_conversations(store, manager)

    results = await manager.recall(
        "notebook tempo", k=10, decay_days=0, role="user",
    )
    episode_results = [m for m in results if m.kind in ("episode", "window")]
    for m in episode_results:
        assert m.metadata.get("role") == "user"


async def test_fact_time_filter(
    store: MemoryStore, manager: MemoryManager,
) -> None:
    """Facts outside the since/until range should be excluded."""
    # Learn a fact with old timestamp
    fact = await manager.learn_fact(
        "user mora em SP", source="explicit", confidence=1.0,
    )
    # The fact was created "now" (2026), so filtering with since in the future
    # should exclude it.
    results = await manager.recall(
        "onde moro", k=10, decay_days=0,
        since="2099-01-01T00:00:00+00:00",
    )
    fact_results = [m for m in results if m.kind == "fact"]
    assert len(fact_results) == 0


async def test_no_filters_returns_all(
    store: MemoryStore, manager: MemoryManager,
) -> None:
    """recall without filters should return results from all conversations."""
    await _seed_two_conversations(store, manager)

    results = await manager.recall("notebook tempo", k=10, decay_days=0)
    # Should have results from both conversations.
    conv_ids = {
        m.metadata.get("conversation_id")
        for m in results
        if m.kind in ("episode", "window")
    }
    assert len(conv_ids) >= 2
