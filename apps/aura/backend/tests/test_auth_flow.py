"""End-to-end auth flow + multi-tenant isolation across the HTTP layer.

Boots the full Aura app, registers two users, logs each in, and proves
that user A's tasks/finance entries are invisible when authenticated as
user B. This is the strongest possible regression test for the
multi-tenant design — a green run here means the whole stack
(routes → JWT dep → service → SQL) honors user_id scoping.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path: Path, monkeypatch):
    # Point Aura at an isolated SQLite + JWT secret per-test.
    monkeypatch.setenv("AURA_SQLITE_PATH", str(tmp_path / "aura.sqlite"))
    monkeypatch.setenv("AURA_JWT_SECRET", "test-secret-do-not-ship")

    # Re-import settings + main so the env vars take effect on this fresh app.
    import importlib

    import aura.config as config_mod
    import aura.main as main_mod

    importlib.reload(config_mod)
    importlib.reload(main_mod)

    with TestClient(main_mod.app) as c:
        yield c


def test_register_login_me_roundtrip(client):
    r = client.post("/auth/register", json={"email": "a@x.io", "password": "hunter2x"})
    assert r.status_code == 200, r.text
    body = r.json()
    token = body["access_token"]
    user_id = body["user_id"]
    assert body["email"] == "a@x.io"

    r = client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    assert r.json() == {"id": user_id, "email": "a@x.io"}

    # Login with the same creds returns a (new) valid token.
    r = client.post("/auth/login", json={"email": "a@x.io", "password": "hunter2x"})
    assert r.status_code == 200
    assert r.json()["user_id"] == user_id


def test_duplicate_email_rejected(client):
    client.post("/auth/register", json={"email": "dup@x.io", "password": "hunter2x"})
    r = client.post("/auth/register", json={"email": "dup@x.io", "password": "different1"})
    assert r.status_code == 409


def test_login_wrong_password(client):
    client.post("/auth/register", json={"email": "wp@x.io", "password": "hunter2x"})
    r = client.post("/auth/login", json={"email": "wp@x.io", "password": "wrong-one"})
    assert r.status_code == 401


def test_unauthenticated_routes_reject_401(client):
    # No token at all.
    assert client.get("/tasks").status_code == 401
    assert client.get("/finance/entries").status_code == 401
    # Bogus token.
    headers = {"Authorization": "Bearer not.a.real.token"}
    assert client.get("/tasks", headers=headers).status_code == 401


def test_tasks_isolation_across_users(client):
    # Register two users.
    a = client.post("/auth/register", json={"email": "alice@x.io", "password": "hunter2x"}).json()
    b = client.post("/auth/register", json={"email": "bob@x.io", "password": "hunter2x"}).json()
    headers_a = {"Authorization": f"Bearer {a['access_token']}"}
    headers_b = {"Authorization": f"Bearer {b['access_token']}"}

    # Alice creates a task; Bob creates a different one.
    r1 = client.post(
        "/tasks", headers=headers_a,
        json={"type": "generic", "title": "alice-task", "description": "", "source": "chat", "payload": {}},
    )
    assert r1.status_code == 200
    alice_task_id = r1.json()["id"]

    r2 = client.post(
        "/tasks", headers=headers_b,
        json={"type": "generic", "title": "bob-task", "description": "", "source": "chat", "payload": {}},
    )
    assert r2.status_code == 200
    bob_task_id = r2.json()["id"]

    # Each user's list contains ONLY their own task.
    a_list = client.get("/tasks", headers=headers_a).json()["tasks"]
    b_list = client.get("/tasks", headers=headers_b).json()["tasks"]
    assert {t["id"] for t in a_list} == {alice_task_id}
    assert {t["id"] for t in b_list} == {bob_task_id}

    # Bob can't PATCH or DELETE Alice's task — gets 404 (not 200, not 403,
    # because the row is invisible to him by design).
    assert client.patch(
        f"/tasks/{alice_task_id}", headers=headers_b, json={"status": "approved"},
    ).status_code == 404
    assert client.delete(
        f"/tasks/{alice_task_id}", headers=headers_b,
    ).status_code == 404

    # But Alice can patch her own.
    assert client.patch(
        f"/tasks/{alice_task_id}", headers=headers_a, json={"status": "approved"},
    ).status_code == 200


def test_finance_isolation_across_users(client):
    a = client.post("/auth/register", json={"email": "fa@x.io", "password": "hunter2x"}).json()
    b = client.post("/auth/register", json={"email": "fb@x.io", "password": "hunter2x"}).json()
    headers_a = {"Authorization": f"Bearer {a['access_token']}"}
    headers_b = {"Authorization": f"Bearer {b['access_token']}"}

    entry = {
        "type": "expense", "amount": 42.5, "category": "outros",
        "description": "test entry", "date": "2026-04-14",
    }
    r = client.post("/finance/entries", headers=headers_a, json=entry)
    assert r.status_code == 200
    a_entry_id = r.json()["id"]

    # Alice sees her entry; Bob sees nothing.
    a_entries = client.get("/finance/entries", headers=headers_a).json()["entries"]
    b_entries = client.get("/finance/entries", headers=headers_b).json()["entries"]
    assert any(e["id"] == a_entry_id for e in a_entries)
    assert b_entries == []

    # Summary is also user-scoped.
    a_summary = client.get("/finance/summary?month=4&year=2026", headers=headers_a).json()
    b_summary = client.get("/finance/summary?month=4&year=2026", headers=headers_b).json()
    assert a_summary["expenses"] == 42.5
    assert b_summary["expenses"] == 0
