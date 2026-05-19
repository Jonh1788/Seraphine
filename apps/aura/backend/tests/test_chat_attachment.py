"""Multipart attachment endpoint — request-shape validation.

These tests do NOT exercise the LLM loop (no AURA_ANTHROPIC_API_KEY in
CI), so they only cover the cheap validation paths: unsupported mime
(415), oversized body (413), and missing file field (422). The full
agentic path is shared with the text endpoint which is already covered
by integration runs.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("AURA_SQLITE_PATH", str(tmp_path / "aura.sqlite"))
    monkeypatch.setenv("AURA_JWT_SECRET", "test-secret-do-not-ship")

    import importlib

    import aura.config as config_mod
    import aura.main as main_mod

    importlib.reload(config_mod)
    importlib.reload(main_mod)

    with TestClient(main_mod.app) as c:
        yield c


def _register_and_make_conversation(client: TestClient) -> tuple[dict, str]:
    r = client.post(
        "/auth/register",
        json={"email": "att@x.io", "password": "hunter2x", "name": "Att"},
    )
    token = r.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}
    r = client.post("/chat/conversations", headers=headers, json={"title": None})
    cid = r.json()["id"]
    return headers, cid


def test_attachment_unsupported_mime_returns_415(client):
    headers, cid = _register_and_make_conversation(client)
    r = client.post(
        f"/chat/conversations/{cid}/messages/with-attachment",
        headers=headers,
        files={"file": ("note.txt", b"hello", "text/plain")},
        data={"content": ""},
    )
    assert r.status_code == 415, r.text


def test_attachment_too_large_returns_413(client):
    headers, cid = _register_and_make_conversation(client)
    big = b"%PDF-1.4\n" + b"0" * (11 * 1024 * 1024)
    r = client.post(
        f"/chat/conversations/{cid}/messages/with-attachment",
        headers=headers,
        files={"file": ("big.pdf", big, "application/pdf")},
        data={"content": ""},
    )
    assert r.status_code == 413, r.text


def test_attachment_missing_file_returns_422(client):
    headers, cid = _register_and_make_conversation(client)
    # POST multipart with ONLY the content field — no file part.
    r = client.post(
        f"/chat/conversations/{cid}/messages/with-attachment",
        headers=headers,
        files={"notfile": ("x.txt", b"abc", "text/plain")},
        data={"content": "olá"},
    )
    assert r.status_code == 422, r.text
