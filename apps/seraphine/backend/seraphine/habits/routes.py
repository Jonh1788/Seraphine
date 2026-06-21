"""Habits HTTP API -- single-tenant, no auth required."""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from seraphine.habits.service import HabitService

router = APIRouter(prefix="/habits", tags=["habits"])
logger = logging.getLogger(__name__)


class CreateHabitBody(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    frequency: str
    icon: str | None = None
    color: str | None = None
    target_days: list[int] | None = None
    description: str | None = None


class PatchHabitBody(BaseModel):
    title: str | None = None
    icon: str | None = None
    color: str | None = None
    frequency: str | None = None
    target_days: list[int] | None = None
    description: str | None = None
    active: bool | None = None

    model_config = {"extra": "forbid"}


class ToggleBody(BaseModel):
    date: str | None = None

    model_config = {"extra": "forbid"}


def _service_or_503(request: Request) -> HabitService:
    svc: Optional[HabitService] = getattr(
        request.app.state, "habit_service", None,
    )
    if svc is None:
        raise HTTPException(status_code=503, detail="habit service not configured")
    return svc


@router.get("")
async def list_habits(request: Request) -> dict[str, Any]:
    svc = _service_or_503(request)
    return {"habits": await svc.list_with_today_status()}


@router.get("/today")
async def today_progress(request: Request) -> dict[str, Any]:
    svc = _service_or_503(request)
    return await svc.get_today_progress()


@router.get("/calendar")
async def habits_calendar_batch(
    request: Request,
    month: int,
    year: int,
) -> dict[str, Any]:
    """Calendar logs for all active habits in one fetch (weekly grid)."""
    svc = _service_or_503(request)
    try:
        grouped = await svc.get_calendar_batch(month, year)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return {
        "logs": {
            habit_id: [log.to_dict() for log in logs]
            for habit_id, logs in grouped.items()
        }
    }


@router.post("")
async def create_habit(
    request: Request,
    body: CreateHabitBody,
) -> dict[str, Any]:
    svc = _service_or_503(request)
    kwargs: dict[str, Any] = {
        "title": body.title,
        "frequency": body.frequency,
        "target_days": body.target_days,
        "description": body.description,
    }
    if body.icon is not None:
        kwargs["icon"] = body.icon
    if body.color is not None:
        kwargs["color"] = body.color
    try:
        habit = await svc.create(**kwargs)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return {"id": habit.id, "habit": habit.to_dict()}


@router.patch("/{habit_id}")
async def patch_habit(
    request: Request,
    habit_id: str,
    body: PatchHabitBody,
) -> dict[str, Any]:
    svc = _service_or_503(request)
    fields = body.model_dump(exclude_unset=True)
    try:
        habit = await svc.update(habit_id, **fields)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    if habit is None:
        raise HTTPException(status_code=404, detail="habit not found")
    return {"habit": habit.to_dict()}


@router.delete("/{habit_id}")
async def delete_habit(
    request: Request,
    habit_id: str,
) -> dict[str, bool]:
    svc = _service_or_503(request)
    affected = await svc.delete(habit_id)
    if not affected:
        raise HTTPException(status_code=404, detail="habit not found")
    return {"ok": True}


@router.post("/{habit_id}/toggle")
async def toggle_habit(
    request: Request,
    habit_id: str,
    body: ToggleBody | None = None,
) -> dict[str, Any]:
    svc = _service_or_503(request)
    target_date = body.date if body is not None else None
    try:
        result = await svc.toggle(habit_id, target_date=target_date)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    if result is None:
        raise HTTPException(status_code=404, detail="habit not found")
    return result


@router.get("/{habit_id}/streaks")
async def habit_streaks(
    request: Request,
    habit_id: str,
) -> dict[str, Any]:
    svc = _service_or_503(request)
    habit = await svc.get(habit_id)
    if habit is None:
        raise HTTPException(status_code=404, detail="habit not found")
    return await svc.get_streaks(habit_id)


@router.get("/{habit_id}/calendar")
async def habit_calendar(
    request: Request,
    habit_id: str,
    month: int,
    year: int,
) -> dict[str, Any]:
    svc = _service_or_503(request)
    habit = await svc.get(habit_id)
    if habit is None:
        raise HTTPException(status_code=404, detail="habit not found")
    try:
        logs = await svc.get_calendar(habit_id, month, year)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return {"logs": [log.to_dict() for log in logs]}
