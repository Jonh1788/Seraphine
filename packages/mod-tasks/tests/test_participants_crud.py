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


async def test_add_participant_owner_succeeds(svc: TaskService) -> None:
    tid = await svc.create_task(
        type="generic", title="t", description="", source="chat",
        payload={}, user_id="user-a",
    )
    emails = await svc.add_participant(tid, caller_id="user-a", target_email="user-b@x.com")
    assert set(emails) == {"user-a@x.com", "user-b@x.com"}


async def test_add_participant_member_forbidden(svc: TaskService) -> None:
    tid = await svc.create_task(
        type="generic", title="t", description="", source="chat",
        payload={}, user_id="user-a",
    )
    await svc.add_participant(tid, caller_id="user-a", target_email="user-b@x.com")
    with pytest.raises(PermissionError):
        await svc.add_participant(tid, caller_id="user-b", target_email="user-c@x.com")


async def test_add_participant_unknown_email_raises(svc: TaskService) -> None:
    tid = await svc.create_task(
        type="generic", title="t", description="", source="chat",
        payload={}, user_id="user-a",
    )
    with pytest.raises(LookupError):
        await svc.add_participant(tid, caller_id="user-a", target_email="ghost@nowhere.com")


async def test_add_participant_already_member_raises(svc: TaskService) -> None:
    tid = await svc.create_task(
        type="generic", title="t", description="", source="chat",
        payload={}, user_id="user-a",
    )
    await svc.add_participant(tid, caller_id="user-a", target_email="user-b@x.com")
    with pytest.raises(ValueError):
        await svc.add_participant(tid, caller_id="user-a", target_email="user-b@x.com")


async def test_leave_task_member_succeeds(svc: TaskService) -> None:
    tid = await svc.create_task(
        type="generic", title="t", description="", source="chat",
        payload={}, user_id="user-a",
    )
    await svc.add_participant(tid, caller_id="user-a", target_email="user-b@x.com")
    await svc.leave_task(tid, caller_id="user-b")
    emails = await svc.list_participants(tid)
    assert emails == ["user-a@x.com"]


async def test_leave_task_owner_forbidden(svc: TaskService) -> None:
    tid = await svc.create_task(
        type="generic", title="t", description="", source="chat",
        payload={}, user_id="user-a",
    )
    with pytest.raises(PermissionError):
        await svc.leave_task(tid, caller_id="user-a")


async def test_leave_task_non_participant_raises(svc: TaskService) -> None:
    tid = await svc.create_task(
        type="generic", title="t", description="", source="chat",
        payload={}, user_id="user-a",
    )
    with pytest.raises(PermissionError):
        await svc.leave_task(tid, caller_id="user-x")


async def test_remove_participant_owner_succeeds(svc: TaskService) -> None:
    tid = await svc.create_task(
        type="generic", title="t", description="", source="chat",
        payload={}, user_id="user-a",
    )
    await svc.add_participant(tid, caller_id="user-a", target_email="user-b@x.com")
    await svc.remove_participant(tid, caller_id="user-a", target_user_id="user-b")
    emails = await svc.list_participants(tid)
    assert emails == ["user-a@x.com"]


async def test_remove_participant_member_forbidden(svc: TaskService) -> None:
    tid = await svc.create_task(
        type="generic", title="t", description="", source="chat",
        payload={}, user_id="user-a",
    )
    await svc.add_participant(tid, caller_id="user-a", target_email="user-b@x.com")
    await svc.add_participant(tid, caller_id="user-a", target_email="user-c@x.com")
    with pytest.raises(PermissionError):
        await svc.remove_participant(tid, caller_id="user-b", target_user_id="user-c")


async def test_remove_participant_owner_cannot_remove_self(svc: TaskService) -> None:
    tid = await svc.create_task(
        type="generic", title="t", description="", source="chat",
        payload={}, user_id="user-a",
    )
    with pytest.raises(ValueError):
        await svc.remove_participant(tid, caller_id="user-a", target_user_id="user-a")


async def test_update_task_member_can_edit(svc: TaskService) -> None:
    tid = await svc.create_task(
        type="generic", title="t", description="", source="chat",
        payload={}, user_id="user-a",
    )
    await svc.add_participant(tid, caller_id="user-a", target_email="user-b@x.com")
    affected = await svc.update_task(tid, user_id="user-b", title="t-edited")
    assert affected == 1
    task = await svc.get_task(tid, user_id="user-a")
    assert task is not None and task.title == "t-edited"


async def test_update_task_non_participant_returns_zero(svc: TaskService) -> None:
    tid = await svc.create_task(
        type="generic", title="t", description="", source="chat",
        payload={}, user_id="user-a",
    )
    affected = await svc.update_task(tid, user_id="user-x", title="hax")
    assert affected == 0


async def test_delete_task_member_forbidden(svc: TaskService) -> None:
    tid = await svc.create_task(
        type="generic", title="t", description="", source="chat",
        payload={}, user_id="user-a",
    )
    await svc.add_participant(tid, caller_id="user-a", target_email="user-b@x.com")
    affected = await svc.delete_task(tid, user_id="user-b")
    assert affected == 0  # not owner — silent no-op (matches existing convention)
    # Task still exists
    assert (await svc.get_task(tid, user_id="user-a")) is not None


async def test_delete_task_owner_succeeds(svc: TaskService) -> None:
    tid = await svc.create_task(
        type="generic", title="t", description="", source="chat",
        payload={}, user_id="user-a",
    )
    affected = await svc.delete_task(tid, user_id="user-a")
    assert affected == 1
    assert (await svc.get_task(tid, user_id="user-a")) is None
