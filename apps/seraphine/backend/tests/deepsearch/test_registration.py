"""HTTP-level test for the /deepsearch router registration.

Boots a minimal FastAPI app with only the deepsearch router mounted and a
real ``DeepSearchService`` over a tmp ``MemoryStore`` — mirrors
``tests/test_insights_routes.py`` so we exercise the route + service +
schema wiring without paying for the full ``create_app()`` lifespan
(which boots STT/TTS/LLM warmup and network sidecars).
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from seraphine.deepsearch import schema as deepsearch_schema
from seraphine.deepsearch.routes import router as deepsearch_router
from seraphine.deepsearch.service import DeepSearchService
from seraphine.memory.store import MemoryStore


@pytest.fixture
async def store(tmp_path: Path) -> MemoryStore:
    s = MemoryStore(tmp_path / "deepsearch_reg.sqlite")
    s.register_migrator("seraphine_deepsearch", deepsearch_schema.migrate)
    await s.ensure_schema()
    return s


def _make_app(*, service: DeepSearchService) -> FastAPI:
    app = FastAPI()
    app.include_router(deepsearch_router)
    app.state.deepsearch_service = service
    return app


async def test_config_endpoint_live(store: MemoryStore) -> None:
    service = DeepSearchService(store, llm=None, tools=None, settings=None)
    app = _make_app(service=service)
    with TestClient(app) as client:
        r = client.get("/deepsearch/config")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["fanout_model"].startswith("cliproxy:")
        assert body["synth_model"].startswith("cliproxy:")
        assert body["openrouter_key_set"] is False
