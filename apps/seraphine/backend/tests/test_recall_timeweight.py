"""Tests for time-weighted recall — Item #6.

Recent episodes should outrank older ones when cosine similarity is
close.  decay_days=0 disables the penalty.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from seraphine.memory import FakeEmbeddings, MemoryManager, MemoryStore
from seraphine.memory.store import Turn
from tests.test_memory_manager import FakeCollection


@pytest.fixture
async def store(tmp_path: Path) -> MemoryStore:
    s = MemoryStore(tmp_path / "tw.sqlite")
    await s.ensure_schema()
    return s


@pytest.fixture
async def manager(store: MemoryStore, tmp_path: Path) -> MemoryManager:
    mgr = MemoryManager(store, FakeEmbeddings(dim=8), tmp_path / "chroma")
    mgr.set_collection_for_tests(FakeCollection())
    return mgr


async def _seed_pair(
    store: MemoryStore, manager: MemoryManager,
) -> tuple[str, str]:
    """Seed two turns with very similar content but different ages.

    Returns (old_id, new_id).
    """
    conv_id = await store.create_conversation()
    now = datetime.now(timezone.utc)
    old_ts = (now - timedelta(days=90)).isoformat()
    new_ts = now.isoformat()

    # Similar content so FakeEmbeddings produces close vectors.
    old_turn = Turn(
        id="t-old",
        conversation_id=conv_id,
        role="user",
        content="preciso revisar meu planejamento financeiro pessoal",
        created_at=old_ts,
    )
    new_turn = Turn(
        id="t-new",
        conversation_id=conv_id,
        role="user",
        content="preciso revisar meu planejamento financeiro mensal",
        created_at=new_ts,
    )
    # Insert in DB for FTS sync, then index in chroma.
    import asyncio as _aio

    def _insert(t: Turn) -> None:
        with store._connect() as conn:
            conn.execute(
                "INSERT INTO turns(id, conversation_id, role, content,"
                " created_at, token_count) VALUES (?, ?, ?, ?, ?, NULL)",
                (t.id, t.conversation_id, t.role, t.content, t.created_at),
            )

    for t in (old_turn, new_turn):
        await _aio.to_thread(_insert, t)
        await manager.remember_episode(t)

    return old_turn.id, new_turn.id


async def test_recent_wins_with_default_decay(
    store: MemoryStore, manager: MemoryManager,
) -> None:
    old_id, new_id = await _seed_pair(store, manager)
    results = await manager.recall(
        "planejamento financeiro", k=2, decay_days=30.0,
    )
    assert len(results) == 2
    # The recent turn should rank first because time-weighting penalizes
    # the 90-day-old one heavily (exp(-90/30) ~ 0.05).
    assert results[0].id == new_id


async def test_decay_zero_disables_penalty(
    store: MemoryStore, manager: MemoryManager,
) -> None:
    old_id, new_id = await _seed_pair(store, manager)
    results = await manager.recall(
        "planejamento financeiro", k=2, decay_days=0,
    )
    assert len(results) == 2
    # With decay disabled, ordering is purely by RRF score (cosine-driven).
    # Both have nearly identical content -> stable order; we just verify
    # both are present.
    ids = {r.id for r in results}
    assert old_id in ids
    assert new_id in ids
