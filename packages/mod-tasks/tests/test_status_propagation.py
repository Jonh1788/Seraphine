from __future__ import annotations

from pathlib import Path

import pytest

from core_db import Store
from mod_tasks import TaskService
from mod_tasks import schema as tasks_schema


class FakePush:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []

    async def send_to_user(self, user_id, payload):
        self.calls.append((user_id, payload))
        return 1


@pytest.fixture
async def store(tmp_path: Path) -> Store:
    s = Store(tmp_path / "prop.sqlite")
    s.register_migrator("mod_tasks", tasks_schema.migrate)
    await s.ensure_schema()
    return s


@pytest.fixture
def svc(store: Store) -> tuple[TaskService, FakePush]:
    s = TaskService(store)

    async def email_to_uid(email: str) -> str | None:
        local = email.split("@", 1)[0] if "@" in email else None
        return local if local and local.startswith("user-") else None

    async def uid_to_email(uid: str) -> str | None:
        return f"{uid}@x.com"

    s.attach_user_lookup(email_to_user_id=email_to_uid, user_id_to_email=uid_to_email)
    push = FakePush()
    s.attach_push(push)
    return s, push


async def test_complete_propagates_completed_by(svc) -> None:
    s, _push = svc
    tid = await s.create_task(
        type="generic", title="t", description="", source="chat",
        payload={}, user_id="user-a",
    )
    await s.add_participant(tid, caller_id="user-a", target_email="user-b@x.com")

    await s.update_status(tid, "completed", user_id="user-b")
    # Wait for any pending fire-and-forget pushes
    import asyncio as _aio
    await _aio.sleep(0.05)

    a = await s.get_task(tid, user_id="user-a")
    b = await s.get_task(tid, user_id="user-b")
    assert a is not None and a.status == "completed"
    assert a.completed_by == "user-b"
    assert a.completed_by_email == "user-b@x.com"
    assert b is not None and b.completed_by == "user-b"


async def test_reopen_clears_completed_by(svc) -> None:
    s, _push = svc
    tid = await s.create_task(
        type="generic", title="t", description="", source="chat",
        payload={}, user_id="user-a",
    )
    await s.add_participant(tid, caller_id="user-a", target_email="user-b@x.com")
    await s.update_status(tid, "completed", user_id="user-b")
    await s.update_status(tid, "pending", user_id="user-a")

    a = await s.get_task(tid, user_id="user-a")
    assert a is not None
    assert a.status == "pending"
    assert a.completed_by is None
    assert a.completed_by_email is None


async def test_push_sent_to_other_participants_on_complete(svc) -> None:
    s, push = svc
    tid = await s.create_task(
        type="generic", title="comprar pão", description="", source="chat",
        payload={}, user_id="user-a",
    )
    await s.add_participant(tid, caller_id="user-a", target_email="user-b@x.com")
    push.calls.clear()  # ignore the invite push

    await s.update_status(tid, "completed", user_id="user-b")
    import asyncio as _aio
    await _aio.sleep(0.05)

    # Push goes to user-a (other participant), NOT user-b (the completer)
    targets = {uid for uid, _ in push.calls}
    assert targets == {"user-a"}
    body = push.calls[0][1]["body"]
    assert "user-b@x.com" in body
    assert "comprar pão" in body


async def test_idempotent_status_no_push(svc) -> None:
    s, push = svc
    tid = await s.create_task(
        type="generic", title="t", description="", source="chat",
        payload={}, user_id="user-a",
    )
    await s.update_status(tid, "completed", user_id="user-a")
    push.calls.clear()
    await s.update_status(tid, "completed", user_id="user-a")
    import asyncio as _aio
    await _aio.sleep(0.05)
    assert push.calls == []
