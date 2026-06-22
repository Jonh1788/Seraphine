import asyncio
import pytest
from seraphine.memory.store import MemoryStore
from seraphine.flashcards.service import FlashcardsService


@pytest.fixture
async def store(tmp_path):
    s = MemoryStore(tmp_path / "t.sqlite")
    await s.ensure_schema()
    return s


@pytest.mark.asyncio
async def test_create_card_then_edit(store):
    svc = FlashcardsService(store, llm=None)
    card = await svc.create_card(topic="T", front="Frente?", back="Verso", tags=["a"])
    assert card["front"] == "Frente?"
    edited = await svc.edit_card(card["id"], front="Nova frente?", tags=["a", "b"])
    assert edited["front"] == "Nova frente?" and "b" in edited["tags"]

    def _work():
        with store._connect() as conn:
            return conn.execute(
                "SELECT front, tags FROM flashcards WHERE id=?", (card["id"],)
            ).fetchone()
    row = await asyncio.to_thread(_work)
    assert row[0] == "Nova frente?" and "b" in row[1]


@pytest.mark.asyncio
async def test_edit_missing_card_returns_none(store):
    svc = FlashcardsService(store, llm=None)
    assert await svc.edit_card("nope", front="x") is None
