import pytest
from seraphine.memory.store import MemoryStore
from seraphine.flashcards.service import FlashcardsService


class FakeLLM:
    async def tool_call_json(self, **kw):
        assert "Relatório citado" in kw["user"]
        return {"cards": [{"front": "Fato pesquisado?", "back": "Resposta [1]"}]}


class FakeEngine:
    def __init__(self, *, status="done"):
        self._status = status
    async def run(self, query, mode, *, emit):
        return {
            "status": self._status,
            "report": "Relatório citado sobre o tema [1].",
            "sources": [{"n": 1, "url": "https://fonte.com", "title": "Fonte 1"}],
        }


@pytest.fixture
async def store(tmp_path):
    s = MemoryStore(tmp_path / "t.sqlite")
    await s.ensure_schema()
    return s


@pytest.mark.asyncio
async def test_research_deck_grounded_with_sources(store):
    svc = FlashcardsService(store, FakeLLM())
    cards = await svc.create_deck_from_research("Mitocôndria", count=3, engine=FakeEngine())
    assert cards and cards[0]["source_url"] == "https://fonte.com"
    assert cards[0]["source_title"] == "Fonte 1"


@pytest.mark.asyncio
async def test_research_deck_failed_status_raises(store):
    svc = FlashcardsService(store, FakeLLM())
    with pytest.raises(Exception):
        await svc.create_deck_from_research("X", count=3, engine=FakeEngine(status="failed"))
