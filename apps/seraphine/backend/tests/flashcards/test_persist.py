import pytest
from seraphine.memory.store import MemoryStore
from seraphine.flashcards.service import FlashcardsService


class FakeLLM:
    async def tool_call_json(self, *, system, user, tool, cache_system=False, max_tokens=1024, model=None):
        return {"cards": [{"front": "Pergunta um?", "back": "Resposta um"}]}


@pytest.fixture
async def store(tmp_path):
    s = MemoryStore(tmp_path / "t.sqlite")
    await s.ensure_schema()
    return s


@pytest.mark.asyncio
async def test_insert_cards_persists_source_and_tags(store):
    svc = FlashcardsService(store, FakeLLM())
    created = await svc.insert_cards(
        "Bio", [{"front": "F?", "back": "Back"}],
        tags=["bio"], source_url="https://x", source_title="Artigo X",
    )
    assert len(created) == 1
    import asyncio
    def _work():
        with store._connect() as conn:
            return conn.execute(
                "SELECT topic, tags, source_url, source_title FROM flashcards WHERE id=?",
                (created[0]["id"],),
            ).fetchone()
    row = await asyncio.to_thread(_work)
    assert row[0] == "Bio" and row[2] == "https://x" and row[3] == "Artigo X"
    assert "bio" in row[1]


@pytest.mark.asyncio
async def test_create_deck_uses_generate_cards(store):
    svc = FlashcardsService(store, FakeLLM())
    cards = await svc.create_deck("Fotossíntese", count=3)
    assert len(cards) == 1 and cards[0]["front"] == "Pergunta um?"
