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
    r = client.post(
        "/auth/register",
        json={"email": "a@x.io", "password": "hunter2x", "name": "Alice"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    token = body["access_token"]
    user_id = body["user_id"]
    assert body["email"] == "a@x.io"
    assert body["name"] == "Alice"

    r = client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    assert r.json() == {
        "id": user_id,
        "email": "a@x.io",
        "name": "Alice",
        "default_reminder_offsets": [],
    }

    # Login with the same creds returns a (new) valid token and the name.
    r = client.post("/auth/login", json={"email": "a@x.io", "password": "hunter2x"})
    assert r.status_code == 200
    body = r.json()
    assert body["user_id"] == user_id
    assert body["name"] == "Alice"


def test_duplicate_email_rejected(client):
    client.post(
        "/auth/register",
        json={"email": "dup@x.io", "password": "hunter2x", "name": "First"},
    )
    r = client.post(
        "/auth/register",
        json={"email": "dup@x.io", "password": "different1", "name": "Second"},
    )
    assert r.status_code == 409


def test_login_wrong_password(client):
    client.post(
        "/auth/register",
        json={"email": "wp@x.io", "password": "hunter2x", "name": "WP"},
    )
    r = client.post("/auth/login", json={"email": "wp@x.io", "password": "wrong-one"})
    assert r.status_code == 401


def test_register_requires_name(client):
    """Schema enforces a non-empty name at register time."""
    r = client.post(
        "/auth/register",
        json={"email": "noname@x.io", "password": "hunter2x"},
    )
    assert r.status_code == 422


def test_unauthenticated_routes_reject_401(client):
    # No token at all.
    assert client.get("/tasks").status_code == 401
    assert client.get("/finance/entries").status_code == 401
    # Bogus token.
    headers = {"Authorization": "Bearer not.a.real.token"}
    assert client.get("/tasks", headers=headers).status_code == 401


def test_tasks_isolation_across_users(client):
    # Register two users.
    a = client.post(
        "/auth/register",
        json={"email": "alice@x.io", "password": "hunter2x", "name": "Alice"},
    ).json()
    b = client.post(
        "/auth/register",
        json={"email": "bob@x.io", "password": "hunter2x", "name": "Bob"},
    ).json()
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
    a = client.post(
        "/auth/register",
        json={"email": "fa@x.io", "password": "hunter2x", "name": "FA"},
    ).json()
    b = client.post(
        "/auth/register",
        json={"email": "fb@x.io", "password": "hunter2x", "name": "FB"},
    ).json()
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


def test_patch_me_persists_default_reminder_offsets(client):
    r = client.post(
        "/auth/register",
        json={"email": "pref@x.io", "password": "hunter2x", "name": "Pref"},
    ).json()
    h = {"Authorization": f"Bearer {r['access_token']}"}

    # Save defaults
    p = client.patch(
        "/auth/me", headers=h,
        json={"default_reminder_offsets": [60, 15, 15]},
    )
    assert p.status_code == 200, p.text
    # Service dedupes + sorts before persisting.
    assert p.json()["default_reminder_offsets"] == [15, 60]

    # /me reflects the persisted defaults
    me = client.get("/auth/me", headers=h).json()
    assert me["default_reminder_offsets"] == [15, 60]


def test_patch_me_rejects_out_of_range_offsets(client):
    r = client.post(
        "/auth/register",
        json={"email": "bad@x.io", "password": "hunter2x", "name": "Bad"},
    ).json()
    h = {"Authorization": f"Bearer {r['access_token']}"}
    p = client.patch(
        "/auth/me", headers=h,
        json={"default_reminder_offsets": [60 * 24 * 365]},  # 1 year
    )
    assert p.status_code == 422


def test_patch_me_rejects_negative_offsets(client):
    r = client.post(
        "/auth/register",
        json={"email": "neg@x.io", "password": "hunter2x", "name": "Neg"},
    ).json()
    h = {"Authorization": f"Bearer {r['access_token']}"}
    p = client.patch(
        "/auth/me", headers=h,
        json={"default_reminder_offsets": [-5]},
    )
    assert p.status_code == 422


def test_patch_me_empty_list_clears_defaults(client):
    r = client.post(
        "/auth/register",
        json={"email": "clr@x.io", "password": "hunter2x", "name": "Clr"},
    ).json()
    h = {"Authorization": f"Bearer {r['access_token']}"}
    client.patch(
        "/auth/me", headers=h,
        json={"default_reminder_offsets": [15]},
    )
    p = client.patch(
        "/auth/me", headers=h,
        json={"default_reminder_offsets": []},
    )
    assert p.status_code == 200
    assert p.json()["default_reminder_offsets"] == []


def test_user_defaults_apply_to_new_tasks(client):
    """End-to-end: set defaults via PATCH /auth/me, then POST /tasks
    without reminder_offsets and confirm they're layered in."""
    r = client.post(
        "/auth/register",
        json={"email": "e2e@x.io", "password": "hunter2x", "name": "E2E"},
    ).json()
    h = {"Authorization": f"Bearer {r['access_token']}"}
    client.patch(
        "/auth/me", headers=h,
        json={"default_reminder_offsets": [15, 60]},
    )
    t = client.post(
        "/tasks", headers=h,
        json={
            "type": "generic",
            "title": "Reunião",
            "due_date": "2026-05-19",
            "due_time": "10:00",
        },
    )
    tid = t.json()["id"]
    g = client.get(f"/tasks/{tid}", headers=h).json()
    assert g["reminder_offsets"] == [0, 15, 60]


def test_user_explicit_offsets_skip_defaults(client):
    """If the user explicitly passes reminder_offsets on POST, defaults
    must NOT be layered on top."""
    r = client.post(
        "/auth/register",
        json={"email": "exp@x.io", "password": "hunter2x", "name": "Exp"},
    ).json()
    h = {"Authorization": f"Bearer {r['access_token']}"}
    client.patch(
        "/auth/me", headers=h,
        json={"default_reminder_offsets": [15, 60]},
    )
    t = client.post(
        "/tasks", headers=h,
        json={
            "type": "generic",
            "title": "Reunião",
            "due_date": "2026-05-19",
            "due_time": "10:00",
            "reminder_offsets": [1440],
        },
    )
    tid = t.json()["id"]
    g = client.get(f"/tasks/{tid}", headers=h).json()
    assert g["reminder_offsets"] == [0, 1440]
