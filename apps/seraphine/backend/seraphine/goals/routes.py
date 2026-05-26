"""Goals HTTP API -- single-tenant, no auth required."""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from seraphine.goals.service import GoalService

router = APIRouter(prefix="/goals", tags=["goals"])
logger = logging.getLogger(__name__)


# ------------------------------------------------------------------
# Request bodies
# ------------------------------------------------------------------

class CreateGoalBody(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    area: str
    timeframe: str
    description: str | None = None
    start_date: str | None = None
    end_date: str | None = None


class PatchGoalBody(BaseModel):
    title: str | None = None
    description: str | None = None
    area: str | None = None
    timeframe: str | None = None
    start_date: str | None = None
    end_date: str | None = None
    status: str | None = None

    model_config = {"extra": "forbid"}


class AddKeyResultBody(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    metric_type: str
    target_value: float
    unit: str | None = None
    auto_source: str | None = None


class PatchKeyResultBody(BaseModel):
    current_value: float | None = None
    target_value: float | None = None
    title: str | None = None

    model_config = {"extra": "forbid"}


class AddLinkBody(BaseModel):
    linked_type: str
    linked_id: str


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

def _service_or_503(request: Request) -> GoalService:
    svc: Optional[GoalService] = getattr(
        request.app.state, "goal_service", None,
    )
    if svc is None:
        raise HTTPException(status_code=503, detail="goal service not configured")
    return svc


# ------------------------------------------------------------------
# Routes
# ------------------------------------------------------------------

@router.get("/summary")
async def goal_summary(request: Request) -> dict[str, Any]:
    svc = _service_or_503(request)
    summary = await svc.get_summary()
    return summary.to_dict()


@router.get("")
async def list_goals(
    request: Request,
    area: str | None = None,
    status: str | None = None,
) -> dict[str, Any]:
    svc = _service_or_503(request)
    goals = await svc.list_goals(area=area, status=status)
    return {"goals": [g.to_dict() for g in goals]}


@router.post("")
async def create_goal(
    request: Request,
    body: CreateGoalBody,
) -> dict[str, Any]:
    svc = _service_or_503(request)
    try:
        goal = await svc.create_goal(
            title=body.title,
            area=body.area,
            timeframe=body.timeframe,
            description=body.description,
            start_date=body.start_date,
            end_date=body.end_date,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return {"id": goal.id, "goal": goal.to_dict()}


@router.get("/{goal_id}")
async def get_goal(
    request: Request,
    goal_id: str,
) -> dict[str, Any]:
    svc = _service_or_503(request)
    goal = await svc.get_goal(goal_id)
    if goal is None:
        raise HTTPException(status_code=404, detail="goal not found")
    return {"goal": goal.to_dict()}


@router.patch("/{goal_id}")
async def patch_goal(
    request: Request,
    goal_id: str,
    body: PatchGoalBody,
) -> dict[str, Any]:
    svc = _service_or_503(request)
    fields = body.model_dump(exclude_unset=True)
    try:
        goal = await svc.update_goal(goal_id, **fields)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    if goal is None:
        raise HTTPException(status_code=404, detail="goal not found")
    return {"goal": goal.to_dict()}


@router.delete("/{goal_id}")
async def delete_goal(
    request: Request,
    goal_id: str,
) -> dict[str, bool]:
    svc = _service_or_503(request)
    ok = await svc.delete_goal(goal_id)
    if not ok:
        raise HTTPException(status_code=404, detail="goal not found")
    return {"ok": True}


# ------------------------------------------------------------------
# Key Results
# ------------------------------------------------------------------

@router.post("/{goal_id}/key-results")
async def add_key_result(
    request: Request,
    goal_id: str,
    body: AddKeyResultBody,
) -> dict[str, Any]:
    svc = _service_or_503(request)
    try:
        kr = await svc.add_key_result(
            goal_id,
            title=body.title,
            metric_type=body.metric_type,
            target_value=body.target_value,
            unit=body.unit,
            auto_source=body.auto_source,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    if kr is None:
        raise HTTPException(status_code=404, detail="goal not found")
    return {"key_result": kr.to_dict()}


@router.patch("/{goal_id}/key-results/{kr_id}")
async def patch_key_result(
    request: Request,
    goal_id: str,
    kr_id: str,
    body: PatchKeyResultBody,
) -> dict[str, Any]:
    svc = _service_or_503(request)
    fields = body.model_dump(exclude_unset=True)
    try:
        kr = await svc.update_key_result(kr_id, **fields)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    if kr is None:
        raise HTTPException(status_code=404, detail="key result not found")
    return {"key_result": kr.to_dict()}


# ------------------------------------------------------------------
# Links
# ------------------------------------------------------------------

@router.post("/{goal_id}/links")
async def add_link(
    request: Request,
    goal_id: str,
    body: AddLinkBody,
) -> dict[str, Any]:
    svc = _service_or_503(request)
    try:
        link = await svc.add_link(goal_id, body.linked_type, body.linked_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    if link is None:
        raise HTTPException(status_code=404, detail="goal not found")
    return {"link": link.to_dict()}


@router.delete("/{goal_id}/links/{link_id}")
async def remove_link(
    request: Request,
    goal_id: str,
    link_id: str,
) -> dict[str, bool]:
    svc = _service_or_503(request)
    ok = await svc.remove_link(link_id)
    if not ok:
        raise HTTPException(status_code=404, detail="link not found")
    return {"ok": True}
