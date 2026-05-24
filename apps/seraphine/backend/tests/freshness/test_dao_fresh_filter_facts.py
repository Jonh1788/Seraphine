"""Test that MemoryStore.list_facts(fresh_only=True) applies the
FreshnessPolicy filter.

Facts have no event date — they are recency-only candidates per spec
section 6.1 ("Só recency"). So fresh_only should drop facts whose
created_at is older than ``recency_hours``.

Shape note:
    Mirrors Task 5's test_dao_fresh_filter_loops.py. Uses a real
    MemoryStore + tmp_path sqlite (NOT the freshness conftest db
    fixture) because the production facts schema is richer than the
    minimal seed (id PK + source + confidence NOT NULL).
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


def _get_texts(rows: list[Any]) -> list[str]:
    """Tolerant accessor — production returns Fact(BaseModel) with .text."""
    out: list[str] = []
    for r in rows:
        if isinstance(r, dict):
            out.append(r["text"])
        elif hasattr(r, "text"):
            out.append(r.text)
        elif hasattr(r, "keys") and callable(getattr(r, "keys", None)):
            out.append(r["text"])
    return out


def _insert_fact(
    store: MemoryStore,
    *,
    fact_id: str,
    text: str,
    created_at: str,
    source: str = "explicit",
    confidence: float = 1.0,
    superseded_by: str | None = None,
) -> None:
    """Direct INSERT bypassing add_fact to backdate created_at.
    ``add_fact`` stamps created_at = now(), which would defeat the
    freshness test."""
    with store._connect() as conn:
        conn.execute(
            "INSERT INTO facts"
            " (id, text, source, confidence, created_at, superseded_by)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (fact_id, text, source, confidence, created_at, superseded_by),
        )


@pytest.fixture
async def store(tmp_path: Path) -> MemoryStore:
    s = MemoryStore(tmp_path / "fresh_facts.sqlite")
    await s.ensure_schema()
    return s


async def test_list_facts_fresh_only_excludes_old(
    store: MemoryStore, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        memory_store, "_freshness_policy_now",
        lambda: NOW, raising=False,
    )

    _insert_fact(
        store, fact_id="fresh-1", text="fato fresco",
        created_at=_iso(NOW - timedelta(hours=1)),
    )
    _insert_fact(
        store, fact_id="old-1", text="fato velho",
        created_at=_iso(NOW - timedelta(days=10)),
    )

    facts = await store.list_facts(fresh_only=True)
    texts = _get_texts(facts)
    assert "fato fresco" in texts
    assert "fato velho" not in texts


async def test_list_facts_default_keeps_all(
    store: MemoryStore,
) -> None:
    """Regression: fresh_only=False (default) preserves prior behavior."""
    _insert_fact(
        store, fact_id="old-1", text="fato velho",
        created_at=_iso(NOW - timedelta(days=10)),
    )
    all_facts = await store.list_facts()  # default — fresh_only=False
    texts = _get_texts(all_facts)
    assert "fato velho" in texts
