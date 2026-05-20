"""Per-user default reminder offsets: materialization rule + fetcher
fallbacks. Covers the new TaskService.get_default_offsets contract and
the route-level _materialize_offsets decision tree.
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


# ----------------------------------------------------------------------
# Service-level: get_default_offsets fetcher contract
# ----------------------------------------------------------------------

@pytest.fixture
async def store(tmp_path: Path) -> Store:
    s = Store(tmp_path / "defaults.sqlite")
    s.register_migrator("mod_tasks", tasks_schema.migrate)
    await s.ensure_schema()
    return s


async def test_get_default_offsets_no_fetcher(store: Store) -> None:
    """Seraphine-style construction (no fetcher) → always []."""
    svc = TaskService(store)
    assert await svc.get_default_offsets("u1") == []
    assert await svc.get_default_offsets(None) == []


async def test_get_default_offsets_fetcher_returns_values(store: Store) -> None:
    async def fetcher(uid: str) -> list[int]:
        return [15, 60]
    svc = TaskService(store, default_offsets_fetcher=fetcher)
    assert await svc.get_default_offsets("u1") == [15, 60]


async def test_get_default_offsets_fetcher_returns_none(store: Store) -> None:
    async def fetcher(uid: str) -> list[int]:
        return []
    svc = TaskService(store, default_offsets_fetcher=fetcher)
    assert await svc.get_default_offsets("u1") == []


async def test_get_default_offsets_fetcher_raises(store: Store) -> None:
    """A buggy fetcher must NOT break task creation — falls back to []."""
    async def fetcher(uid: str) -> list[int]:
        raise RuntimeError("boom")
    svc = TaskService(store, default_offsets_fetcher=fetcher)
    assert await svc.get_default_offsets("u1") == []


async def test_get_default_offsets_none_user(store: Store) -> None:
    """No user_id → [] without calling the fetcher."""
    calls = {"n": 0}
    async def fetcher(uid: str) -> list[int]:
        calls["n"] += 1
        return [15]
    svc = TaskService(store, default_offsets_fetcher=fetcher)
    assert await svc.get_default_offsets(None) == []
    assert calls["n"] == 0


# ----------------------------------------------------------------------
# HTTP-level: route materialization with defaults
# ----------------------------------------------------------------------

@pytest.fixture
def app_with_defaults(tmp_path: Path):
    """Boots the tasks router with a fetcher that returns [15, 60] for
    user-a and [] for everyone else."""
    store = Store(tmp_path / "rt_defaults.sqlite")
    store.register_migrator("mod_tasks", tasks_schema.migrate)
    asyncio.get_event_loop().run_until_complete(store.ensure_schema())

    async def fetcher(uid: str) -> list[int]:
        return [15, 60] if uid == "user-a" else []

    svc = TaskService(store, default_offsets_fetcher=fetcher)

    a = FastAPI()
    a.state.task_service = svc
    a.include_router(tasks_router)

    async def _user(request: Request):
        return request.headers.get("X-User")

    a.dependency_overrides[get_current_user_id] = _user
    return a


def test_post_omitting_offsets_layers_defaults(app_with_defaults: FastAPI) -> None:
    c = TestClient(app_with_defaults)
    r = c.post(
        "/tasks",
        json={
            "type": "generic",
            "title": "Reunião",
            "due_date": "2026-05-19",
            "due_time": "10:00",
        },
        headers={"X-User": "user-a"},
    )
    tid = r.json()["id"]
    g = c.get(f"/tasks/{tid}", headers={"X-User": "user-a"})
    # Decision rule: omitted + due_time → sorted(set([0] + defaults))
    assert g.json()["reminder_offsets"] == [0, 15, 60]


def test_post_omitting_offsets_no_due_time_stays_empty(
    app_with_defaults: FastAPI,
) -> None:
    c = TestClient(app_with_defaults)
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


def test_post_explicit_offsets_ignores_defaults(
    app_with_defaults: FastAPI,
) -> None:
    """User explicitly picking offsets must NOT also get the defaults
    layered in."""
    c = TestClient(app_with_defaults)
    r = c.post(
        "/tasks",
        json={
            "type": "generic",
            "title": "Reunião",
            "due_date": "2026-05-19",
            "due_time": "10:00",
            "reminder_offsets": [1440],
        },
        headers={"X-User": "user-a"},
    )
    tid = r.json()["id"]
    g = c.get(f"/tasks/{tid}", headers={"X-User": "user-a"})
    # Only [0, 1440] — defaults 15/60 are NOT applied.
    assert g.json()["reminder_offsets"] == [0, 1440]


def test_post_explicit_empty_offsets_ignores_defaults(
    app_with_defaults: FastAPI,
) -> None:
    """Explicit empty list = 'no extras, just on-time' — defaults skipped."""
    c = TestClient(app_with_defaults)
    r = c.post(
        "/tasks",
        json={
            "type": "generic",
            "title": "Reunião",
            "due_date": "2026-05-19",
            "due_time": "10:00",
            "reminder_offsets": [],
        },
        headers={"X-User": "user-a"},
    )
    tid = r.json()["id"]
    g = c.get(f"/tasks/{tid}", headers={"X-User": "user-a"})
    assert g.json()["reminder_offsets"] == [0]


def test_post_omitting_offsets_for_user_without_defaults(
    app_with_defaults: FastAPI,
) -> None:
    """user-b's fetcher returns [] → behaves like pre-feature ([0])."""
    c = TestClient(app_with_defaults)
    r = c.post(
        "/tasks",
        json={
            "type": "generic",
            "title": "X",
            "due_date": "2026-05-19",
            "due_time": "10:00",
        },
        headers={"X-User": "user-b"},
    )
    tid = r.json()["id"]
    g = c.get(f"/tasks/{tid}", headers={"X-User": "user-b"})
    assert g.json()["reminder_offsets"] == [0]


def test_patch_omitting_offsets_does_not_apply_defaults(
    app_with_defaults: FastAPI,
) -> None:
    """A PATCH that doesn't touch reminder_offsets must NOT retroactively
    inject defaults — they're a create-time concept."""
    c = TestClient(app_with_defaults)
    r = c.post(
        "/tasks",
        json={
            "type": "generic",
            "title": "X",
            "due_date": "2026-05-19",
            "due_time": "10:00",
            "reminder_offsets": [1440],
        },
        headers={"X-User": "user-a"},
    )
    tid = r.json()["id"]
    c.patch(
        f"/tasks/{tid}",
        json={"title": "X renamed"},
        headers={"X-User": "user-a"},
    )
    g = c.get(f"/tasks/{tid}", headers={"X-User": "user-a"})
    assert g.json()["reminder_offsets"] == [0, 1440]


def test_patch_explicit_offsets_ignores_defaults(
    app_with_defaults: FastAPI,
) -> None:
    c = TestClient(app_with_defaults)
    r = c.post(
        "/tasks",
        json={
            "type": "generic",
            "title": "X",
            "due_date": "2026-05-19",
            "due_time": "10:00",
        },
        headers={"X-User": "user-a"},
    )
    tid = r.json()["id"]
    c.patch(
        f"/tasks/{tid}",
        json={"reminder_offsets": [1440]},
        headers={"X-User": "user-a"},
    )
    g = c.get(f"/tasks/{tid}", headers={"X-User": "user-a"})
    assert g.json()["reminder_offsets"] == [0, 1440]
