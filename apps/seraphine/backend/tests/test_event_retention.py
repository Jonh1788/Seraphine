"""Tests for event timeline retention / prune (Item F / task #14).

event_timeline grows without TTL. prune_events_older_than(days) deletes
rows with created_at older than N days, keeping the timeline lean.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from seraphine.memory import MemoryStore


@pytest.fixture
async def store(tmp_path: Path) -> MemoryStore:
    s = MemoryStore(tmp_path / "prune.sqlite")
    await s.ensure_schema()
    return s


async def test_prune_deletes_old_events(store: MemoryStore) -> None:
    """Events older than the cutoff should be deleted; recent ones survive."""
    # Insert an old event (91+ days ago) directly via SQL.
    old_ts = (datetime.now(timezone.utc) - timedelta(days=100)).isoformat()

    def _insert_old() -> None:
        with store._connect() as conn:
            conn.execute(
                "INSERT INTO event_timeline(event_type, summary, source, metadata, created_at)"
                " VALUES (?, ?, ?, '{}', ?)",
                ("warning", "old event", "memory", old_ts),
            )

    import asyncio
    await asyncio.to_thread(_insert_old)

    # Insert a recent event via the normal API.
    await store.add_event("info", "recent event", "memory")

    # Prune with 90-day threshold.
    deleted = await store.prune_events_older_than(90)
    assert deleted == 1

    # Verify only the recent event survived.
    events = await store.get_recent_events(limit=100)
    assert len(events) == 1
    assert events[0]["summary"] == "recent event"


async def test_prune_returns_zero_when_nothing_old(store: MemoryStore) -> None:
    """If no events are older than the cutoff, prune returns 0."""
    await store.add_event("info", "fresh event", "memory")
    deleted = await store.prune_events_older_than(90)
    assert deleted == 0


async def test_prune_with_custom_days(store: MemoryStore) -> None:
    """Prune with a shorter cutoff (e.g., 7 days) should catch more events."""
    # Insert an event 10 days old.
    ts_10d = (datetime.now(timezone.utc) - timedelta(days=10)).isoformat()
    import asyncio

    def _insert() -> None:
        with store._connect() as conn:
            conn.execute(
                "INSERT INTO event_timeline(event_type, summary, source, metadata, created_at)"
                " VALUES (?, ?, ?, '{}', ?)",
                ("warning", "10d old", "memory", ts_10d),
            )

    await asyncio.to_thread(_insert)
    await store.add_event("info", "today", "memory")

    # 90 days: 10-day-old event survives.
    assert await store.prune_events_older_than(90) == 0

    # 7 days: 10-day-old event is pruned.
    assert await store.prune_events_older_than(7) == 1

    events = await store.get_recent_events(limit=100)
    assert len(events) == 1
    assert events[0]["summary"] == "today"
