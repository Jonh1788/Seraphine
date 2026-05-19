"""REST router for the internal Task system.

Multi-tenant aware: every route depends on ``get_current_user_id`` which
each app overrides. Seraphine uses the default (returns None ⇒
single-tenant). Aura overrides it with a JWT-validating dep that returns
the authenticated user's id.
"""

from __future__ import annotations

import dataclasses
import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from mod_tasks.models import TASK_PRIORITIES, TASK_STATUSES, TASK_TYPES
from mod_tasks.service import TaskService

router = APIRouter(tags=["tasks"])
logger = logging.getLogger(__name__)


def get_current_user_id() -> str | None:
    """Return the user_id for the current request.

    Default: None (single-tenant). Apps override via
    ``app.dependency_overrides[get_current_user_id] = ...`` to plug in
    JWT/session-based authentication.
    """
    return None


def _service_or_503(request: Request) -> TaskService:
    svc: Optional[TaskService] = getattr(
        request.app.state, "task_service", None,
    )
    if svc is None:
        raise HTTPException(
            status_code=503, detail="task service not configured",
        )
    return svc


# ------------------------------------------------------------------
# Request / response models
# ------------------------------------------------------------------

REMIND_VALUES = {"at_time", "1h_before", "1d_before"}
# 30 days in minutes — anything larger is almost certainly a unit mistake.
MAX_OFFSET_MINUTES = 60 * 24 * 30


def _validate_offsets(raw: list[int] | None) -> list[int] | None:
    """Validate user-supplied offsets. Returns None if input is None.
    Raises 422 on negative / out-of-range values."""
    if raw is None:
        return None
    cleaned: list[int] = []
    for o in raw:
        if not isinstance(o, int) or isinstance(o, bool):
            raise HTTPException(
                status_code=422,
                detail="reminder_offsets must be integers (minutes)",
            )
        if o < 0 or o > MAX_OFFSET_MINUTES:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"reminder_offsets must be 0..{MAX_OFFSET_MINUTES}"
                    f" (got {o})"
                ),
            )
        cleaned.append(o)
    return cleaned


def _materialize_offsets(
    user_offsets: list[int] | None, due_time: str | None,
) -> list[int] | None:
    """Apply the spec's decision rule.

    - user_offsets provided → ``sorted(set([0] + offsets))`` (always
      include 0 = at-due).
    - user_offsets None and due_time set → ``[0]`` (default on-time).
    - user_offsets None and due_time None → None (store nothing).
    - user_offsets == [] (explicit empty) → [] (caller wants no reminders
      at all).
    """
    if user_offsets is None:
        return [0] if due_time else None
    if not user_offsets:
        return []
    return sorted({0, *user_offsets})


class TaskCreate(BaseModel):
    type: str
    title: str
    description: str = ""
    source: str = "system"
    payload: dict[str, Any] = Field(default_factory=dict)
    due_date: str | None = None  # YYYY-MM-DD
    due_time: str | None = None  # HH:MM (24h)
    priority: str | None = None  # low / med / high
    tags: list[str] | None = None
    remind: str | None = None  # at_time / 1h_before / 1d_before (legacy)
    reminder_offsets: list[int] | None = None  # minutes before due_time


class TaskPatch(BaseModel):
    # All fields optional — only provided keys are updated. To clear a
    # nullable field, send an explicit empty string (for due_date/time/
    # priority/remind) or an empty list (tags).
    title: str | None = None
    description: str | None = None
    status: str | None = None
    due_date: str | None = None
    due_time: str | None = None
    priority: str | None = None
    tags: list[str] | None = None
    remind: str | None = None  # at_time / 1h_before / 1d_before / "" to clear
    reminder_offsets: list[int] | None = None  # None = leave as-is


class TaskExecute(BaseModel):
    params: dict[str, Any] = Field(default_factory=dict)


class AddParticipantBody(BaseModel):
    email: str = Field(..., min_length=3, max_length=320)


