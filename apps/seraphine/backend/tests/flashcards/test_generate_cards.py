import pytest
from seraphine.flashcards.service import FlashcardsService, MAKE_CARDS_TOOL


class FakeLLM:
    def __init__(self, result=None, raise_exc=False):
        self._result = result if result is not None else {"cards": [
            {"front": "Pergunta 1?", "back": "Resposta 1"},
            {"front": "Pergunta 2?", "back": "Resposta 2"},
        ]}
        self._raise = raise_exc
        self.calls = []

    async def tool_call_json(self, *, system, user, tool, cache_system=False, max_tokens=1024, model=None):
        self.calls.append({"system": system, "user": user, "tool": tool})
        if self._raise:
            raise RuntimeError("boom")
        return self._result


def test_tool_schema_shape():
    props = MAKE_CARDS_TOOL["input_schema"]["properties"]["cards"]["items"]["properties"]
    assert props["front"]["maxLength"] == 200
    assert props["back"]["maxLength"] == 500
    assert MAKE_CARDS_TOOL["name"] == "make_cards"


@pytest.mark.asyncio
async def test_generate_cards_returns_clamped_pairs():
    llm = FakeLLM({"cards": [
        {"front": "  Q?  ", "back": "A"},
        {"front": "x" * 300, "back": "y"},
        {"front": "ok front", "back": ""},
        {"front": "ok front", "back": "ok back"},
    ]})
    svc = FlashcardsService(store=None, llm=llm)
    cards = await svc.generate_cards("material", count=10)
    assert all(3 <= len(c["front"]) <= 200 and 3 <= len(c["back"]) <= 500 for c in cards)
    assert {"front", "back"} <= set(cards[0].keys())
    assert "material" in llm.calls[0]["user"]


@pytest.mark.asyncio
async def test_generate_cards_raises_on_llm_error():
    svc = FlashcardsService(store=None, llm=FakeLLM(raise_exc=True))
    with pytest.raises(Exception):
        await svc.generate_cards("material", count=5)


@pytest.mark.asyncio
async def test_generate_cards_raises_on_zero_valid():
    svc = FlashcardsService(store=None, llm=FakeLLM({"cards": [{"front": "x", "back": "y"}]}))
    with pytest.raises(Exception):
        await svc.generate_cards("material", count=5)
