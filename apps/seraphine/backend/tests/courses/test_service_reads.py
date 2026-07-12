import asyncio
import json

import pytest

from seraphine.courses.schema import migrate
from seraphine.courses.service import CoursesService
from seraphine.memory.store import MemoryStore


async def _store(tmp_path):
    s = MemoryStore(tmp_path / "t.sqlite")
    s.register_migrator("courses", migrate)
    await s.ensure_schema()
    return s


def _seed_course(store, cid="c1", n_lessons=3):
    with store._connect() as conn:
        conn.execute("INSERT INTO course (id, topic, title, status, created_ts)"
                     " VALUES (?,?,?,?,?)", (cid, "Luz", "Luz", "ready", "2026-01-01T00:00:00+00:00"))
        lids = []
        for i in range(n_lessons):
            lid = f"l{i}"
            lids.append(lid)
            conn.execute("INSERT INTO lesson (id, course_id, order_idx, title, concept_md, status)"
                         " VALUES (?,?,?,?,?,?)", (lid, cid, i, f"Lição {i}", "# t", "ok"))
            conn.execute("INSERT INTO exercise (id, lesson_id, order_idx, type, prompt, payload_json, explanation, concept_key)"
                         " VALUES (?,?,?,?,?,?,?,?)",
                         (f"e{i}", lid, 0, "type", "P?",
                          json.dumps({"accepted": ["x"], "rubric": "r"}), "expl", "k"))
        conn.commit()
    return lids


@pytest.mark.asyncio
async def test_create_course_inserts_generating_and_spawns(tmp_path):
    store = await _store(tmp_path)
    spawned = {}
    svc = CoursesService(store, llm=object(), engine=object())
    svc._spawn = lambda coro: spawned.setdefault("n", 0) or spawned.update(n=spawned.get("n", 0) + 1)
    out = await svc.create_course("Redes neurais")
    assert out["status"] == "generating"
    with store._connect() as conn:
        row = conn.execute("SELECT topic, status FROM course WHERE id=?", (out["course_id"],)).fetchone()
    assert row == ("Redes neurais", "generating")
    assert spawned["n"] == 1


@pytest.mark.asyncio
async def test_get_course_lock_chain(tmp_path):
    store = await _store(tmp_path)
    _seed_course(store, n_lessons=3)
    svc = CoursesService(store)
    course = await svc.get_course("c1")
    locks = [x["lock"] for x in course["lessons"]]
    assert locks == ["unlocked", "locked", "locked"]  # only first unlocked
    # mark lesson 0 done → lesson 1 unlocks
    with store._connect() as conn:
        conn.execute("INSERT INTO lesson_progress (lesson_id, status, completed_ts)"
                     " VALUES ('l0','done','t')")
        conn.commit()
    course = await svc.get_course("c1")
    assert [x["lock"] for x in course["lessons"]] == ["done", "unlocked", "locked"]


@pytest.mark.asyncio
async def test_get_lesson_strips_type_answers(tmp_path):
    store = await _store(tmp_path)
    _seed_course(store, n_lessons=1)
    svc = CoursesService(store)
    lesson = await svc.get_lesson("l0")
    ex = lesson["exercises"][0]
    assert ex["type"] == "type"
    assert "accepted" not in ex["payload"]  # gabarito não vaza
    assert "rubric" not in ex["payload"]


@pytest.mark.asyncio
async def test_list_courses_counts(tmp_path):
    store = await _store(tmp_path)
    _seed_course(store, n_lessons=3)
    svc = CoursesService(store)
    rows = await svc.list_courses()
    assert rows[0]["total"] == 3
    assert rows[0]["done"] == 0
