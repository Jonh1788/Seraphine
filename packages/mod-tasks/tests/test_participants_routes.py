from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from core_db import Store
from mod_tasks import TaskService
from mod_tasks import schema as tasks_schema
from mod_tasks.routes import get_current_user_id, router as tasks_router


@pytest.fixture
def app(tmp_path: Path) -> FastAPI:
    store = Store(tmp_path / "routes.sqlite")
    store.register_migrator("mod_tasks", tasks_schema.migrate)
    import asyncio
    asyncio.get_event_loop().run_until_complete(store.ensure_schema())

    svc = TaskService(store)

    async def email_to_uid(email: str):
        local = email.split("@", 1)[0] if "@" in email else None
        return local if local and local.startswith("user-") else None

    async def uid_to_email(uid: str):
        return f"{uid}@x.com" if uid else None

    svc.attach_user_lookup(email_to_user_id=email_to_uid, user_id_to_email=uid_to_email)

    a = FastAPI()
    a.state.task_service = svc
    a.include_router(tasks_router)

    # Override auth dep — TestClient sends X-User header to pick caller
    async def _user(request: Request):
        return request.headers.get("X-User")

    a.dependency_overrides[get_current_user_id] = _user
    return a


def test_add_participant_owner(app: FastAPI) -> None:
    c = TestClient(app)
    r = c.post(
        "/tasks",
        json={"type": "generic", "title": "t", "description": ""},
        headers={"X-User": "user-a"},
    )
    tid = r.json()["id"]

    r = c.post(
        f"/tasks/{tid}/participants",
        json={"email": "user-b@x.com"},
        headers={"X-User": "user-a"},
    )
    assert r.status_code == 200
    assert "user-b@x.com" in r.json()["participants"]


def test_add_participant_unknown_email_returns_404(app: FastAPI) -> None:
    c = TestClient(app)
    r = c.post(
        "/tasks", json={"type": "generic", "title": "t", "description": ""},
        headers={"X-User": "user-a"},
    )
    tid = r.json()["id"]
    r = c.post(
        f"/tasks/{tid}/participants",
        json={"email": "ghost@nowhere.com"},
        headers={"X-User": "user-a"},
    )
    assert r.status_code == 404


def test_add_participant_member_returns_403(app: FastAPI) -> None:
    c = TestClient(app)
    r = c.post(
        "/tasks", json={"type": "generic", "title": "t", "description": ""},
        headers={"X-User": "user-a"},
    )
    tid = r.json()["id"]
    c.post(
        f"/tasks/{tid}/participants", json={"email": "user-b@x.com"},
        headers={"X-User": "user-a"},
    )
    r = c.post(
        f"/tasks/{tid}/participants", json={"email": "user-c@x.com"},
        headers={"X-User": "user-b"},
    )
    assert r.status_code == 403


def test_add_participant_already_member_returns_409(app: FastAPI) -> None:
    c = TestClient(app)
    r = c.post(
        "/tasks", json={"type": "generic", "title": "t", "description": ""},
        headers={"X-User": "user-a"},
    )
    tid = r.json()["id"]
    c.post(
        f"/tasks/{tid}/participants", json={"email": "user-b@x.com"},
        headers={"X-User": "user-a"},
    )
    r = c.post(
        f"/tasks/{tid}/participants", json={"email": "user-b@x.com"},
        headers={"X-User": "user-a"},
    )
    assert r.status_code == 409


def test_leave_task_member(app: FastAPI) -> None:
    c = TestClient(app)
    r = c.post(
        "/tasks", json={"type": "generic", "title": "t", "description": ""},
        headers={"X-User": "user-a"},
    )
    tid = r.json()["id"]
    c.post(
        f"/tasks/{tid}/participants", json={"email": "user-b@x.com"},
        headers={"X-User": "user-a"},
    )
    r = c.delete(
        f"/tasks/{tid}/participants/me", headers={"X-User": "user-b"},
    )
    assert r.status_code == 200


def test_leave_task_owner_returns_400(app: FastAPI) -> None:
    c = TestClient(app)
    r = c.post(
        "/tasks", json={"type": "generic", "title": "t", "description": ""},
        headers={"X-User": "user-a"},
    )
    tid = r.json()["id"]
    r = c.delete(
        f"/tasks/{tid}/participants/me", headers={"X-User": "user-a"},
    )
    assert r.status_code == 400


def test_remove_participant_owner(app: FastAPI) -> None:
    c = TestClient(app)
    r = c.post(
        "/tasks", json={"type": "generic", "title": "t", "description": ""},
        headers={"X-User": "user-a"},
    )
    tid = r.json()["id"]
    c.post(
        f"/tasks/{tid}/participants", json={"email": "user-b@x.com"},
        headers={"X-User": "user-a"},
    )
    r = c.delete(
        f"/tasks/{tid}/participants/user-b", headers={"X-User": "user-a"},
    )
    assert r.status_code == 200


def test_list_participants(app: FastAPI) -> None:
    c = TestClient(app)
    r = c.post(
        "/tasks", json={"type": "generic", "title": "t", "description": ""},
        headers={"X-User": "user-a"},
    )
    tid = r.json()["id"]
    r = c.get(f"/tasks/{tid}/participants", headers={"X-User": "user-a"})
    assert r.status_code == 200
    assert r.json() == {"participants": ["user-a@x.com"]}


def test_remove_participant_by_email_owner(app: FastAPI) -> None:
    c = TestClient(app)
    r = c.post(
        "/tasks", json={"type": "generic", "title": "t", "description": ""},
        headers={"X-User": "user-a"},
    )
    tid = r.json()["id"]
    c.post(
        f"/tasks/{tid}/participants", json={"email": "user-b@x.com"},
        headers={"X-User": "user-a"},
    )
    r = c.delete(
        f"/tasks/{tid}/participants/by-email/user-b@x.com",
        headers={"X-User": "user-a"},
    )
    assert r.status_code == 200


def test_remove_participant_by_email_unknown_returns_404(app: FastAPI) -> None:
    c = TestClient(app)
    r = c.post(
        "/tasks", json={"type": "generic", "title": "t", "description": ""},
        headers={"X-User": "user-a"},
    )
    tid = r.json()["id"]
    r = c.delete(
        f"/tasks/{tid}/participants/by-email/ghost@nowhere.com",
        headers={"X-User": "user-a"},
    )
    assert r.status_code == 404
