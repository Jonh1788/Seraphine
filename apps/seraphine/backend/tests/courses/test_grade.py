import json

import pytest

from seraphine.courses.schema import migrate
from seraphine.courses.service import CoursesService, _normalize
from seraphine.memory.store import MemoryStore


class JudgeLLM:
    def __init__(self, verdict):
        self.verdict = verdict
        self.called = 0
    async def tool_call_json(self, **kw):
        self.called += 1
        return {"correct": self.verdict}


async def _store_with_type_ex(tmp_path, accepted):
    s = MemoryStore(tmp_path / "t.sqlite")
    s.register_migrator("courses", migrate)
    await s.ensure_schema()
    with s._connect() as conn:
        conn.execute("INSERT INTO lesson (id, course_id, order_idx, title, status)"
                     " VALUES ('l0','c0',0,'L','ok')")
        conn.execute("INSERT INTO exercise (id, lesson_id, order_idx, type, prompt, payload_json, explanation)"
                     " VALUES ('e0','l0',0,'type','Capital?',?,?)",
                     (json.dumps({"accepted": accepted, "rubric": "aceita a cidade"}), "É Brasília."))
        conn.commit()
    return s


def test_normalize_strips_accents_and_case():
    assert _normalize("  Brasília ") == "brasilia"


@pytest.mark.asyncio
async def test_grade_exact_match_no_llm(tmp_path):
    store = await _store_with_type_ex(tmp_path, ["Brasília"])
    judge = JudgeLLM(False)
    svc = CoursesService(store, llm=judge)
    out = await svc.grade_type("e0", "brasilia")
    assert out["correct"] is True
    assert judge.called == 0  # normalize resolveu, não chamou o juiz


@pytest.mark.asyncio
async def test_grade_synonym_via_judge(tmp_path):
    store = await _store_with_type_ex(tmp_path, ["Brasília"])
    judge = JudgeLLM(True)
    svc = CoursesService(store, llm=judge)
    out = await svc.grade_type("e0", "a capital federal")
    assert out["correct"] is True
    assert judge.called == 1


@pytest.mark.asyncio
async def test_grade_wrong_when_judge_rejects(tmp_path):
    store = await _store_with_type_ex(tmp_path, ["Brasília"])
    svc = CoursesService(store, llm=JudgeLLM(False))
    out = await svc.grade_type("e0", "Paris")
    assert out["correct"] is False


@pytest.mark.asyncio
async def test_grade_judge_down_falls_back_to_normalize(tmp_path):
    store = await _store_with_type_ex(tmp_path, ["Brasília"])

    class Boom:
        async def tool_call_json(self, **kw):
            raise RuntimeError("llm down")

    svc = CoursesService(store, llm=Boom())
    ok = await svc.grade_type("e0", "Brasília")
    bad = await svc.grade_type("e0", "outra coisa")
    assert ok["correct"] is True   # normalize casa mesmo com juiz down
    assert bad["correct"] is False
