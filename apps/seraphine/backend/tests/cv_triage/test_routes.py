"""HTTP route tests for the cv_triage REST API."""

from __future__ import annotations

import io
import zipfile

import pytest
from fastapi.testclient import TestClient

from seraphine.main import create_app


def _zip(entries: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for n, d in entries.items():
            zf.writestr(n, d)
    return buf.getvalue()


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("SERAPHINE_SQLITE_PATH", str(tmp_path / "t.sqlite"))
    monkeypatch.setenv("SERAPHINE_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SERAPHINE_WHATSAPP_BRIDGE_URL", "http://bridge")
    monkeypatch.setenv("SERAPHINE_API_KEY", "k")
    # Reset cached settings so env vars take effect for create_app().
    from seraphine import config as _cfg
    _cfg.settings = _cfg.Settings()
    # Make sure main.py-level imports of `settings` see the refreshed value.
    import seraphine.main as _main
    _main.settings = _cfg.settings
    app = create_app()
    return TestClient(app)


def _headers():
    return {"X-API-Key": "k"}


def test_create_job_rejects_short_rubric(client):
    z = _zip({"a.pdf": b"%PDF"})
    r = client.post(
        "/cv_triage/jobs",
        headers=_headers(),
        files={"zip": ("cv.zip", z, "application/zip")},
        data={
            "rubric": "too short",
            "target_chat_id": "x@c.us",
            "target_label": "X",
        },
    )
    assert r.status_code == 422
    assert "rubric" in r.text.lower()


def test_create_job_rejects_no_pdfs(client):
    z = _zip({"notes.txt": b"hi"})
    r = client.post(
        "/cv_triage/jobs",
        headers=_headers(),
        files={"zip": ("cv.zip", z, "application/zip")},
        data={
            "rubric": "x" * 40,
            "target_chat_id": "x@c.us",
            "target_label": "X",
        },
    )
    assert r.status_code == 422


def test_create_job_happy_path_returns_job_id(client, monkeypatch):
    async def _noop_run(job_id, deps):
        return None

    monkeypatch.setattr(
        "seraphine.cv_triage.routes.run_cv_triage", _noop_run
    )
    z = _zip({"a.pdf": b"%PDF-1.4", "b.pdf": b"%PDF-1.4"})
    r = client.post(
        "/cv_triage/jobs",
        headers=_headers(),
        files={"zip": ("cv.zip", z, "application/zip")},
        data={
            "rubric": "x" * 40,
            "target_chat_id": "x@c.us",
            "target_label": "X",
        },
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert "job_id" in body and "turn_id" in body


def test_get_job_returns_results(client, monkeypatch):
    async def _noop(*a, **k):
        return None

    monkeypatch.setattr("seraphine.cv_triage.routes.run_cv_triage", _noop)
    z = _zip({"a.pdf": b"%PDF"})
    r = client.post(
        "/cv_triage/jobs",
        headers=_headers(),
        files={"zip": ("cv.zip", z, "application/zip")},
        data={
            "rubric": "x" * 40,
            "target_chat_id": "x@c.us",
            "target_label": "X",
        },
    )
    job_id = r.json()["job_id"]
    r2 = client.get(f"/cv_triage/jobs/{job_id}", headers=_headers())
    assert r2.status_code == 200
    body = r2.json()
    assert body["id"] == job_id
    assert body["status"] in (
        "queued",
        "extracting",
        "ranking",
        "sending",
        "done",
        "failed",
    )
    assert "results" in body


def test_cancel_marks_flag(client, monkeypatch):
    called = []
    monkeypatch.setattr(
        "seraphine.cv_triage.routes.request_cancel",
        lambda jid: called.append(jid),
    )

    async def _noop(*a, **k):
        return None

    monkeypatch.setattr("seraphine.cv_triage.routes.run_cv_triage", _noop)
    z = _zip({"a.pdf": b"%PDF"})
    r = client.post(
        "/cv_triage/jobs",
        headers=_headers(),
        files={"zip": ("cv.zip", z, "application/zip")},
        data={
            "rubric": "x" * 40,
            "target_chat_id": "x@c.us",
            "target_label": "X",
        },
    )
    job_id = r.json()["job_id"]
    r2 = client.post(
        f"/cv_triage/jobs/{job_id}/cancel", headers=_headers()
    )
    assert r2.status_code == 200
    assert called == [job_id]


def test_resend_requires_done_job(client, monkeypatch):
    async def _noop(*a, **k):
        return None

    monkeypatch.setattr("seraphine.cv_triage.routes.run_cv_triage", _noop)
    z = _zip({"a.pdf": b"%PDF"})
    r = client.post(
        "/cv_triage/jobs",
        headers=_headers(),
        files={"zip": ("cv.zip", z, "application/zip")},
        data={
            "rubric": "x" * 40,
            "target_chat_id": "x@c.us",
            "target_label": "X",
        },
    )
    job_id = r.json()["job_id"]
    r2 = client.post(
        f"/cv_triage/jobs/{job_id}/resend", headers=_headers()
    )
    assert r2.status_code == 409
