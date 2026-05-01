"""Best-effort Google Calendar sync for tasks/reminders.

Registered as a TaskService hook in ``main.py``. Every time a task with
a ``due_date`` is created, the user has Google connected, and the task
type isn't excluded, a corresponding event is created on the user's
primary calendar. The Google event id is persisted back to the task's
``payload.google_event_id`` so future updates/deletes can mirror.

Failures (no auth, API errors, malformed dates) are logged and never
propagated — task creation must keep working even when Google is down.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timedelta
from typing import Awaitable, Callable
from zoneinfo import ZoneInfo

from mod_tasks.service import TaskService, _now as _ts_now

from aura.google.service import GoogleAuthService

logger = logging.getLogger(__name__)

_TZ = ZoneInfo("America/Sao_Paulo")

# Task types that should not mirror to the calendar (e.g. background
# automation jobs that don't represent something the user wants to see
# on their schedule).
_EXCLUDED_TYPES = {"finance_import", "email_scan"}


def _build_hook(
    tasks: TaskService, google: GoogleAuthService,
) -> Callable[[int, str | None], Awaitable[None]]:
    async def _on_task_created(task_id: int, user_id: str | None) -> None:
        if user_id is None:
            return
        task = await tasks.get_task(task_id, user_id=user_id)
        if task is None or task.type in _EXCLUDED_TYPES:
            return
        if not task.due_date:
            return
        # If we already mirrored (e.g. from chat path) just skip.
        if isinstance(task.payload, dict) and task.payload.get("google_event_id"):
            return

        client = await google.client_for(user_id)
        if client is None:
            return

        try:
            if task.due_time:
                start = datetime.strptime(
                    f"{task.due_date} {task.due_time}", "%Y-%m-%d %H:%M",
                ).replace(tzinfo=_TZ)
                end = start + timedelta(hours=1)
                event = await client.create_event(
                    summary=task.title,
                    start=start,
                    end=end,
                    description=task.description or None,
                )
            else:
                start_d = datetime.strptime(task.due_date, "%Y-%m-%d").date()
                end_d = start_d + timedelta(days=1)
                from google_integration.client import CALENDAR_API
                url = f"{CALENDAR_API}/calendars/primary/events"
                body: dict = {
                    "summary": task.title,
                    "start": {"date": start_d.isoformat()},
                    "end": {"date": end_d.isoformat()},
                }
                if task.description:
                    body["description"] = task.description
                resp = await client._authed_request("POST", url, json=body)
                client.event_cache.invalidate_calendar("primary")
                event = resp.json()
        except Exception:
            logger.exception(
                "calendar mirror failed task=%s user=%s", task_id, user_id,
            )
            return

        event_id = event.get("id") if isinstance(event, dict) else None
        if not event_id:
            return
        await _persist_event_id(tasks, task_id, str(event_id), user_id)

    return _on_task_created


async def _persist_event_id(
    tasks: TaskService, task_id: int, event_id: str, user_id: str,
) -> None:
    def _work() -> None:
        with tasks._store._connect() as conn:
            cur = conn.execute(
                "SELECT payload FROM seraphine_tasks WHERE id = ? AND user_id = ?",
                (task_id, user_id),
            )
            row = cur.fetchone()
            if row is None:
                return
            try:
                payload = json.loads(row[0]) if row[0] else {}
                if not isinstance(payload, dict):
                    payload = {}
            except Exception:
                payload = {}
            payload["google_event_id"] = event_id
            conn.execute(
                "UPDATE seraphine_tasks SET payload = ?, updated_at = ?"
                " WHERE id = ? AND user_id = ?",
                (
                    json.dumps(payload, ensure_ascii=False),
                    _ts_now(),
                    task_id,
                    user_id,
                ),
            )

    try:
        await asyncio.to_thread(_work)
    except Exception:
        logger.exception(
            "failed to persist google_event_id task=%s", task_id,
        )


def _build_delete_hook(
    google: GoogleAuthService,
) -> Callable[[int, str | None, dict], Awaitable[None]]:
    async def _on_task_deleted(
        task_id: int, user_id: str | None, payload: dict,
    ) -> None:
        if user_id is None:
            return
        event_id = payload.get("google_event_id") if isinstance(payload, dict) else None
        if not event_id:
            return
        client = await google.client_for(user_id)
        if client is None:
            return
        try:
            await client.delete_event(str(event_id))
        except Exception:
            logger.exception(
                "calendar mirror delete failed task=%s user=%s event=%s",
                task_id, user_id, event_id,
            )

    return _on_task_deleted


def register(tasks: TaskService, google: GoogleAuthService) -> None:
    """Wire the create + delete hooks into the TaskService instance."""
    tasks.add_on_created_hook(_build_hook(tasks, google))
    tasks.add_on_deleted_hook(_build_delete_hook(google))
