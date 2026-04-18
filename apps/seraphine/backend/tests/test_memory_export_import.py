"""Tests for full memory export/import — Item #8.

Seeds facts + narratives + people + a window; exports; clears DB;
imports; verifies all data restored.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from seraphine.memory import FakeEmbeddings, MemoryManager, MemoryStore
from seraphine.memory.routes import router as memory_router
from tests.test_memory_manager import FakeCollection


def _make_app(store: MemoryStore, manager: MemoryManager) -> FastAPI:
    app = FastAPI()
    app.include_router(memory_router)
    app.state.store = store
    app.state.memory = manager
    app.state.embeddings = FakeEmbeddings(dim=8)
    app.state.llm = None
    return app


@pytest.fixture
async def store(tmp_path: Path) -> MemoryStore:
    s = MemoryStore(tmp_path / "export.sqlite")
    await s.ensure_schema()
    return s


@pytest.fixture
async def manager(store: MemoryStore, tmp_path: Path) -> MemoryManager:
    mgr = MemoryManager(store, FakeEmbeddings(dim=8), tmp_path / "chroma")
    mgr.set_collection_for_tests(FakeCollection())
    return mgr


async def _seed_data(store: MemoryStore) -> None:
    """Populate every exportable section with at least one row."""
    # facts
    await store.add_fact("user likes Python", source="explicit", confidence=0.9)
    await store.add_fact("user is named Jonathan", source="reflection", confidence=0.8)
    # narrative
    await store.add_narrative(
        conversation_id="conv-1",
        text="Discussed infra plans",
        turn_count=6,
        started_at="2026-04-18T10:00:00Z",
        ended_at="2026-04-18T10:30:00Z",
    )
    # person
    await store.upsert_person("Jefferson", relation="coworker")
    # decision
    await store.add_decision(
        subject="cloud provider",
        choice="AWS",
        alternatives="GCP, Azure",
    )
    # open loop
    await store.add_open_loop("buy domain for aura", owner="user")
    # episode window
    await store.add_episode_window(
        id="win-1",
        conversation_id="conv-1",
        first_turn_id="t-1",
        last_turn_id="t-6",
        turn_count=6,
        text="[user] hello\n[assistant] hi",
        started_at="2026-04-18T10:00:00Z",
        ended_at="2026-04-18T10:30:00Z",
        created_at="2026-04-18T10:31:00Z",
    )


async def test_export_includes_all_sections(
    store: MemoryStore, manager: MemoryManager,
) -> None:
    await _seed_data(store)
    app = _make_app(store, manager)
    with TestClient(app) as client:
        resp = client.get("/memory/export")
        assert resp.status_code == 200
        body = resp.json()
        assert body["version"] == 2
        assert len(body["facts"]) == 2
        assert len(body["narratives"]) >= 1
        assert len(body["people"]) >= 1
        assert len(body["decisions"]) >= 1
        assert len(body["open_loops"]) >= 1
        assert len(body["episode_windows"]) >= 1


async def test_export_import_roundtrip(
    tmp_path: Path,
) -> None:
    """Seed -> export -> wipe DB -> import -> verify all data matches."""
    # Phase 1: seed and export
    store1 = MemoryStore(tmp_path / "orig.sqlite")
    await store1.ensure_schema()
    mgr1 = MemoryManager(store1, FakeEmbeddings(dim=8), tmp_path / "c1")
    mgr1.set_collection_for_tests(FakeCollection())
    await _seed_data(store1)

    app1 = _make_app(store1, mgr1)
    with TestClient(app1) as client:
        exported = client.get("/memory/export").json()

    # Phase 2: fresh DB, import
    store2 = MemoryStore(tmp_path / "restored.sqlite")
    await store2.ensure_schema()
    mgr2 = MemoryManager(store2, FakeEmbeddings(dim=8), tmp_path / "c2")
    mgr2.set_collection_for_tests(FakeCollection())

    app2 = _make_app(store2, mgr2)
    with TestClient(app2) as client:
        resp = client.post("/memory/import", json=exported)
        assert resp.status_code == 200
        result = resp.json()

    assert result["imported"]["facts"] == 2
    assert result["imported"]["narratives"] >= 1
    assert result["imported"]["people"] >= 1
    assert result["imported"]["decisions"] >= 1
    assert result["imported"]["open_loops"] >= 1
    assert result["imported"]["episode_windows"] >= 1

    # Verify data in restored store
    facts = await store2.list_facts()
    assert len(facts) == 2
    narratives = await store2.list_narratives()
    assert len(narratives) >= 1
    people = await store2.list_people()
    assert len(people) >= 1
    decisions = await store2.list_all_decisions()
    assert len(decisions) >= 1
    loops = await store2.list_open_loops(only_open=False, limit=100)
    assert len(loops) >= 1
    windows = await store2.list_windows()
    assert len(windows) >= 1


async def test_import_idempotent(
    store: MemoryStore, manager: MemoryManager,
) -> None:
    """Importing the same payload twice should skip duplicates."""
    await _seed_data(store)
    app = _make_app(store, manager)
    with TestClient(app) as client:
        exported = client.get("/memory/export").json()
        # Import once
        r1 = client.post("/memory/import", json=exported).json()
        # Import again — everything should be skipped
        r2 = client.post("/memory/import", json=exported).json()

    # Facts are deduped by text, so importing same texts = skipped.
    assert r2["imported"]["facts"] == 0
    assert r2["skipped"]["facts"] == 2
    # Other sections use INSERT OR IGNORE by id.
    assert r2["imported"]["narratives"] == 0
    assert r2["imported"]["people"] == 0
    assert r2["imported"]["decisions"] == 0
    assert r2["imported"]["open_loops"] == 0
    assert r2["imported"]["episode_windows"] == 0
