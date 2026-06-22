import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from seraphine.flashcards.routes import router
from seraphine.memory.store import MemoryStore


class FakeLLM:
    async def tool_call_json(self, **kw):
        return {"cards": [{"front": "Pergunta?", "back": "Resposta"}]}


@pytest.fixture
def client(tmp_path):
    import asyncio
    store = MemoryStore(tmp_path / "t.sqlite")
    asyncio.run(store.ensure_schema())
    app = FastAPI()
    app.include_router(router)
    app.state.store = store
    app.state.llm = FakeLLM()
    app.state.tools = None
    app.state.note_service = None
    app.state.reading_service = None
    app.state.deepsearch_service = None
    return TestClient(app)


def test_create_deck_topic_source(client):
    r = client.post("/flashcards/decks", json={"source": "topic", "topic": "Bio", "count": 3})
    assert r.status_code == 200
    assert r.json()["count"] == 1


def test_create_card_manual(client):
    r = client.post("/flashcards/cards", json={"topic": "T", "front": "Frente?", "back": "Verso"})
    assert r.status_code == 200
    assert r.json()["card"]["front"] == "Frente?"


def test_edit_card(client):
    cid = client.post("/flashcards/cards", json={"topic": "T", "front": "Frente?", "back": "Verso"}).json()["card"]["id"]
    r = client.put(f"/flashcards/{cid}", json={"front": "Editada?"})
    assert r.status_code == 200 and r.json()["card"]["front"] == "Editada?"