# ------------------------------------------------------------------
# Endpoints
# ------------------------------------------------------------------

@router.get("/tasks")
async def list_tasks(
    request: Request,
    status: str | None = None,
    type: str | None = None,
    limit: int = 100,
    due_from: str | None = None,
    due_to: str | None = None,
    user_id: str | None = Depends(get_current_user_id),
) -> dict[str, Any]:
    svc = _service_or_503(request)
    try:
        tasks = await svc.list_tasks(
            status=status, type=type, limit=limit,
            due_from=due_from, due_to=due_to, user_id=user_id,
        )
        return {"tasks": [dataclasses.asdict(t) for t in tasks]}
    except Exception as e:
        logger.exception("task list failed")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/tasks/by-date-range")
async def list_tasks_by_date_range(
    request: Request,
    start: str,
    end: str,
    limit: int = 500,
    user_id: str | None = Depends(get_current_user_id),
) -> dict[str, Any]:
    """Return tasks with due_date in [start, end] (YYYY-MM-DD inclusive)."""
    svc = _service_or_503(request)
    try:
        tasks = await svc.list_tasks(
            limit=limit, due_from=start, due_to=end, user_id=user_id,
        )
        return {"tasks": [dataclasses.asdict(t) for t in tasks]}
    except Exception as e:
        logger.exception("task by-date-range failed")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/tasks")
async def create_task(
    request: Request,
    body: TaskCreate,
    user_id: str | None = Depends(get_current_user_id),
) -> dict[str, Any]:
    svc = _service_or_503(request)
    if body.type not in TASK_TYPES:
        raise HTTPException(
            status_code=422, detail=f"type must be one of {TASK_TYPES}",
        )
    if body.priority is not None and body.priority not in TASK_PRIORITIES:
        raise HTTPException(
            status_code=422,
            detail=f"priority must be one of {TASK_PRIORITIES}",
        )
    if body.remind is not None and body.remind not in REMIND_VALUES:
        raise HTTPException(
            status_code=422,
            detail=f"remind must be one of {sorted(REMIND_VALUES)}",
        )
    validated_offsets = _validate_offsets(body.reminder_offsets)
    try:
        task_id = await svc.create_task(
            type=body.type,
            title=body.title,
            description=body.description,
            source=body.source,
            payload=body.payload,
            due_date=body.due_date,
            due_time=body.due_time,
            user_id=user_id,
            priority=body.priority,
            tags=body.tags,
            remind=body.remind,
        )
        materialized = _materialize_offsets(validated_offsets, body.due_time)
        if materialized is not None:
            await svc.set_reminder_offsets(
                str(task_id), user_id or "", materialized,
            )
        return {"id": task_id, "ok": True}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("task create failed")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/tasks/{task_id}")
async def get_task(
    request: Request,
    task_id: int,
    user_id: str | None = Depends(get_current_user_id),
) -> dict[str, Any]:
    svc = _service_or_503(request)
    task = await svc.get_task(task_id, user_id=user_id)
    if task is None:
        raise HTTPException(status_code=404, detail="task not found")
    return dataclasses.asdict(task)


