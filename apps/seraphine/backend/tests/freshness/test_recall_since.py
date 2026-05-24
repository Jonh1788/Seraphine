"""Vector recall must filter snippets older than the recency window.

Task 10 — When ``MemoryManager.recall(..., fresh_only=True)`` is called
(the path the per-turn engine takes), the Chroma vector query is
constrained with ``where={"created_at": {"$gte": cutoff_iso}}`` so a
chat snippet from months ago can never resurface in mid-conversation
context.

Two assertions:

  1. Path A (preferred): the native Chroma ``where`` arg includes a
     ``created_at`` predicate at-or-after ``now - recency_hours``.

  2. Belt-and-suspenders post-filter: if the native filter ever stops
     working (Chroma silently ignores ``where`` on certain metadata
     shapes), the post-filter still drops stale snippets. The shape of
     this test verifies the INVARIANT — stale-dated snippets in the
     input do not survive to the recall output.

Also asserts ``fresh_only=False`` (default) preserves prior behavior:
no ``since`` predicate is auto-inserted, callers retain full control.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from seraphine.memory import manager as memory_manager
from seraphine.memory.manager import MemoryManager


NOW = datetime(2026, 5, 23, 12, 0, 0, tzinfo=timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def _make_manager(collection: Any) -> MemoryManager:
    """Build a MemoryManager whose embeddings + collection are stubbed.

    Bypasses ``start()`` (which requires chromadb on-disk init) by
    directly assigning the collection.
    """
    embeddings = MagicMock()
    embeddings.embed = AsyncMock(return_value=[[0.1, 0.2, 0.3]])

    store = MagicMock()
    store.fts_search_turns = AsyncMock(return_value=[])
    store.get_turn = AsyncMock(return_value=None)
    store.get_fact = AsyncMock(return_value=None)
    store.add_event = AsyncMock()
    store.bump_fact_used = AsyncMock()

    mgr = MemoryManager(
        store=store,
        embeddings=embeddings,
        chroma_path=memory_manager.Path("/tmp/_freshness_test_recall"),
        llm=None,
    )
    mgr.set_collection_for_tests(collection)
    return mgr


def _make_chroma_results(
    rows: list[tuple[str, str, dict[str, Any], float]],
) -> dict[str, list[list[Any]]]:
    """Chroma's query() returns each field as a list-of-lists (one
    inner list per query embedding). Build the shape from row tuples
    ``(id, document, metadata, distance)``."""
    return {
        "ids": [[r[0] for r in rows]],
        "documents": [[r[1] for r in rows]],
        "metadatas": [[r[2] for r in rows]],
        "distances": [[r[3] for r in rows]],
    }


# ---------------------------------------------------------------------------
# Path A: fresh_only=True passes a Chroma ``where`` filter with created_at
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_recall_fresh_only_applies_chroma_where_filter(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When called with ``fresh_only=True`` and no explicit ``since``,
    recall must construct a Chroma ``where`` filter constraining
    ``created_at`` to be at or after ``now - recency_hours``."""
    monkeypatch.setattr(
        memory_manager, "_freshness_policy_now",
        lambda: NOW, raising=False,
    )

    fake_collection = MagicMock()
    fake_collection.query.return_value = _make_chroma_results([])

    mgr = _make_manager(fake_collection)
    await mgr.recall("oi", k=5, fresh_only=True)

    assert fake_collection.query.called, "collection.query was not invoked"
    where_arg = fake_collection.query.call_args.kwargs.get("where")
    assert where_arg is not None, (
        f"fresh_only=True did not produce a `where` filter. "
        f"call_args={fake_collection.query.call_args!r}"
    )
    where_str = str(where_arg)
    assert "created_at" in where_str, (
        f"`where` filter is missing the created_at predicate: {where_arg!r}"
    )

    # The predicate should be a lower-bound at-or-after recency cutoff.
    # We don't pin the exact ISO string (timezone formatting can vary)
    # but the cutoff must be within a minute of now - 72h (default policy).
    from seraphine.freshness import DEFAULT_POLICY
    expected_cutoff = NOW - timedelta(hours=DEFAULT_POLICY.recency_hours)
    # Extract any ISO timestamp out of the where dict by scanning.
    found_recent = False

    def _scan(node: Any) -> None:
        nonlocal found_recent
        if isinstance(node, dict):
            for v in node.values():
                _scan(v)
        elif isinstance(node, list):
            for v in node:
                _scan(v)
        elif isinstance(node, str):
            try:
                dt = datetime.fromisoformat(node)
            except ValueError:
                return
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            if abs((dt - expected_cutoff).total_seconds()) < 60:
                found_recent = True

    _scan(where_arg)
    assert found_recent, (
        f"`where` filter does not constrain created_at to >= "
        f"{expected_cutoff.isoformat()} (recency_hours="
        f"{DEFAULT_POLICY.recency_hours}). where={where_arg!r}"
    )


