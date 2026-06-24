"""Tests for the learning REST routes (Task 6).

Mirrors ``tests/telemetry/test_routes.py``: a plain ``TestClient`` over a
FastAPI app whose ``app.state.learning_service`` is a real ``LearningService``
backed by an in-memory store and a deterministic scripted ``llm_call`` (same
branching as ``tests/learning/test_service.py``).
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from core_db import Store

from seraphine.learning import schema as learning_schema
from seraphine.learning.routes import router
from seraphine.learning.service import LearningService


def _make_store(tmp_path: Path, name: str = "routes.sqlite") -> Store:
    store = Store(tmp_path / name)
    store.register_migrator("learning", learning_schema.migrate)
    asyncio.run(store.ensure_schema())
    return store


def make_llm(judge_score: float = 0.9, optimizer_json: str | None = None):
    """Deterministic scripted llm_call branching on message content.

    - optimizer turn: "WHITELISTED KNOBS" in messages[0]["content"]
    - judge turn:     "RUBRIC" in messages[-1]["content"]
    - else:           responder
    """
    OPT = optimizer_json or (
        '{"behavior_addendum":"Seja conciso.","tool_guidance":"",'
        '"knobs":{"recall_fact_limit":12},"rationale":"r"}'
    )

    async def llm(messages):
        last = messages[-1]["content"]
        first = messages[0]["content"]
        if "WHITELISTED KNOBS" in first:
            return OPT
        if "RUBRIC" in last:
            return '{"score": %s}' % judge_score
        return "uma resposta"  # responder

    return llm


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    store = _make_store(tmp_path)
    svc = LearningService(store, make_llm(judge_score=0.9))

    app = FastAPI()
    app.include_router(router)
    app.state.learning_service = svc
    return TestClient(app)


def test_knobs_endpoint(client: TestClient):
    r = client.get("/learning/knobs")
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body, list)
    assert len(body) == 3
    for k in body:
        assert "name" in k and "kind" in k and "default" in k


def test_active_default(client: TestClient):
    r = client.get("/learning/active")
    assert r.status_code == 200
    body = r.json()
    assert body["version"] == 0
    assert body["behavior_addendum"] == ""


def test_run_then_list_and_promote(client: TestClient):
    run = client.post("/learning/run")
    assert run.status_code == 200
    assert run.json()["status"] == "pending"

    listed = client.get("/learning/candidates?status=pending")
    assert listed.status_code == 200
    cands = listed.json()
    assert len(cands) == 1
    cid = cands[0]["id"]

    promote = client.post(f"/learning/candidates/{cid}/promote")
    assert promote.status_code == 200
    version = promote.json()["version"]
    assert version >= 1

    active = client.get("/learning/active")
    assert active.status_code == 200
    body = active.json()
    assert body["version"] == version
    assert body["behavior_addendum"] == "Seja conciso."


def test_get_missing_candidate_404(client: TestClient):
    r = client.get("/learning/candidates/nope")
    assert r.status_code == 404


def test_promote_missing_400(client: TestClient):
    r = client.post("/learning/candidates/nope/promote")
    assert r.status_code == 400


def test_traces_endpoint(client: TestClient):
    r = client.get("/learning/traces?limit=5")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


def test_no_service_503():
    app = FastAPI()
    app.include_router(router)
    # No app.state.learning_service set on purpose.
    c = TestClient(app)
    r = c.get("/learning/active")
    assert r.status_code == 503
