import asyncio
import json

import pytest

from seraphine.courses import generate as gen
from seraphine.courses.schema import migrate
from seraphine.memory.store import MemoryStore


class FakeEngine:
    def __init__(self, status="done"):
        self._status = status
    async def run(self, query, mode, *, emit):
        return {"status": self._status,
                "report": "Fótons são partículas de luz [1].",
                "sources": [{"n": 1, "url": "http://x", "title": "Luz"}]}


class FakeLLM:
    """Retorna outline no 1º call, e uma lição válida nos demais."""
    def __init__(self):
        self.calls = 0
    async def tool_call_json(self, *, system, user, tool, **kw):
        self.calls += 1
        if tool["name"] == "make_outline":
            return {"lessons": [
                {"title": "Introdução à luz", "objective": "o que é luz"},
                {"title": "Fótons", "objective": "quantização"},
                {"title": "Espectro", "objective": "cores e comprimento de onda"},
            ]}
        return {"concept_md": "# Luz\nA luz é...", "exercises": [
            {"type": "mcq", "prompt": "O que é fóton?",
             "payload": {"options": ["onda", "partícula de luz", "átomo"], "answer_idx": 1},
             "explanation": "É o quantum de luz."},
            {"type": "type", "prompt": "Unidade quântica de luz?",
             "payload": {"accepted": ["fóton", "photon"], "rubric": "aceita sinônimos"}},
        ]}


@pytest.mark.asyncio
async def test_research_digest_raises_when_search_fails():
    with pytest.raises(gen.CourseGenerationError):
        await gen.research_digest(FakeEngine(status="error"), "luz")


@pytest.mark.asyncio
async def test_make_outline_returns_lessons():
    lessons = await gen.make_outline(FakeLLM(), topic="Luz", digest="…")
    assert len(lessons) == 3
    assert lessons[0]["title"] == "Introdução à luz"


@pytest.mark.asyncio
async def test_make_lesson_filters_valid_exercises():
    out = await gen.make_lesson(FakeLLM(), topic="Luz", digest="…",
                                title="Fótons", objective="quantização")
    assert out["concept_md"].startswith("# Luz")
    assert len(out["exercises"]) == 2
    assert {e["type"] for e in out["exercises"]} == {"mcq", "type"}


@pytest.mark.asyncio
async def test_generate_course_persists_ready(tmp_path):
    store = MemoryStore(tmp_path / "t.sqlite")
    store.register_migrator("courses", migrate)
    await store.ensure_schema()
    cid = "c1"
    with store._connect() as conn:
        conn.execute(
            "INSERT INTO course (id, topic, status, created_ts) VALUES (?,?,?,?)",
            (cid, "Luz", "generating", "2026-07-12T00:00:00+00:00"),
        )
    await gen.generate_course(store, course_id=cid, topic="Luz",
                              llm=FakeLLM(), engine=FakeEngine())
    with store._connect() as conn:
        status = conn.execute("SELECT status FROM course WHERE id=?", (cid,)).fetchone()[0]
        n_lessons = conn.execute("SELECT COUNT(*) FROM lesson WHERE course_id=?", (cid,)).fetchone()[0]
        n_ex = conn.execute("SELECT COUNT(*) FROM exercise").fetchone()[0]
    assert status == "ready"
    assert n_lessons == 3
    assert n_ex == 6  # 3 lessons × 2 exercises


@pytest.mark.asyncio
async def test_generate_course_marks_failed_on_research_error(tmp_path):
    store = MemoryStore(tmp_path / "t.sqlite")
    store.register_migrator("courses", migrate)
    await store.ensure_schema()
    cid = "c2"
    with store._connect() as conn:
        conn.execute(
            "INSERT INTO course (id, topic, status, created_ts) VALUES (?,?,?,?)",
            (cid, "Luz", "generating", "2026-07-12T00:00:00+00:00"),
        )
    await gen.generate_course(store, course_id=cid, topic="Luz",
                              llm=FakeLLM(), engine=FakeEngine(status="error"))
    with store._connect() as conn:
        status = conn.execute("SELECT status FROM course WHERE id=?", (cid,)).fetchone()[0]
    assert status == "failed"
