"""Test that MemoryStore.list_open_loops(fresh_only=True) applies the
FreshnessPolicy filter.

Open loops have no event date — they are recency-only candidates per
spec section 6.1 ("Só recency"). So fresh_only should drop loops whose
created_at is older than ``recency_hours``.

Shape note:
    Like Task 4, the plan sketched a synchronous DAO function. The
    production surface is ``MemoryStore.list_open_loops`` (an async
    instance method). This test exercises the real method using the
    production fixture pattern (``MemoryStore(tmp_path / "x.sqlite")``
    + ``ensure_schema``) rather than the minimal in-memory seed in
    conftest.py — the latter lacks the ``owner`` column the real
    schema requires.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest

from seraphine.memory import store as memory_store
from seraphine.memory.store import MemoryStore


NOW = datetime(2026, 5, 23, 12, 0, 0, tzinfo=timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def _get_field(rows: list[Any], field: str) -> list[Any]:
    """Tolerant accessor for dict / sqlite3.Row / dataclass-shaped rows."""
    out = []
    for r in rows:
        if isinstance(r, dict):
            out.append(r[field])
        elif hasattr(r, "keys") and callable(getattr(r, "keys", None)):
            out.append(r[field])
        else:
            out.append(getattr(r, field))
    return out


def _insert_loop(
    store: MemoryStore,
    *,
    loop_id: str,
    text: str,
    created_at: str,
    resolved_at: str | None = None,
    owner: str = "user",
) -> None:
    """Direct INSERT bypassing add_open_loop to backdate created_at.
    ``add_open_loop`` stamps created_at = now(), which would defeat the
    freshness test."""
    with store._connect() as conn:
        conn.execute(
            "INSERT INTO open_loops"
            " (id, text, owner, created_at, resolved_at, injection_count)"
            " VALUES (?, ?, ?, ?, ?, 0)",
            (loop_id, text, owner, created_at, resolved_at),
        )


@pytest.fixture
async def store(tmp_path: Path) -> MemoryStore:
    s = MemoryStore(tmp_path / "fresh_loops.sqlite")
    await s.ensure_schema()
    return s


async def test_list_open_loops_fresh_only_excludes_old(
    store: MemoryStore, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        memory_store, "_freshness_policy_now",
        lambda: NOW, raising=False,
    )

    _insert_loop(
        store, loop_id="fresh-1", text="fresca",
        created_at=_iso(NOW - timedelta(hours=1)),
    )
    _insert_loop(
        store, loop_id="old-1", text="velha",
        created_at=_iso(NOW - timedelta(days=10)),
    )

    fresh = await store.list_open_loops(fresh_only=True)
    texts = _get_field(fresh, "text")
    assert "fresca" in texts
    assert "velha" not in texts


async def test_list_open_loops_default_keeps_all(
    store: MemoryStore,
) -> None:
    """Regression: fresh_only=False (default) preserves prior behavior."""
    _insert_loop(
        store, loop_id="old-1", text="velha",
        created_at=_iso(NOW - timedelta(days=10)),
    )
    all_loops = await store.list_open_loops()  # default
    texts = _get_field(all_loops, "text")
    assert "velha" in texts


async def test_list_open_loops_fresh_only_with_only_open_false_still_filters(
    store: MemoryStore, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """fresh_only must combine with only_open via AND, independently.

    Even when only_open=False (i.e. include resolved loops), the
    freshness filter still drops anything stale.
    """
    monkeypatch.setattr(
        memory_store, "_freshness_policy_now",
        lambda: NOW, raising=False,
    )

    # Fresh + resolved — should appear (only_open=False allows resolved).
    _insert_loop(
        store, loop_id="fresh-resolved", text="fresca-resolvida",
        created_at=_iso(NOW - timedelta(hours=1)),
        resolved_at=_iso(NOW - timedelta(minutes=30)),
    )
    # Old + resolved — should be dropped by fresh_only regardless.
    _insert_loop(
        store, loop_id="old-resolved", text="velha-resolvida",
        created_at=_iso(NOW - timedelta(days=10)),
        resolved_at=_iso(NOW - timedelta(days=9)),
    )
    # Old + open — should be dropped by fresh_only.
    _insert_loop(
        store, loop_id="old-open", text="velha-aberta",
        created_at=_iso(NOW - timedelta(days=10)),
    )

    result = await store.list_open_loops(only_open=False, fresh_only=True)
    texts = _get_field(result, "text")
    assert "fresca-resolvida" in texts
    assert "velha-resolvida" not in texts
    assert "velha-aberta" not in texts
