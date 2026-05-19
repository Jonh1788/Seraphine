"""HTTP-layer tests for reminder_offsets on POST /tasks + PATCH /tasks.

Verifies:
- POST with reminder_offsets persists materialized set (always includes 0).
- POST without reminder_offsets + due_time gets [0] by default.
- POST without due_time stores nothing.
- PATCH replaces offsets atomically.
- 422 on negative / out-of-range values.
- GET returns reminder_offsets on the task body.
"""
from __future__ import annotations

import asyncio
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
    store = Store(tmp_path / "offsets_api.sqlite")
    store.register_migrator("mod_tasks", tasks_schema.migrate)
    asyncio.get_event_loop().run_until_complete(store.ensure_schema())

    svc = TaskService(store)

    a = FastAPI()
    a.state.task_service = svc
    a.include_router(tasks_router)

    async def _user(request: Request):
        return request.headers.get("X-User")

    a.dependency_overrides[get_current_user_id] = _user
    return a


def test_post_with_offsets_always_includes_zero(app: FastAPI) -> None:
    c = TestClient(app)
    r = c.post(
        "/tasks",
        json={
            "type": "generic",
            "title": "Reunião",
            "due_date": "2026-05-19",
            "due_time": "10:00",
            "reminder_offsets": [15, 60],
        },
        headers={"X-User": "user-a"},
    )
    assert r.status_code == 200, r.text
    tid = r.json()["id"]
    g = c.get(f"/tasks/{tid}", headers={"X-User": "user-a"})
    assert g.status_code == 200
    # Decision rule: sorted(set([0] + offsets)) → [0, 15, 60].
    assert g.json()["reminder_offsets"] == [0, 15, 60]


def test_post_without_offsets_defaults_to_zero(app: FastAPI) -> None:
    c = TestClient(app)
    r = c.post(
        "/tasks",
        json={
            "type": "generic",
            "title": "Sem offsets",
            "due_date": "2026-05-19",
            "due_time": "10:00",
        },
        headers={"X-User": "user-a"},
    )
    tid = r.json()["id"]
    g = c.get(f"/tasks/{tid}", headers={"X-User": "user-a"})
    assert g.json()["reminder_offsets"] == [0]


def test_post_without_due_time_stores_nothing(app: FastAPI) -> None:
    c = TestClient(app)
    r = c.post(
        "/tasks",
        json={
            "type": "generic",
            "title": "Sem hora",
            "due_date": "2026-05-19",
        },
        headers={"X-User": "user-a"},
    )
    tid = r.json()["id"]
    g = c.get(f"/tasks/{tid}", headers={"X-User": "user-a"})
    assert g.json()["reminder_offsets"] == []


def test_post_rejects_negative_offsets(app: FastAPI) -> None:
    c = TestClient(app)
    r = c.post(
        "/tasks",
        json={
            "type": "generic",
            "title": "X",
            "due_date": "2026-05-19",
            "due_time": "10:00",
            "reminder_offsets": [-5, 15],
        },
        headers={"X-User": "user-a"},
    )
    assert r.status_code == 422


def test_post_rejects_huge_offsets(app: FastAPI) -> None:
    c = TestClient(app)
    r = c.post(
        "/tasks",
        json={
            "type": "generic",
            "title": "X",
            "due_date": "2026-05-19",
            "due_time": "10:00",
            "reminder_offsets": [60 * 24 * 365],  # 1 year ≫ 30 days
        },
        headers={"X-User": "user-a"},
    )
    assert r.status_code == 422


def test_patch_replaces_offsets(app: FastAPI) -> None:
    c = TestClient(app)
    r = c.post(
        "/tasks",
        json={
            "type": "generic",
            "title": "X",
            "due_date": "2026-05-19",
            "due_time": "10:00",
            "reminder_offsets": [15, 60],
        },
        headers={"X-User": "user-a"},
    )
    tid = r.json()["id"]
    p = c.patch(
        f"/tasks/{tid}",
        json={"reminder_offsets": [1440]},
        headers={"X-User": "user-a"},
    )
    assert p.status_code == 200, p.text
    g = c.get(f"/tasks/{tid}", headers={"X-User": "user-a"})
    # PATCH used user offsets [1440]; materialization adds 0 → [0, 1440].
    assert g.json()["reminder_offsets"] == [0, 1440]


def test_patch_empty_list_clears_offsets(app: FastAPI) -> None:
    c = TestClient(app)
    r = c.post(
        "/tasks",
        json={
            "type": "generic",
            "title": "X",
            "due_date": "2026-05-19",
            "due_time": "10:00",
            "reminder_offsets": [15, 60],
        },
        headers={"X-User": "user-a"},
    )
    tid = r.json()["id"]
    p = c.patch(
        f"/tasks/{tid}",
        json={"reminder_offsets": []},
        headers={"X-User": "user-a"},
    )
    assert p.status_code == 200
    g = c.get(f"/tasks/{tid}", headers={"X-User": "user-a"})
    # Empty list = user wants no reminders → stored as empty.
    assert g.json()["reminder_offsets"] == []


def test_list_tasks_includes_offsets(app: FastAPI) -> None:
    c = TestClient(app)
    c.post(
        "/tasks",
        json={
            "type": "generic",
            "title": "A",
            "due_date": "2026-05-19",
            "due_time": "10:00",
            "reminder_offsets": [15],
        },
        headers={"X-User": "user-a"},
    )
    c.post(
        "/tasks",
        json={
            "type": "generic",
            "title": "B",
            "due_date": "2026-05-19",
            "due_time": "11:00",
            "reminder_offsets": [60, 1440],
        },
        headers={"X-User": "user-a"},
    )
    r = c.get("/tasks", headers={"X-User": "user-a"})
    assert r.status_code == 200
    by_title = {t["title"]: t["reminder_offsets"] for t in r.json()["tasks"]}
    assert by_title["A"] == [0, 15]
    assert by_title["B"] == [0, 60, 1440]
