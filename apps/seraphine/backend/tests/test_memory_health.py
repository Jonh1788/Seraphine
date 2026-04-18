"""HTTP-level tests for GET /memory/health.

Boots a minimal FastAPI with the memory router and stubs for
``app.state.{store,memory,embeddings}``. Exercises the overall-ok,
warnings-counter, and last-reflect surfaces that /memory/health
reports to catch silent-degradation bugs.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from seraphine.memory import FakeEmbeddings, MemoryManager, MemoryStore
from seraphine.memory.routes import router as memory_router


class _FakeCollection:
    def __init__(self, count: int = 0) -> None:
        self._count = count

    def count(self) -> int:
        return self._count


class _UnreachableEmbeddings:
    async def embed(self, texts: list[str]) -> list[list[float]]:
        raise RuntimeError("ollama unreachable")

    async def health(self) -> dict[str, Any]:
        return {
            "reachable": False,
            "model_loaded": False,
            "latency_ms": None,
            "error": "ollama unreachable",
            "model": "nomic-embed-text",
        }


def _make_app(
    *,
    store: MemoryStore,
    memory: MemoryManager,
    embeddings: Any,
) -> FastAPI:
    app = FastAPI()
    app.include_router(memory_router)
    app.state.store = store
    app.state.memory = memory
    app.state.embeddings = embeddings
    return app


@pytest.fixture
async def store(tmp_path: Path) -> MemoryStore:
    s = MemoryStore(tmp_path / "health.sqlite")
    await s.ensure_schema()
    return s


async def test_health_green_when_everything_up(store: MemoryStore, tmp_path: Path) -> None:
    emb = FakeEmbeddings(dim=8)
    mgr = MemoryManager(store, emb, tmp_path / "chroma")
    mgr.set_collection_for_tests(_FakeCollection(count=42))
    app = _make_app(store=store, memory=mgr, embeddings=emb)
    with TestClient(app) as client:
        resp = client.get("/memory/health")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["ok"] is True
        assert body["ollama"]["reachable"] is True
        assert body["ollama"]["model_loaded"] is True
        assert body["chroma"] == {"reachable": True, "count": 42}
        assert body["facts"] == {"active": 0, "superseded": 0, "total": 0}
        assert body["last_reflect_at"] is None
        assert body["warnings_24h"] == 0


async def test_health_reports_ollama_down(store: MemoryStore, tmp_path: Path) -> None:
    emb = _UnreachableEmbeddings()
    mgr = MemoryManager(store, emb, tmp_path / "chroma")
    mgr.set_collection_for_tests(_FakeCollection(count=0))
    app = _make_app(store=store, memory=mgr, embeddings=emb)
    with TestClient(app) as client:
        resp = client.get("/memory/health")
        body = resp.json()
        assert body["ok"] is False
        assert body["ollama"]["reachable"] is False


async def test_health_counts_embed_warnings(store: MemoryStore, tmp_path: Path) -> None:
    emb = _UnreachableEmbeddings()
    mgr = MemoryManager(store, emb, tmp_path / "chroma")
    mgr.set_collection_for_tests(_FakeCollection(count=0))
    # Trigger two warnings: one on recall, one on remember_episode.
    await mgr.recall("anything", k=3)
    from seraphine.memory.store import Turn
    await mgr.remember_episode(
        Turn(
            id="t-warn",
            conversation_id="c1",
            role="user",
            content="x",
            created_at="2026-04-18T00:00:00+00:00",
        )
    )
    app = _make_app(store=store, memory=mgr, embeddings=emb)
    with TestClient(app) as client:
        body = client.get("/memory/health").json()
        assert body["warnings_24h"] >= 2


async def test_health_surfaces_last_reflect_event(
    store: MemoryStore, tmp_path: Path,
) -> None:
    emb = FakeEmbeddings(dim=8)
    mgr = MemoryManager(store, emb, tmp_path / "chroma")
    mgr.set_collection_for_tests(_FakeCollection(count=0))
    await store.add_event(
        event_type="reflect_success",
        summary="reflect: +3 fact(s)",
        source="memory",
        metadata={"inserted": 3, "candidates": 5},
    )
    app = _make_app(store=store, memory=mgr, embeddings=emb)
    with TestClient(app) as client:
        body = client.get("/memory/health").json()
        assert body["last_reflect_at"] is not None
        assert body["last_reflect_inserted"] == 3
