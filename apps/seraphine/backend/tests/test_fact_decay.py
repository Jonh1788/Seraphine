"""Tests for fact decay (TTL) — Item #2.

Facts whose adjusted confidence (confidence * exp(-age/90)) drops below
0.3 are self-superseded by the decay sweep.  Facts that were recently
used (bumped via last_used_at) survive even if old.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from seraphine.memory import FakeEmbeddings, MemoryManager, MemoryStore
from seraphine.memory.routes import router as memory_router
from tests.test_memory_manager import FakeCollection


@pytest.fixture
async def store(tmp_path: Path) -> MemoryStore:
    s = MemoryStore(tmp_path / "decay.sqlite")
    await s.ensure_schema()
    return s


@pytest.fixture
async def manager(store: MemoryStore, tmp_path: Path) -> MemoryManager:
    mgr = MemoryManager(store, FakeEmbeddings(dim=8), tmp_path / "chroma")
    mgr.set_collection_for_tests(FakeCollection())
    return mgr


def _insert_fact_at(store: MemoryStore, text: str, confidence: float,
                    created_at: str, last_used_at: str | None = None) -> str:
    """Synchronous helper to INSERT a fact with controlled timestamps."""
    import uuid
    fid = str(uuid.uuid4())
    with store._connect() as conn:
        conn.execute(
            "INSERT INTO facts(id, text, source, confidence, created_at,"
            " superseded_by, last_used_at) VALUES (?, ?, ?, ?, ?, NULL, ?)",
            (fid, text, "reflection", confidence, created_at, last_used_at),
        )
    return fid


async def test_recent_fact_survives(manager: MemoryManager, store: MemoryStore) -> None:
    """A fact created today with decent confidence should not decay."""
    now = datetime.now(timezone.utc).isoformat()
    _insert_fact_at(store, "user likes Python", 0.8, now)
    superseded = await manager.decay_facts()
    assert superseded == 0
    facts = await store.list_facts()
    assert len(facts) == 1


async def test_old_unused_fact_decays(manager: MemoryManager, store: MemoryStore) -> None:
    """A 200-day-old fact with confidence 0.8 decays: 0.8*exp(-200/90) ~ 0.086."""
    old = (datetime.now(timezone.utc) - timedelta(days=200)).isoformat()
    fid = _insert_fact_at(store, "user likes Java", 0.8, old)
    superseded = await manager.decay_facts()
    assert superseded == 1
    fact = await store.get_fact(fid)
    assert fact is not None
    assert fact.superseded_by == fid  # self-superseded


async def test_old_recently_used_fact_survives(
    manager: MemoryManager, store: MemoryStore,
) -> None:
    """A 200-day-old fact bumped yesterday has age_days~1 -> adjusted ~ 0.8*exp(-1/90) ~ 0.79."""
    old = (datetime.now(timezone.utc) - timedelta(days=200)).isoformat()
    recent = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    _insert_fact_at(store, "user likes Go", 0.8, old, last_used_at=recent)
    superseded = await manager.decay_facts()
    assert superseded == 0


async def test_decay_endpoint(
    manager: MemoryManager, store: MemoryStore,
) -> None:
    """POST /memory/decay returns the correct superseded count."""
    old = (datetime.now(timezone.utc) - timedelta(days=300)).isoformat()
    _insert_fact_at(store, "fact A old", 0.7, old)
    _insert_fact_at(store, "fact B old", 0.7, old)
    now = datetime.now(timezone.utc).isoformat()
    _insert_fact_at(store, "fact C new", 0.9, now)

    app = FastAPI()
    app.include_router(memory_router)
    app.state.store = store
    app.state.memory = manager
    app.state.embeddings = FakeEmbeddings(dim=8)

    with TestClient(app) as client:
        resp = client.post("/memory/decay")
        assert resp.status_code == 200
        body = resp.json()
        assert body["superseded"] == 2
