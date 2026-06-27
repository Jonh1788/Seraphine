from fastapi import FastAPI
from fastapi.testclient import TestClient

from seraphine.attachments.routes import router


def _client(tmp_path, monkeypatch) -> TestClient:
    monkeypatch.setenv("SERAPHINE_DATA_DIR", str(tmp_path))
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def test_upload_pdf_returns_meta(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    resp = c.post("/attachments", files={"file": ("a.pdf", b"%PDF-1.4 x", "application/pdf")})
    assert resp.status_code == 200
    body = resp.json()
    assert body["kind"] == "pdf"
    assert body["mime"] == "application/pdf"
    assert body["id"]


def test_upload_rejects_bad_mime(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    resp = c.post("/attachments", files={"file": ("a.txt", b"hi", "text/plain")})
    assert resp.status_code == 415


def test_upload_rejects_empty(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    resp = c.post("/attachments", files={"file": ("a.png", b"", "image/png")})
    assert resp.status_code == 400


def test_get_preview(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    up = c.post("/attachments", files={"file": ("a.png", b"\x89PNG", "image/png")}).json()
    resp = c.get(f"/attachments/{up['id']}")
    assert resp.status_code == 200
    assert resp.content == b"\x89PNG"


def test_get_missing_is_404(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    assert c.get("/attachments/deadbeef").status_code == 404
