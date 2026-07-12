import json

import pytest

from seraphine.courses.schema import migrate
from seraphine.courses.service import CoursesService
from seraphine.memory.store import MemoryStore


class FakeFlashcards:
    def __init__(self):
        self.seeded = []
    async def insert_cards(self, topic, pairs, **kw):
        self.seeded.append((topic, pairs))
        return pairs


async def _store(tmp_path):
    s = MemoryStore(tmp_path / "t.sqlite")
    s.register_migrator("courses", migrate)
    await s.ensure_schema()
    with s._connect() as conn:
        conn.execute("INSERT INTO course (id, topic, title, status, created_ts)"
                     " VALUES ('c0','Luz','Luz','ready','t')")
        conn.execute("INSERT INTO lesson (id, course_id, order_idx, title, status)"
                     " VALUES ('l0','c0',0,'L0','ok')")
        for j in range(3):
            conn.execute("INSERT INTO exercise (id, lesson_id, order_idx, type, prompt, payload_json, explanation)"
                         " VALUES (?,?,?,?,?,?,?)",
                         (f"e{j}", "l0", j, "mcq", f"P{j}?",
                          json.dumps({"options": ["a", "b"], "answer_idx": 0}), "expl"))
        conn.commit()
    return s


def _set_last_day(store, day):
    with store._connect() as conn:
        conn.execute("INSERT INTO learning_stats (id, xp_total, streak_count, streak_last_day)"
                     " VALUES (1,0,?,?) ON CONFLICT(id) DO UPDATE SET streak_count=?, streak_last_day=?",
                     (5, day, 5, day))
        conn.commit()


@pytest.mark.asyncio
async def test_complete_awards_xp_and_marks_done(tmp_path):
    store = await _store(tmp_path)
    fc = FakeFlashcards()
    svc = CoursesService(store, flashcards=fc)
    out = await svc.complete_lesson("l0", correct=3)
    assert out["xp_gained"] == 3 * 10 + 20
    assert out["already_done"] is False
    with store._connect() as conn:
        st = conn.execute("SELECT status FROM lesson_progress WHERE lesson_id='l0'").fetchone()[0]
    assert st == "done"
    assert fc.seeded  # semeou cards SM-2
    assert fc.seeded[0][0] == "Trilha: Luz"


@pytest.mark.asyncio
async def test_complete_idempotent_no_double_xp(tmp_path):
    store = await _store(tmp_path)
    svc = CoursesService(store, flashcards=FakeFlashcards())
    await svc.complete_lesson("l0", correct=2)
    stats1 = await svc.get_stats()
    out2 = await svc.complete_lesson("l0", correct=3)
    stats2 = await svc.get_stats()
    assert out2["already_done"] is True
    assert out2["xp_gained"] == 0
    assert stats1["xp_total"] == stats2["xp_total"]  # sem XP em dobro


@pytest.mark.asyncio
async def test_streak_increments_from_yesterday(tmp_path):
    from datetime import datetime, timedelta, timezone
    store = await _store(tmp_path)
    yesterday = (datetime.now(timezone.utc).date() - timedelta(days=1)).isoformat()
    _set_last_day(store, yesterday)
    svc = CoursesService(store, flashcards=FakeFlashcards())
    out = await svc.complete_lesson("l0", correct=1)
    assert out["streak_count"] == 6  # 5 + 1


@pytest.mark.asyncio
async def test_streak_resets_after_gap(tmp_path):
    store = await _store(tmp_path)
    _set_last_day(store, "2020-01-01")
    svc = CoursesService(store, flashcards=FakeFlashcards())
    out = await svc.complete_lesson("l0", correct=1)
    assert out["streak_count"] == 1  # gap → reseta pra 1
