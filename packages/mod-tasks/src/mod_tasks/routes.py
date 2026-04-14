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

from mod_tasks.models import TASK_STATUSES, TASK_TYPES
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

class TaskCreate(BaseModel):
    type: str
    title: str
    description: str = ""
    source: str = "system"
    payload: dict[str, Any] = Field(default_factory=dict)
    due_date: str | None = None  # YYYY-MM-DD
    due_time: str | None = None  # HH:MM (24h)


class TaskStatusUpdate(BaseModel):
    status: str


class TaskExecute(BaseModel):
    params: dict[str, Any] = Field(default_factory=dict)


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
        )
        return {"id": task_id, "ok": True}
    except Exception as e:
        logger.exception("task create failed")
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/tasks/{task_id}")
async def update_task_status(
    request: Request,
    task_id: int,
    body: TaskStatusUpdate,
    user_id: str | None = Depends(get_current_user_id),
) -> dict[str, bool]:
    svc = _service_or_503(request)
    if body.status not in TASK_STATUSES:
        raise HTTPException(
            status_code=422, detail=f"status must be one of {TASK_STATUSES}",
        )
    try:
        affected = await svc.update_status(task_id, body.status, user_id=user_id)
    except Exception as e:
        logger.exception("task status update failed")
        raise HTTPException(status_code=500, detail=str(e))
    if not affected:
        raise HTTPException(status_code=404, detail="task not found")
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
