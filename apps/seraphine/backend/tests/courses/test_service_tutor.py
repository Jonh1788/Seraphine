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


@pytest.mark.asyncio
async def test_create_course_stores_tutor_and_source_ref(tmp_path):
    store = await _store(tmp_path)
    svc = CoursesService(store, llm=object(), engine=object())
    svc._spawn = lambda coro: coro.close()
    out = await svc.create_course("https://chatgpt.com/share/abc", tutor_model="openrouter:x")
    with store._connect() as conn:
        row = conn.execute("SELECT tutor_model, source_ref FROM course WHERE id=?",
                           (out["course_id"],)).fetchone()
    assert row == ("openrouter:x", "https://chatgpt.com/share/abc")


@pytest.mark.asyncio
async def test_grade_type_uses_course_tutor(tmp_path, monkeypatch):
    store = await _store(tmp_path)
    with store._connect() as conn:
        conn.execute("INSERT INTO course (id, topic, status, created_ts, tutor_model)"
                     " VALUES ('c1','T','ready','t','openrouter:x')")
        conn.execute("INSERT INTO lesson (id, course_id, order_idx, title, status)"
                     " VALUES ('l1','c1',0,'L','ok')")
        conn.execute("INSERT INTO exercise (id, lesson_id, order_idx, type, prompt, payload_json, explanation)"
                     " VALUES ('e1','l1',0,'type','P?',?,?)",
                     (json.dumps({"accepted": ["resposta"], "rubric": "r"}), "ok"))
        conn.commit()

    used = {}
    class FakeJudge:
        async def tool_call_json(self, **kw):
            used["judge"] = True
            return {"correct": True}
    import seraphine.courses.service as svcmod
    monkeypatch.setattr(svcmod, "tutor_llm",
                        lambda spec, *, app_llm, openrouter_key: used.setdefault("spec", spec) and FakeJudge() or FakeJudge())
    svc = CoursesService(store, llm=object(), openrouter_key="k")
    out = await svc.grade_type("e1", "sinônimo qualquer")
    assert out["correct"] is True
    assert used["spec"] == "openrouter:x"


@pytest.mark.asyncio
async def test_grade_type_tutor_error_falls_back(tmp_path, monkeypatch):
    store = await _store(tmp_path)
    with store._connect() as conn:
        conn.execute("INSERT INTO course (id, topic, status, created_ts, tutor_model)"
                     " VALUES ('c1','T','ready','t','openrouter:x')")
        conn.execute("INSERT INTO lesson (id, course_id, order_idx, title, status)"
                     " VALUES ('l1','c1',0,'L','ok')")
        conn.execute("INSERT INTO exercise (id, lesson_id, order_idx, type, prompt, payload_json, explanation)"
                     " VALUES ('e1','l1',0,'type','P?',?,?)",
                     (json.dumps({"accepted": ["certa"], "rubric": ""}), ""))
        conn.commit()
    import seraphine.courses.service as svcmod
    def boom(spec, *, app_llm, openrouter_key):
        raise RuntimeError("modelo inexistente")
    monkeypatch.setattr(svcmod, "tutor_llm", boom)
    svc = CoursesService(store, llm=object())
    ok = await svc.grade_type("e1", "certa")     # normalize acerta mesmo sem juiz
    bad = await svc.grade_type("e1", "errada")
    assert ok["correct"] is True and bad["correct"] is False
