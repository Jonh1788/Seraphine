"""Focus analytics HTTP API -- single-tenant, no auth required."""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from seraphine.focus.service import FocusService

router = APIRouter(prefix="/focus", tags=["focus"])
logger = logging.getLogger(__name__)


class LogSessionBody(BaseModel):
    started_at: str
    ended_at: str
    type: str = Field(pattern=r"^(work|short_break|long_break)$")
    completed: bool
    interruptions: int = 0
    notes: str | None = None
    # Optional life/work category; backend defaults to 'Foco' when omitted.
    category: str | None = None


class LogAppBody(BaseModel):
    session_id: str
    app_name: str = Field(min_length=1)
    started_at: str
    duration_sec: int = Field(ge=0)


def _service_or_503(request: Request) -> FocusService:
    svc: Optional[FocusService] = getattr(
        request.app.state, "focus_service", None,
    )
    if svc is None:
        raise HTTPException(status_code=503, detail="focus service not configured")
    return svc


class SetActiveBody(BaseModel):
    active: bool


@router.get("/active")
async def get_active(request: Request) -> dict[str, Any]:
    svc = _service_or_503(request)
    return {"active": svc.is_active()}


@router.post("/active")
async def set_active(request: Request, body: SetActiveBody) -> dict[str, Any]:
    svc = _service_or_503(request)
    svc.set_active(body.active)
    return {"active": svc.is_active()}


@router.post("/sessions")
async def log_session(request: Request, body: LogSessionBody) -> dict[str, Any]:
    svc = _service_or_503(request)
    try:
        session = await svc.log_session(
            started_at=body.started_at,
            ended_at=body.ended_at,
            type=body.type,
            completed=body.completed,
            interruptions=body.interruptions,
            notes=body.notes,
            category=body.category,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return {"session": session.to_dict()}


@router.get("/sessions")
async def list_sessions(
    request: Request,
    start: str,
    end: str,
) -> dict[str, Any]:
    svc = _service_or_503(request)
    sessions = await svc.get_sessions(start, end)
    return {"sessions": [s.to_dict() for s in sessions]}


@router.get("/stats")
async def focus_stats(
    request: Request,
    period: str = "week",
) -> dict[str, Any]:
    svc = _service_or_503(request)
    if period not in ("week", "month"):
        raise HTTPException(status_code=422, detail="period must be 'week' or 'month'")
    stats = await svc.get_stats(period)
    return stats.to_dict()


@router.get("/apps")
async def top_apps(
    request: Request,
    start: str,
    end: str,
    limit: int = 10,
) -> dict[str, Any]:
    svc = _service_or_503(request)
    apps = await svc.get_top_apps(start, end, limit)
    return {"apps": apps}


@router.post("/apps")
async def log_app(request: Request, body: LogAppBody) -> dict[str, Any]:
    svc = _service_or_503(request)
    try:
        app_log = await svc.log_app(
            session_id=body.session_id,
            app_name=body.app_name,
            started_at=body.started_at,
            duration_sec=body.duration_sec,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return {"app_log": app_log.to_dict()}
