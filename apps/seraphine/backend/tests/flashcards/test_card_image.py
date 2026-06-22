import pytest
from seraphine.memory.store import MemoryStore
from seraphine.flashcards.service import FlashcardsService


class OkImageSvc:
    async def generate(self, *, prompt, **kw):
        return {"id": "img1", "url": "/images/img1.png"}


class BudgetImageSvc:
    async def generate(self, *, prompt, **kw):
        raise RuntimeError("daily image budget exceeded (> $5.00)")


@pytest.fixture
async def store(tmp_path):
    s = MemoryStore(tmp_path / "t.sqlite")
    await s.ensure_schema()
    return s


@pytest.mark.asyncio
async def test_generate_card_image_stores_url(store):
    svc = FlashcardsService(store, llm=None)
    card = await svc.create_card(topic="T", front="Coração?", back="Bombeia sangue")
    out = await svc.generate_card_image(card["id"], image_service=OkImageSvc())
    assert out["image_url"] == "/images/img1.png"


@pytest.mark.asyncio
async def test_generate_card_image_over_budget_raises(store):
    svc = FlashcardsService(store, llm=None)
    card = await svc.create_card(topic="T", front="Xx?", back="Yyy")
    with pytest.raises(Exception):
        await svc.generate_card_image(card["id"], image_service=BudgetImageSvc())
