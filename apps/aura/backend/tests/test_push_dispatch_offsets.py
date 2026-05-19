"""PushService.dispatch_due_reminders — multi-offset fan-out.

Builds a real SQLite store + TaskService, seeds a reminder with three
offsets, then walks the dispatcher and verifies:
- Each offset fires once (3 deliveries total).
- A second tick is idempotent (no re-fire).
- The push payload includes per-offset tag + body text.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from core_db import Store
from mod_tasks import TaskService
from mod_tasks import schema as tasks_schema

from aura.push import schema as push_schema
from aura.push.service import PushService


@pytest.fixture
async def store(tmp_path: Path) -> Store:
    s = Store(str(tmp_path / "dispatch.sqlite"))
    s.register_migrator("mod_tasks", tasks_schema.migrate)
    s.register_migrator("aura_push", push_schema.migrate)
    await s.ensure_schema()
    return s


def _make_push(store: Store, tasks: TaskService) -> PushService:
    return PushService(
        store=store,
        tasks=tasks,
        vapid_subject="mailto:t@x.io",
        vapid_private_pem=None,
        vapid_public_b64=None,
    )


async def test_three_offsets_fire_three_pushes_then_idempotent(store: Store) -> None:
    tasks = TaskService(store)
    # Create a reminder scheduled 5 minutes ago. With offsets [0, 15, 60]
    # all three fire times have already passed → all should dispatch.
    fire_dt = datetime.now() - timedelta(minutes=5)
    due_date = fire_dt.strftime("%Y-%m-%d")
    due_time = fire_dt.strftime("%H:%M")
    tid = await tasks.create_task(
        type="reminder", title="Dentista", description="",
        source="chat", payload={},
        due_date=due_date, due_time=due_time,
        user_id="u1",
    )
    await tasks.set_reminder_offsets(str(tid), "u1", [0, 15, 60])

    push = _make_push(store, tasks)
    # Stub send_to_user → always succeed with 1 subscription.
    push.send_to_user = AsyncMock(return_value=1)  # type: ignore[method-assign]

    count = await push.dispatch_due_reminders()
    assert count == 3
    assert push.send_to_user.await_count == 3
    # Per-offset tags assert payload differentiation.
    tags = {call.args[1]["tag"] for call in push.send_to_user.await_args_list}
    assert tags == {
        f"reminder-{tid}-0",
        f"reminder-{tid}-15",
        f"reminder-{tid}-60",
    }

    # Second tick: all already dispatched, nothing fires.
    push.send_to_user.reset_mock()
    count2 = await push.dispatch_due_reminders()
    assert count2 == 0
    assert push.send_to_user.await_count == 0


async def test_future_offsets_do_not_fire(store: Store) -> None:
    """A reminder due 10 minutes from now with offsets [0, 60] → only
    the 60-min-before offset has already fired (10 - 60 = past); the
    0-offset is still in the future."""
    tasks = TaskService(store)
    fire_dt = datetime.now() + timedelta(minutes=10)
    due_date = fire_dt.strftime("%Y-%m-%d")
    due_time = fire_dt.strftime("%H:%M")
    tid = await tasks.create_task(
        type="reminder", title="Reunião", description="",
        source="chat", payload={},
        due_date=due_date, due_time=due_time,
        user_id="u1",
    )
    await tasks.set_reminder_offsets(str(tid), "u1", [0, 60])

    push = _make_push(store, tasks)
    push.send_to_user = AsyncMock(return_value=1)  # type: ignore[method-assign]
    count = await push.dispatch_due_reminders()
    assert count == 1
    tags = {call.args[1]["tag"] for call in push.send_to_user.await_args_list}
    assert tags == {f"reminder-{tid}-60"}


async def test_dispatch_payload_body_includes_offset_prefix(store: Store) -> None:
    tasks = TaskService(store)
    fire_dt = datetime.now() - timedelta(minutes=1)
    due_date = fire_dt.strftime("%Y-%m-%d")
    due_time = fire_dt.strftime("%H:%M")
    tid = await tasks.create_task(
        type="reminder", title="Tomar remédio", description="",
        source="chat", payload={},
        due_date=due_date, due_time=due_time,
        user_id="u1",
    )
    # Make the 15-min-before fire time past too: due 1 min ago, offset
    # 15 → fire was 16 min ago.
    await tasks.set_reminder_offsets(str(tid), "u1", [15])
    push = _make_push(store, tasks)
    seen: list[dict[str, Any]] = []

    async def _capture(user_id: str, payload: dict[str, Any]) -> int:
        seen.append(payload)
        return 1

    push.send_to_user = _capture  # type: ignore[method-assign]
    await push.dispatch_due_reminders()
    assert len(seen) == 1
    body = seen[0]["body"]
    assert body.startswith("em 15 min"), body