@router.patch("/tasks/{task_id}")
async def update_task(
    request: Request,
    task_id: int,
    body: TaskPatch,
    user_id: str | None = Depends(get_current_user_id),
) -> dict[str, bool]:
    svc = _service_or_503(request)
    data = body.model_dump(exclude_unset=True)
    if not data:
        raise HTTPException(status_code=422, detail="empty patch body")
    if "status" in data and data["status"] not in TASK_STATUSES:
        raise HTTPException(
            status_code=422, detail=f"status must be one of {TASK_STATUSES}",
        )
    # priority: accept None/empty-string as "clear". Validate real values.
    unset_priority = False
    priority_val: str | None = None
    if "priority" in data:
        raw = data["priority"]
        if raw in (None, ""):
            unset_priority = True
        elif raw in TASK_PRIORITIES:
            priority_val = raw
        else:
            raise HTTPException(
                status_code=422,
                detail=f"priority must be one of {TASK_PRIORITIES}",
            )
    # due_date / due_time: empty string means "clear".
    unset_due_date = False
    due_date_val: str | None = None
    if "due_date" in data:
        raw = data["due_date"]
        if raw in (None, ""):
            unset_due_date = True
        else:
            due_date_val = raw
    unset_due_time = False
    due_time_val: str | None = None
    if "due_time" in data:
        raw = data["due_time"]
        if raw in (None, ""):
            unset_due_time = True
        else:
            due_time_val = raw

    # remind: empty string means "clear". Validate real values.
    unset_remind = False
    remind_val: str | None = None
    if "remind" in data:
        raw = data["remind"]
        if raw in (None, ""):
            unset_remind = True
        elif raw in REMIND_VALUES:
            remind_val = raw
        else:
            raise HTTPException(
                status_code=422,
                detail=f"remind must be one of {sorted(REMIND_VALUES)}",
            )

    # reminder_offsets: explicit None = leave as-is, [] = clear, list = replace.
    offsets_provided = "reminder_offsets" in data
    offsets_val: list[int] | None = None
    if offsets_provided:
        offsets_val = _validate_offsets(data.get("reminder_offsets"))

    # If the patch only touches reminder_offsets, there's nothing for
    # update_task to write — skip it and authorize via a get_task lookup.
    only_offsets = offsets_provided and set(data.keys()) == {"reminder_offsets"}

    if only_offsets:
        existing = await svc.get_task(task_id, user_id=user_id)
        if existing is None:
            raise HTTPException(status_code=404, detail="task not found")
        new_due_time = existing.due_time
    else:
        try:
            affected = await svc.update_task(
                task_id,
                user_id=user_id,
                title=data.get("title") if "title" in data else None,
                description=(
                    data.get("description") if "description" in data else None
                ),
                status=data.get("status") if "status" in data else None,
                due_date=due_date_val,
                due_time=due_time_val,
                priority=priority_val,
                tags=data.get("tags") if "tags" in data else None,
                remind=remind_val,
                unset_due_date=unset_due_date,
                unset_due_time=unset_due_time,
                unset_priority=unset_priority,
                unset_remind=unset_remind,
            )
        except Exception as e:
            logger.exception("task update failed")
            raise HTTPException(status_code=500, detail=str(e))
        if not affected:
            raise HTTPException(status_code=404, detail="task not found")
        new_due_time = due_time_val
        if not new_due_time and not unset_due_time:
            persisted = await svc.get_task(task_id, user_id=user_id)
            new_due_time = persisted.due_time if persisted else None
    if offsets_provided:
        materialized = _materialize_offsets(offsets_val, new_due_time)
        if materialized is None:
            materialized = []
        await svc.set_reminder_offsets(
            str(task_id), user_id or "", materialized,
        )
    return {"ok": True}


