"""Regression guard: deleting a task cascades to ``task_participants``.

The cascade depends on SQLite's ``PRAGMA foreign_keys = ON`` being set
on every connection opened by :class:`core_db.Store`. That PRAGMA lives
in ``core_db.store._connect`` today; this test pins the behavior so a
future refactor of the connection lifecycle cannot silently disable
FK enforcement and orphan participant rows.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from core_db import Store
from mod_tasks import TaskService
from mod_tasks import schema as tasks_schema


@pytest.fixture
async def store(tmp_path: Path) -> Store:
    s = Store(tmp_path / "cascade.sqlite")
    s.register_migrator("mod_tasks", tasks_schema.migrate)
    await s.ensure_schema()
    return s


async def test_delete_task_cascades_participants(store: Store) -> None:
    svc = TaskService(store)
    tid = await svc.create_task(
        type="generic", title="t", description="", source="chat",
        payload={}, user_id="user-a",
    )
    # Manually add a member (we'll wire add_participant in later tasks)
    with store._connect() as conn:
        conn.execute(
            "INSERT INTO task_participants (task_id, user_id, role, joined_at)"
            " VALUES (?, ?, 'member', '2025-01-01')",
            (tid, "user-b"),
        )
    await svc.delete_task(tid, user_id="user-a")
    with store._connect() as conn:
        rows = conn.execute(
            "SELECT 1 FROM task_participants WHERE task_id = ?", (tid,),
        ).fetchall()
    assert rows == []
