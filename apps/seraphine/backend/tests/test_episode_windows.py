"""Tests for windowed episodes — Item #7.

Groups consecutive turns into windows for richer context in recall.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from seraphine.memory import FakeEmbeddings, MemoryManager, MemoryStore
from seraphine.memory.manager import WINDOW_SIZE, WINDOW_GAP_SECONDS
from seraphine.memory.store import Turn
from tests.test_memory_manager import FakeCollection


@pytest.fixture
async def store(tmp_path: Path) -> MemoryStore:
    s = MemoryStore(tmp_path / "win.sqlite")
    await s.ensure_schema()
    return s


@pytest.fixture
async def manager(store: MemoryStore, tmp_path: Path) -> MemoryManager:
    mgr = MemoryManager(store, FakeEmbeddings(dim=8), tmp_path / "chroma")
    mgr.set_collection_for_tests(FakeCollection())
    return mgr


def _make_turn(i: int, conv_id: str, ts: str) -> Turn:
    return Turn(
        id=f"t-{i}",
        conversation_id=conv_id,
        role="user" if i % 2 == 0 else "assistant",
        content=f"turn content number {i} about topic alpha",
        created_at=ts,
    )


async def test_8_turns_produce_one_window(
    store: MemoryStore, manager: MemoryManager,
) -> None:
    conv_id = "conv-1"
    base = datetime(2026, 4, 18, 10, 0, 0, tzinfo=timezone.utc)
    for i in range(WINDOW_SIZE):
        ts = (base + timedelta(seconds=i * 30)).isoformat()
        t = _make_turn(i, conv_id, ts)
        await manager.remember_episode(t)

    windows = await store.list_windows()
    assert len(windows) == 1
    w = windows[0]
    assert w["turn_count"] == WINDOW_SIZE
    assert w["conversation_id"] == conv_id
    assert w["first_turn_id"] == "t-0"
    assert w["last_turn_id"] == f"t-{WINDOW_SIZE - 1}"


async def test_gap_triggers_flush(
    store: MemoryStore, manager: MemoryManager,
) -> None:
    """5 turns + 11 min gap + 1 turn: flush before the gap, buffer starts new."""
    conv_id = "conv-gap"
    base = datetime(2026, 4, 18, 10, 0, 0, tzinfo=timezone.utc)

    # 5 turns close together
    for i in range(5):
        ts = (base + timedelta(seconds=i * 30)).isoformat()
        t = _make_turn(i, conv_id, ts)
        await manager.remember_episode(t)

    # No window yet — only 5 turns.
    windows = await store.list_windows()
    assert len(windows) == 0

    # Turn after >10-minute gap from the last turn (t-4 at base+120s).
    # So gap_ts needs to be > base + 120s + 600s = base + 720s.
    gap_ts = (base + timedelta(seconds=750)).isoformat()
    t_after = _make_turn(5, conv_id, gap_ts)
    await manager.remember_episode(t_after)

    # Gap triggered a flush of the 5-turn buffer.
    windows = await store.list_windows()
    assert len(windows) == 1
    assert windows[0]["turn_count"] == 5
    assert windows[0]["first_turn_id"] == "t-0"
    assert windows[0]["last_turn_id"] == "t-4"

    # The 6th turn is now in a fresh buffer.
    assert len(manager._window_buffer.get(conv_id, [])) == 1


async def test_window_appears_in_recall(
    store: MemoryStore, manager: MemoryManager,
) -> None:
    conv_id = "conv-recall"
    base = datetime(2026, 4, 18, 10, 0, 0, tzinfo=timezone.utc)
    for i in range(WINDOW_SIZE):
        ts = (base + timedelta(seconds=i * 30)).isoformat()
        t = _make_turn(i, conv_id, ts)
        await manager.remember_episode(t)

    results = await manager.recall("topic alpha", k=10, decay_days=0)
    kinds = {r.kind for r in results}
    assert "window" in kinds


async def test_window_deduplicates_constituent_turns(
    store: MemoryStore, manager: MemoryManager,
) -> None:
    """If a window and its first/last turn appear in top-k, the turns are removed."""
    conv_id = "conv-dedup"
    base = datetime(2026, 4, 18, 10, 0, 0, tzinfo=timezone.utc)
    for i in range(WINDOW_SIZE):
        ts = (base + timedelta(seconds=i * 30)).isoformat()
        t = _make_turn(i, conv_id, ts)
        await manager.remember_episode(t)

    results = await manager.recall("topic alpha", k=20, decay_days=0)
    result_ids = [r.id for r in results]
    window_ids = [r.id for r in results if r.kind == "window"]
    assert len(window_ids) >= 1

    # The first and last turn IDs of any window should NOT appear
    # as separate results.
    windows = await store.list_windows()
    for w in windows:
        if w["id"] in window_ids:
            assert w["first_turn_id"] not in result_ids, \
                f"first turn {w['first_turn_id']} should be deduped by window"
            assert w["last_turn_id"] not in result_ids, \
                f"last turn {w['last_turn_id']} should be deduped by window"
