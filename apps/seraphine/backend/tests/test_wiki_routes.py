from fastapi import FastAPI
from fastapi.testclient import TestClient

import seraphine.wiki.files as f
from seraphine.wiki.routes import router


def _client(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_WIKI_DATA_DIR", str(tmp_path))
    f.write_page(slug="cafe", title="Café", category="topic", sources=["research/x.md"], links=["Arábica"], body="sobre [[Arábica]]")
    f.write_page(slug="arabica", title="Arábica", category="topic", sources=[], links=[], body="variedade")
    (f.wiki_root() / "raw" / "research" / "x.md").write_text("fonte café", encoding="utf-8")
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def test_index(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    r = c.get("/wiki/index")
    assert r.status_code == 200
    slugs = {p["slug"] for p in r.json()}
    assert slugs == {"cafe", "arabica"}


def test_page(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    r = c.get("/wiki/page/cafe")
    assert r.status_code == 200
    body = r.json()
    assert body["title"] == "Café" and body["sources"] == ["research/x.md"]
    assert c.get("/wiki/page/naoexiste").status_code == 404
    assert c.get("/wiki/page/..%2f..%2fetc").status_code in (400, 404)


def test_graph(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    g = c.get("/wiki/graph").json()
    assert {"source": "cafe", "target": "arabica"} in g["edges"]


def test_source(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    assert "fonte café" in c.get("/wiki/source/research/x.md").json()["content"]
    assert c.get("/wiki/source/../../etc/passwd").status_code in (400, 404)


class _Tok:
    def __init__(self, text): self.text = text


class _CountLLM:
    def __init__(self, payload): self._payload = payload; self.calls = 0
    async def chat(self, messages, temperature=0.2):
        self.calls += 1
        yield _Tok(self._payload)


_CHAT_PAYLOAD = '{"pages":[{"slug":"cafe","title":"Café","category":"topic","body":"resumo","links":[]}]}'


def _ingest_client(tmp_path, monkeypatch, *, with_state=True):
    monkeypatch.setenv("SERAPHINE_WIKI_DATA_DIR", str(tmp_path))
    app = FastAPI()
    app.include_router(router)
    if with_state:
        app.state.llm = _CountLLM(_CHAT_PAYLOAD)
        app.state.store = object()
    return TestClient(app)


def test_ingest_chat_creates_page(tmp_path, monkeypatch):
    c = _ingest_client(tmp_path, monkeypatch)
    r = c.post("/wiki/ingest/chat", json={"question": "o que é café?", "answer": "bebida"})
    assert r.status_code == 200
    body = r.json()
    assert body["created"] is True and body["pages"] == ["cafe"]
    assert f.read_page("cafe") is not None


def test_ingest_chat_empty_answer_400(tmp_path, monkeypatch):
    c = _ingest_client(tmp_path, monkeypatch)
    assert c.post("/wiki/ingest/chat", json={"question": "q", "answer": "   "}).status_code == 400


def test_ingest_chat_no_state_503(tmp_path, monkeypatch):
    c = _ingest_client(tmp_path, monkeypatch, with_state=False)
    assert c.post("/wiki/ingest/chat", json={"answer": "algo"}).status_code == 503