# ---------------------------------------------------------------------------
# Default fresh_only=False: prior behavior preserved
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_recall_default_does_not_inject_since() -> None:
    """Default behavior (fresh_only=False) must NOT auto-inject a
    ``since`` predicate. Callers like the debug ``/memory/recall`` route
    rely on full-history queries."""
    fake_collection = MagicMock()
    fake_collection.query.return_value = _make_chroma_results([])

    mgr = _make_manager(fake_collection)
    await mgr.recall("oi", k=5)  # default fresh_only=False

    where_arg = fake_collection.query.call_args.kwargs.get("where")
    if where_arg is None:
        return  # explicit None — no filter, perfect
    assert "created_at" not in str(where_arg), (
        f"fresh_only=False (default) leaked a created_at filter into "
        f"the Chroma where clause: {where_arg!r}"
    )


# ---------------------------------------------------------------------------
# Explicit `since` wins over fresh_only default cutoff
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_recall_explicit_since_wins_over_fresh_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """If the caller passes both ``fresh_only=True`` AND an explicit
    ``since``, the explicit value must be respected (it might be older
    or newer than the policy cutoff, but it's the caller's intent)."""
    monkeypatch.setattr(
        memory_manager, "_freshness_policy_now",
        lambda: NOW, raising=False,
    )
    fake_collection = MagicMock()
    fake_collection.query.return_value = _make_chroma_results([])

    explicit_since = _iso(NOW - timedelta(days=365))  # way older than policy
    mgr = _make_manager(fake_collection)
    await mgr.recall("oi", k=5, fresh_only=True, since=explicit_since)

    where_arg = fake_collection.query.call_args.kwargs.get("where")
    assert where_arg is not None
    assert explicit_since in str(where_arg), (
        f"Explicit since={explicit_since} was overridden by the policy "
        f"cutoff. where={where_arg!r}"
    )


# ---------------------------------------------------------------------------
# Invariant test: stale snippets do not survive the recall pipeline.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_recall_drops_stale_snippets_when_chroma_ignores_where(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Belt-and-suspenders: even if Chroma's native ``where`` silently
    returns stale rows (e.g. metadata layout drift), the recall pipeline
    must NOT emit them as Memory results when ``fresh_only=True``.

    This guards the core invariant: stale-dated input → not in output.
    Implementations can satisfy this with either a Python post-filter
    or by trusting Chroma's where (in which case Chroma would return
    only fresh rows in production and this test simulates the worst
    case by having the mock return both regardless of where=).
    """
    monkeypatch.setattr(
        memory_manager, "_freshness_policy_now",
        lambda: NOW, raising=False,
    )

    fresh_meta = {
        "role": "user",
        "conversation_id": "c1",
        "created_at": _iso(NOW - timedelta(hours=1)),
    }
    stale_meta = {
        "role": "user",
        "conversation_id": "c1",
        "created_at": _iso(NOW - timedelta(days=30)),
    }
    fake_collection = MagicMock()
    fake_collection.query.return_value = _make_chroma_results(
        [
            ("stale-1", "old snippet about cana brava", stale_meta, 0.3),
            ("fresh-1", "fresh snippet", fresh_meta, 0.5),
        ]
    )

    mgr = _make_manager(fake_collection)
    results = await mgr.recall("oi", k=5, fresh_only=True)

    ids = [m.id for m in results]
    assert "stale-1" not in ids, (
        f"Stale snippet survived fresh_only=True recall. results={ids}"
    )
