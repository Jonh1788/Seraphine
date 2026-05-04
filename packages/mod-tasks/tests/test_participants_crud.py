from __future__ import annotations

from pathlib import Path

import pytest

from core_db import Store
from mod_tasks import TaskService
from mod_tasks import schema as tasks_schema


@pytest.fixture
async def store(tmp_path: Path) -> Store:
    s = Store(tmp_path / "crud.sqlite")
    s.register_migrator("mod_tasks", tasks_schema.migrate)
    await s.ensure_schema()
    return s


@pytest.fixture
def svc(store: Store) -> TaskService:
    s = TaskService(store)

    async def email_to_uid(email: str) -> str | None:
        # Synthetic mapping: "user-x@x" -> "user-x"
        if "@" not in email:
            return None
        local = email.split("@", 1)[0]
        return local if local.startswith("user-") else None

    async def uid_to_email(uid: str) -> str | None:
        return f"{uid}@x.com" if uid else None

    s.attach_user_lookup(email_to_user_id=email_to_uid, user_id_to_email=uid_to_email)
    return s


async def test_list_participants_includes_owner(svc: TaskService) -> None:
    tid = await svc.create_task(
        type="generic", title="t", description="", source="chat",
        payload={}, user_id="user-a",
    )
    emails = await svc.list_participants(tid)
    assert emails == ["user-a@x.com"]


async def test_list_participants_returns_empty_for_unknown_task(svc: TaskService) -> None:
    assert await svc.list_participants(99999) == []
