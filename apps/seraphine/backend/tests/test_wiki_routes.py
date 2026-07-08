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
