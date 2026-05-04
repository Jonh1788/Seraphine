"""Aura sharing endpoints/methods do not affect Seraphine
single-tenant tasks (user_id=NULL). Verifies the natural gating
via task_participants."""

from __future__ import annotations

from pathlib import Path

import pytest

from core_db import Store
from mod_tasks import TaskService
from mod_tasks import schema as tasks_schema


@pytest.fixture
async def store(tmp_path: Path) -> Store:
    s = Store(tmp_path / "iso2.sqlite")
    s.register_migrator("mod_tasks", tasks_schema.migrate)
    await s.ensure_schema()
    return s


async def test_seraphine_task_has_no_participant_row(store: Store) -> None:
    svc = TaskService(store)
    tid = await svc.create_task(
        type="generic", title="seraphine", description="", source="chat",
        payload={}, user_id=None,
    )
    with store._connect() as conn:
        rows = conn.execute(
            "SELECT 1 FROM task_participants WHERE task_id = ?", (tid,),
        ).fetchall()
    assert rows == []


async def test_add_participant_to_seraphine_task_raises(store: Store) -> None:
    svc = TaskService(store)

    async def email_to_uid(email: str):
        return "user-x"

    async def uid_to_email(uid: str):
        return "x@x.com"

    svc.attach_user_lookup(email_to_user_id=email_to_uid, user_id_to_email=uid_to_email)
    tid = await svc.create_task(
        type="generic", title="legacy", description="", source="chat",
        payload={}, user_id=None,
    )
    # Caller is anyone — but no participant row exists for this task,
    # so _authorize_participant raises.
    with pytest.raises(PermissionError):
        await svc.add_participant(tid, caller_id="user-x", target_email="user-y@x.com")


async def test_seraphine_listing_unaffected(store: Store) -> None:
    """Seraphine path (user_id=None) returns ALL tasks regardless of
    participant rows."""
    svc = TaskService(store)
    await svc.create_task(
        type="generic", title="s1", description="", source="chat",
        payload={}, user_id=None,
    )
    await svc.create_task(
        type="generic", title="a1", description="", source="chat",
        payload={}, user_id="user-a",
    )
    listed = await svc.list_tasks(user_id=None)
    titles = {t.title for t in listed}
    assert {"s1", "a1"} <= titles
