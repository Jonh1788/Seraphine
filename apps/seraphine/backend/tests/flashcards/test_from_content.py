import pytest
from seraphine.memory.store import MemoryStore
from seraphine.flashcards.service import FlashcardsService


class FakeLLM:
    async def tool_call_json(self, **kw):
        assert "conteúdo da nota" in kw["user"] or "texto colado" in kw["user"]
        return {"cards": [{"front": "F do conteúdo?", "back": "B do conteúdo"}]}


@pytest.fixture
async def store(tmp_path):
    s = MemoryStore(tmp_path / "t.sqlite")
    await s.ensure_schema()
    return s


@pytest.mark.asyncio
async def test_from_text_generates_and_persists(store):
    svc = FlashcardsService(store, FakeLLM())
    cards = await svc.create_deck_from_text(
        topic="Minha nota", text="conteúdo da nota aqui", count=3, tags=["estudo"],
    )
    assert cards and cards[0]["front"] == "F do conteúdo?"
    assert cards[0]["tags"] == ["estudo"]
