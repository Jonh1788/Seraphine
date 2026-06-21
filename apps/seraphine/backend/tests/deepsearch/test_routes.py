"""HTTP-level tests for the full /deepsearch router (Task 4.2).

Boots a minimal FastAPI app with only the deepsearch router + a real
``DeepSearchService`` over a tmp ``MemoryStore`` (mirrors
``test_registration.py``), with ``DeepResearchEngine`` monkeypatched to a fake
so no network / LLM / tool calls happen.

Because the run executes in a background ``asyncio.Task`` while ``TestClient``
drives the app on its own loop, we settle the task by polling the run status
through the API (``GET /deepsearch/{id}``) until it leaves ``running``.
"""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from seraphine.deepsearch import schema as deepsearch_schema
from seraphine.deepsearch.routes import router as deepsearch_router
from seraphine.deepsearch.service import DeepSearchService
from seraphine.memory.store import MemoryStore


class _FakeEngine:
    def __init__(self, *, fanout, synth, tools):
        self.fanout = fanout
        self.synth = synth
        self.tools = tools

    async def run(self, question, mode, *, emit):
        await _maybe_await(emit({"type": "query", "q": "q1"}))
        await _maybe_await(
            emit({"type": "source_found", "url": "u", "title": "t"})
        )
        report = "R [1]"
        sources = [{"url": "u", "title": "t", "n": 1}]
        await _maybe_await(
            emit({"type": "report", "markdown": report, "sources": sources})
        )
        await _maybe_await(emit({"type": "done", "status": "done"}))
        return {"report": report, "sources": sources, "status": "done"}


async def _maybe_await(value):
    if asyncio.iscoroutine(value):
        return await value
    return value


class _Tools:
    def get(self, name):
        return object()


@pytest.fixture
def client(tmp_path: Path, monkeypatch) -> TestClient:
    monkeypatch.setattr(
        "seraphine.deepsearch.service.DeepResearchEngine", _FakeEngine
    )
    app = FastAPI()
    app.include_router(deepsearch_router)

    async def _build() -> None:
        store = MemoryStore(tmp_path / "deepsearch_routes.sqlite")
        store.register_migrator("seraphine_deepsearch", deepsearch_schema.migrate)
        await store.ensure_schema()
        app.state.deepsearch_service = DeepSearchService(
            store, llm=object(), tools=_Tools(), settings=None
        )

    asyncio.new_event_loop().run_until_complete(_build())
    with TestClient(app) as c:
        yield c


def _settle(client: TestClient, run_id: str, timeout: float = 5.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        r = client.get(f"/deepsearch/{run_id}")
        assert r.status_code == 200, r.text
        body = r.json()
        if body["status"] != "running":
            return body
        time.sleep(0.02)
    raise AssertionError("run did not settle in time")


def test_start_and_get_run(client: TestClient):
    r = client.post("/deepsearch", json={"query": "o que é X?", "mode": "quick"})
    assert r.status_code == 200, r.text
    run_id = r.json()["id"]
    assert run_id.startswith("ds-")

    body = _settle(client, run_id)
    assert body["status"] == "done"
    assert body["report"] == "R [1]"
    assert body["sources"] == [{"url": "u", "title": "t", "n": 1}]
    assert body["query"] == "o que é X?"
    assert body["mode"] == "quick"


def test_get_run_404(client: TestClient):
    r = client.get("/deepsearch/ds-doesnotexist")
    assert r.status_code == 404


def test_stream_ndjson_ends_in_done(client: TestClient):
    r = client.post("/deepsearch", json={"query": "pergunta?"})
    run_id = r.json()["id"]
    _settle(client, run_id)

    resp = client.get(f"/deepsearch/{run_id}/stream")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("application/x-ndjson")
    lines = [ln for ln in resp.text.splitlines() if ln.strip()]
    assert lines
    first = json.loads(lines[0])
    assert first["type"] == "snapshot"
    last = json.loads(lines[-1])
    assert last["type"] == "done"


def test_list_runs(client: TestClient):
    r = client.post("/deepsearch", json={"query": "pergunta?"})
    run_id = r.json()["id"]
    _settle(client, run_id)

    r2 = client.get("/deepsearch")
    assert r2.status_code == 200
    runs = r2.json()["runs"]
    assert any(run["id"] == run_id for run in runs)


def test_config_roundtrip_and_key_toggle(client: TestClient):
    # Default config (from M1 seed).
    r = client.get("/deepsearch/config")
    assert r.json()["openrouter_key_set"] is False

    put = client.put(
        "/deepsearch/config",
        json={
            "fanout_model": "cliproxy:claude-sonnet-4-6",
            "synth_model": "cliproxy:claude-opus-4-8",
            "openrouter_key": "sk-or-test",
        },
    )
    assert put.status_code == 200, put.text
    body = put.json()
    assert body["fanout_model"] == "cliproxy:claude-sonnet-4-6"
    assert body["synth_model"] == "cliproxy:claude-opus-4-8"
    assert body["openrouter_key_set"] is True
    assert "openrouter_key" not in body

    after = client.get("/deepsearch/config").json()
    assert after["fanout_model"] == "cliproxy:claude-sonnet-4-6"
    assert after["openrouter_key_set"] is True


def test_models_endpoint(client: TestClient):
    r = client.get("/deepsearch/models")
    assert r.status_code == 200
    body = r.json()
    assert "cliproxy" in body and "openrouter" in body
    ids = [m["id"] for m in body["cliproxy"]]
    assert "cliproxy:claude-opus-4-8" in ids
    assert body["openrouter"] == []


def test_cancel_endpoint(client: TestClient):
    r = client.post("/deepsearch", json={"query": "pergunta?"})
    run_id = r.json()["id"]
    c = client.post(f"/deepsearch/{run_id}/cancel")
    assert c.status_code == 200
    assert c.json() == {"ok": True}
