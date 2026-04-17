"""073 — Background task routes."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

router = APIRouter(prefix="/background_tasks", tags=["background_tasks"])


class StartIn(BaseModel):
    goal: str = Field(..., min_length=5, max_length=1200)
    max_duration_min: int = Field(default=30, ge=5, le=120)


@router.post("")
async def start_task(payload: StartIn, request: Request) -> dict[str, Any]:
    mgr = getattr(request.app.state, "background_manager", None)
    if mgr is None:
        raise HTTPException(status_code=503, detail="background manager not ready")
    try:
        task_id = await mgr.start(payload.goal, payload.max_duration_min)
    except RuntimeError as e:
        raise HTTPException(status_code=429, detail=str(e))
    return {"task_id": task_id}


@router.get("")
async def list_tasks(request: Request, status: str | None = None) -> dict[str, Any]:
    mgr = getattr(request.app.state, "background_manager", None)
    if mgr is None:
        raise HTTPException(status_code=503, detail="background manager not ready")
    return {"tasks": await mgr.list_tasks(status)}


@router.post("/{task_id}/cancel")
async def cancel_task(task_id: str, request: Request) -> dict[str, Any]:
    mgr = getattr(request.app.state, "background_manager", None)
    if mgr is None:
        raise HTTPException(status_code=503, detail="background manager not ready")
    ok = await mgr.cancel(task_id)
    if not ok:
        raise HTTPException(status_code=404, detail="task not running")
    return {"ok": True}
