"""Property test: tasks of one user are invisible to another.

Multi-tenant correctness is the main reason mod-tasks exists as a
shared package. This test seeds a deterministic mix of tasks across
two users on the same store and verifies every CRUD method respects
``user_id`` scoping.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from core_db import Store
from mod_tasks import TaskService
from mod_tasks import schema as tasks_schema


@pytest.fixture
async def store(tmp_path: Path) -> Store:
    s = Store(tmp_path / "iso.sqlite")
    s.register_migrator("mod_tasks", tasks_schema.migrate)
    await s.ensure_schema()
    return s


async def test_user_a_cannot_see_user_b_tasks(store: Store) -> None:
    svc = TaskService(store)

    a_ids = [
        await svc.create_task(
            type="generic", title=f"a-{i}", description="", source="chat",
            payload={}, user_id="user-a",
        )
        for i in range(2)
    ]
    b_ids = [
        await svc.create_task(
            type="generic", title=f"b-{i}", description="", source="chat",
            payload={}, user_id="user-b",
        )
        for i in range(3)
    ]
    legacy_id = await svc.create_task(
        type="generic", title="legacy", description="", source="chat",
        payload={}, user_id=None,
    )

    a_list = await svc.list_tasks(user_id="user-a")
    b_list = await svc.list_tasks(user_id="user-b")
    assert {t.id for t in a_list} == set(a_ids)
    assert {t.id for t in b_list} == set(b_ids)
    assert all(t.user_id == "user-a" for t in a_list)
    assert all(t.user_id == "user-b" for t in b_list)

    # Cross-user get is None.
    assert await svc.get_task(a_ids[0], user_id="user-b") is None
    assert await svc.get_task(b_ids[0], user_id="user-a") is None
    assert (await svc.get_task(a_ids[0], user_id="user-a")) is not None

    # Cross-user update is no-op.
    assert await svc.update_status(a_ids[0], "approved", user_id="user-b") == 0
    a0 = await svc.get_task(a_ids[0], user_id="user-a")
    assert a0 is not None and a0.status == "pending"
    assert await svc.update_status(a_ids[0], "approved", user_id="user-a") == 1

    # Cross-user delete is no-op.
    assert await svc.delete_task(b_ids[0], user_id="user-a") == 0
    assert (await svc.get_task(b_ids[0], user_id="user-b")) is not None
    assert await svc.delete_task(b_ids[0], user_id="user-b") == 1
    assert (await svc.get_task(b_ids[0], user_id="user-b")) is None

    # Single-tenant mode (user_id=None) returns ALL rows — Seraphine
    # legacy contract is preserved.
    all_ids = {t.id for t in await svc.list_tasks(user_id=None)}
    assert legacy_id in all_ids
    assert a_ids[0] in all_ids and a_ids[1] in all_ids
    assert b_ids[1] in all_ids and b_ids[2] in all_ids
    assert b_ids[0] not in all_ids  # was deleted


async def test_legacy_row_invisible_to_authenticated_users(store: Store) -> None:
    svc = TaskService(store)
    legacy_id = await svc.create_task(
        type="generic", title="legacy", description="", source="chat",
        payload={}, user_id=None,
    )

    a_list = await svc.list_tasks(user_id="user-a")
    assert legacy_id not in {t.id for t in a_list}
    assert await svc.get_task(legacy_id, user_id="user-a") is None
    # Single-tenant query still sees it.
    assert (await svc.get_task(legacy_id, user_id=None)) is not None


async def test_create_task_inserts_owner_participant(store: Store) -> None:
    svc = TaskService(store)
    tid = await svc.create_task(
        type="generic", title="solo", description="", source="chat",
        payload={}, user_id="user-z",
    )
    with store._connect() as conn:
        rows = conn.execute(
            "SELECT user_id, role FROM task_participants WHERE task_id = ?",
            (tid,),
        ).fetchall()
    assert rows == [("user-z", "owner")]


async def test_create_task_seraphine_no_participant_row(store: Store) -> None:
    svc = TaskService(store)
    tid = await svc.create_task(
        type="generic", title="legacy", description="", source="chat",
        payload={}, user_id=None,
    )
    with store._connect() as conn:
        rows = conn.execute(
            "SELECT 1 FROM task_participants WHERE task_id = ?", (tid,),
        ).fetchall()
    assert rows == []
