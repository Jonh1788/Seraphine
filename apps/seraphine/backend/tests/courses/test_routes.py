import asyncio
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from seraphine.courses.routes import router
from seraphine.courses.schema import migrate
from seraphine.memory.store import MemoryStore


class FakeLLM:
    async def tool_call_json(self, *, tool, **kw):
        if tool["name"] == "make_outline":
            return {"lessons": [{"title": f"L{i}", "objective": "o"} for i in range(4)]}
        return {"concept_md": "# t", "exercises": [
            {"type": "mcq", "prompt": "P?",
             "payload": {"options": ["a", "b"], "answer_idx": 0}, "explanation": "e"}]}


class FakeEngine:
    async def run(self, q, mode, *, emit):
        return {"status": "done", "report": "relatório [1]", "sources": []}


@pytest.fixture
def client(tmp_path):
    store = MemoryStore(tmp_path / "t.sqlite")
    store.register_migrator("courses", migrate)
    asyncio.run(store.ensure_schema())
    app = FastAPI()
    app.include_router(router)
    app.state.store = store
    app.state.llm = FakeLLM()
    app.state.deepsearch_service = None
    app.state.tools = None
    app.state.courses_engine = FakeEngine()  # test hook (ver Step 3)
    return TestClient(app)


def test_create_and_get_stats(client):
    r = client.post("/courses", json={"topic": "Redes neurais"})
    assert r.status_code == 200
    assert r.json()["status"] == "generating"
    s = client.get("/courses/stats")
    assert s.status_code == 200
    assert s.json()["xp_total"] == 0


def test_create_empty_topic_400(client):
    r = client.post("/courses", json={"topic": "  "})
    assert r.status_code == 400


def test_list_courses(client):
    client.post("/courses", json={"topic": "X"})
    r = client.get("/courses")
    assert r.status_code == 200
    assert len(r.json()["courses"]) >= 1


def test_create_with_invalid_tutor_400(client):
    r = client.post("/courses", json={"topic": "X", "tutor_model": "banana"})
    assert r.status_code == 400


def test_create_with_tutor_ok(client):
    r = client.post("/courses", json={"topic": "X", "tutor_model": "cliproxy:claude-haiku-4-5"})
    assert r.status_code == 200


def test_models_endpoint_empty_without_ds(client):
    r = client.get("/courses/models")
    assert r.status_code == 200
    assert r.json() == {"models": []}
