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
async def test_create_course_from_code(tmp_path):
    store = await _store(tmp_path)
    svc = CoursesService(store, llm=object(), engine=object())
    captured = {}
    def spawn(coro):
        captured["coro"] = coro
        coro.close()
    svc._spawn = spawn
    out = await svc.create_course(code="int main() { return 0; }", focus="math")
    assert out["status"] == "generating"
    with store._connect() as conn:
        row = conn.execute("SELECT topic, source_ref FROM course WHERE id=?",
                           (out["course_id"],)).fetchone()
    assert row == ("Matemática do código", "code")


@pytest.mark.asyncio
async def test_create_course_requires_topic_or_code(tmp_path):
    store = await _store(tmp_path)
    svc = CoursesService(store)
    with pytest.raises(ValueError):
        await svc.create_course()
