"""REST router for the internal Task system.

Exposes CRUD + execute endpoints for Seraphine's proactive tasks.
The TaskService instance is read from ``request.app.state.task_service``
(set during lifespan startup).
"""

from __future__ import annotations

import dataclasses
import json
import logging
import os
import tempfile
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from seraphine.tasks.models import TASK_STATUSES, TASK_TYPES, SeraphineTask
from seraphine.tasks.service import TaskService

router = APIRouter(tags=["tasks"])
logger = logging.getLogger(__name__)


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

def _service_or_503(request: Request) -> TaskService:
    svc: Optional[TaskService] = getattr(
        request.app.state, "task_service", None
    )
    if svc is None:
        raise HTTPException(
            status_code=503,
            detail="task service not configured",
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
    payload: str = "{}"


class TaskStatusUpdate(BaseModel):
    status: str


# ------------------------------------------------------------------
# Endpoints
# ------------------------------------------------------------------

@router.get("/tasks")
async def list_tasks(
    request: Request,
    status: str | None = None,
    type: str | None = None,
    limit: int = 50,
) -> dict[str, Any]:
    """List tasks with optional filters."""
    svc = _service_or_503(request)
    try:
        tasks = await svc.list_tasks(status=status, type=type, limit=limit)
        return {"tasks": [dataclasses.asdict(t) for t in tasks]}
    except Exception as e:
        logger.exception("task list failed")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/tasks")
async def create_task(request: Request, body: TaskCreate) -> dict[str, Any]:
    """Create a new task."""
    svc = _service_or_503(request)
    task = SeraphineTask(
        id=None,
        type=body.type,
        status="pending",
        title=body.title,
        description=body.description,
        source=body.source,
        payload=body.payload,
    )
    try:
        task_id = await svc.create_task(task)
        return {"id": task_id, "ok": True}
    except Exception as e:
        logger.exception("task create failed")
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/tasks/{task_id}")
async def update_task_status(
    request: Request,
    task_id: int,
    body: TaskStatusUpdate,
) -> dict[str, bool]:
    """Update the status of a task."""
    svc = _service_or_503(request)
    if body.status not in TASK_STATUSES:
        raise HTTPException(
            status_code=422,
            detail=f"status must be one of {TASK_STATUSES}",
        )
    try:
        await svc.update_status(task_id, body.status)
        return {"ok": True}
    except Exception as e:
        logger.exception("task status update failed")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/tasks/{task_id}/execute")
async def execute_task(
    request: Request,
    task_id: int,
    body: dict = {},  # noqa: B006
) -> dict[str, Any]:
    """Execute a pending task based on its type."""
    svc = _service_or_503(request)
    task = await svc.get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="task not found")

    payload = json.loads(task.payload)

    if task.type == "finance_import":
        google = getattr(request.app.state, "google_client", None)
        if not google:
            raise HTTPException(503, "Google client not available")

        try:
            # Download attachment
            attachment_bytes = await google.download_attachment(
                payload["email_id"],
                payload["attachment_id"],
            )

            # Save to temp file
            fd, tmp_path = tempfile.mkstemp(suffix=".pdf")
            os.write(fd, attachment_bytes)
            os.close(fd)

            # Update task status
            await svc.update_status(task_id, "approved")

            return {
                "ok": True,
                "file_path": tmp_path,
                "filename": payload.get("filename", "attachment.pdf"),
                "instruction": (
                    f"O arquivo PDF foi baixado para {tmp_path}. "
                    f"Use a tool import_financial_pdf com file_path='{tmp_path}' "
                    f"para extrair as transacoes."
                ),
            }
        except Exception as e:
            logger.exception("finance_import execution failed")
            await svc.update_status(task_id, "failed")
            raise HTTPException(status_code=500, detail=str(e))

    # Generic: just approve
    await svc.update_status(task_id, "approved")
    return {"ok": True}


@router.delete("/tasks/{task_id}")
async def delete_task(
    request: Request,
    task_id: int,
) -> dict[str, bool]:
    """Delete a task."""
    svc = _service_or_503(request)
    try:
        await svc.delete_task(task_id)
        return {"ok": True}
    except Exception as e:
        logger.exception("task delete failed")
        raise HTTPException(status_code=500, detail=str(e))
