"""Tests for the generic ``update_task`` service method.

Covers partial updates, unset sentinels, tags round-trip, priority
validation (at the service level — service itself trusts callers; route
layer validates enum values), and user-scoping.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from core_db import Store
from mod_tasks import TaskService
from mod_tasks import schema as tasks_schema


@pytest.fixture
async def store(tmp_path: Path) -> Store:
    s = Store(tmp_path / "update.sqlite")
    s.register_migrator("mod_tasks", tasks_schema.migrate)
    await s.ensure_schema()
    return s


async def test_partial_update_round_trip(store: Store) -> None:
    svc = TaskService(store)
    tid = await svc.create_task(
        type="generic", title="t1", description="d1", source="chat",
        payload={}, user_id="u1", priority="low", tags=["a", "b"],
    )

    # Update just the title.
    affected = await svc.update_task(tid, user_id="u1", title="t1b")
    assert affected == 1
    got = await svc.get_task(tid, user_id="u1")
    assert got is not None
    assert got.title == "t1b"
    assert got.description == "d1"
    assert got.tags == ["a", "b"]
    assert got.priority == "low"

    # Replace tags + priority + description.
    affected = await svc.update_task(
        tid,
        user_id="u1",
        description="d2",
        priority="high",
        tags=["x"],
    )
    assert affected == 1
    got = await svc.get_task(tid, user_id="u1")
    assert got is not None
    assert got.description == "d2"
    assert got.priority == "high"
    assert got.tags == ["x"]


async def test_unset_sentinels_clear_fields(store: Store) -> None:
    svc = TaskService(store)
    tid = await svc.create_task(
        type="generic", title="t", description="", source="chat",
        payload={}, user_id="u1", priority="med",
        due_date="2026-04-14", due_time="14:14",
    )

    affected = await svc.update_task(
        tid,
        user_id="u1",
        unset_due_date=True,
        unset_due_time=True,
        unset_priority=True,
    )
    assert affected == 1
    got = await svc.get_task(tid, user_id="u1")
    assert got is not None
    assert got.due_date is None
    assert got.due_time is None
    assert got.priority is None


async def test_update_empty_tags_clears_list(store: Store) -> None:
    svc = TaskService(store)
    tid = await svc.create_task(
        type="generic", title="t", description="", source="chat",
        payload={}, user_id="u1", tags=["a", "b", "c"],
    )
    await svc.update_task(tid, user_id="u1", tags=[])
    got = await svc.get_task(tid, user_id="u1")
    assert got is not None
    assert got.tags == []


async def test_update_respects_user_scope(store: Store) -> None:
    svc = TaskService(store)
    tid = await svc.create_task(
        type="generic", title="t", description="", source="chat",
        payload={}, user_id="u1",
    )
    # Wrong user: no rows updated.
    affected = await svc.update_task(tid, user_id="u2", title="hack")
    assert affected == 0
    got = await svc.get_task(tid, user_id="u1")
    assert got is not None and got.title == "t"


async def test_update_no_fields_is_noop(store: Store) -> None:
    svc = TaskService(store)
    tid = await svc.create_task(
        type="generic", title="t", description="", source="chat",
        payload={}, user_id="u1",
    )
    affected = await svc.update_task(tid, user_id="u1")
    assert affected == 0


async def test_legacy_row_defaults(store: Store) -> None:
    """A task with no priority/tags set returns sensible defaults."""
    svc = TaskService(store)
    tid = await svc.create_task(
        type="generic", title="t", description="", source="chat",
        payload={}, user_id=None,
    )
    got = await svc.get_task(tid, user_id=None)
    assert got is not None
    assert got.priority is None
    assert got.tags == []