@router.post("/tasks/{task_id}/execute")
async def execute_task(
    request: Request,
    task_id: int,
    body: TaskExecute | None = None,
    user_id: str | None = Depends(get_current_user_id),
) -> dict[str, Any]:
    svc = _service_or_503(request)
    task = await svc.get_task(task_id, user_id=user_id)
    if task is None:
        raise HTTPException(status_code=404, detail="task not found")
    params = (body.params if body is not None else {}) or {}
    try:
        result = await svc.execute_task(task_id, params, user_id=user_id)
    except NotImplementedError as e:
        raise HTTPException(status_code=501, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.exception("task execute failed")
        raise HTTPException(status_code=500, detail=str(e))
    return {"ok": True, "result": result}


@router.delete("/tasks/{task_id}")
async def delete_task(
    request: Request,
    task_id: int,
    user_id: str | None = Depends(get_current_user_id),
) -> dict[str, bool]:
    svc = _service_or_503(request)
    try:
        affected = await svc.delete_task(task_id, user_id=user_id)
    except Exception as e:
        logger.exception("task delete failed")
        raise HTTPException(status_code=500, detail=str(e))
    if not affected:
        raise HTTPException(status_code=404, detail="task not found")
    return {"ok": True}


@router.post("/tasks/scan-email")
async def scan_email(request: Request, hours_back: int = 24) -> dict[str, Any]:
    scanner = getattr(request.app.state, "email_scanner", None)
    if scanner is None:
        raise HTTPException(
            status_code=503, detail="email scanner not configured",
        )
    try:
        created = await scanner.scan(hours_back=hours_back)
    except Exception as e:
        logger.exception("email scan failed")
        raise HTTPException(status_code=500, detail=str(e))
    return {"ok": True, "created": created}


@router.post("/tasks/{task_id}/participants")
async def add_participant(
    request: Request,
    task_id: int,
    body: AddParticipantBody,
    user_id: str | None = Depends(get_current_user_id),
) -> dict[str, Any]:
    if user_id is None:
        raise HTTPException(status_code=401, detail="auth required")
    svc = _service_or_503(request)
    try:
        emails = await svc.add_participant(
            task_id, caller_id=user_id, target_email=body.email,
        )
    except PermissionError:
        raise HTTPException(status_code=403, detail="only owner can add participants")
    except LookupError:
        raise HTTPException(status_code=404, detail="email not registered on Aura")
    except ValueError:
        raise HTTPException(status_code=409, detail="already a participant")
    return {"participants": emails}


@router.get("/tasks/{task_id}/participants")
async def get_participants(
    request: Request,
    task_id: int,
    user_id: str | None = Depends(get_current_user_id),
) -> dict[str, list[str]]:
    if user_id is None:
        raise HTTPException(status_code=401, detail="auth required")
    svc = _service_or_503(request)
    try:
        await svc._authorize_participant(task_id, user_id)
    except PermissionError:
        raise HTTPException(status_code=404, detail="task not found")
    return {"participants": await svc.list_participants(task_id)}


@router.delete("/tasks/{task_id}/participants/me")
async def leave_task(
    request: Request,
    task_id: int,
    user_id: str | None = Depends(get_current_user_id),
) -> dict[str, bool]:
    if user_id is None:
        raise HTTPException(status_code=401, detail="auth required")
    svc = _service_or_503(request)
    try:
        await svc.leave_task(task_id, caller_id=user_id)
    except PermissionError as e:
        msg = str(e)
        if "owner" in msg:
            raise HTTPException(status_code=400, detail="owner cannot leave the task")
        raise HTTPException(status_code=404, detail="task not found")
    return {"ok": True}


@router.delete("/tasks/{task_id}/participants/by-email/{email}")
async def remove_participant_by_email(
    request: Request,
    task_id: int,
    email: str,
    user_id: str | None = Depends(get_current_user_id),
) -> dict[str, bool]:
    if user_id is None:
        raise HTTPException(status_code=401, detail="auth required")
    svc = _service_or_503(request)
    try:
        await svc.remove_participant_by_email(
            task_id, caller_id=user_id, target_email=email,
        )
    except PermissionError:
        raise HTTPException(status_code=403, detail="only owner can remove participants")
    except LookupError:
        raise HTTPException(status_code=404, detail="email not registered on Aura")
    except ValueError:
        raise HTTPException(status_code=400, detail="owner cannot remove self")
    return {"ok": True}


@router.delete("/tasks/{task_id}/participants/{target_user_id}")
async def remove_participant(
    request: Request,
    task_id: int,
    target_user_id: str,
    user_id: str | None = Depends(get_current_user_id),
) -> dict[str, bool]:
    if user_id is None:
        raise HTTPException(status_code=401, detail="auth required")
    svc = _service_or_503(request)
    try:
        await svc.remove_participant(
            task_id, caller_id=user_id, target_user_id=target_user_id,
        )
    except PermissionError:
        raise HTTPException(status_code=403, detail="only owner can remove participants")
    except ValueError:
        raise HTTPException(status_code=400, detail="owner cannot remove self")
    return {"ok": True}
