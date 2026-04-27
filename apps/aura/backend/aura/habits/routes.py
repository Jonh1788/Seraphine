"""Habits routes — CRUD + toggle + today overview for the UI."""

from __future__ import annotations

from dataclasses import asdict
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from mod_tasks.routes import get_current_user_id

from aura.habits.service import HabitsService

router = APIRouter(prefix="/habits", tags=["habits"])


def _service_or_503(request: Request) -> HabitsService:
    svc = getattr(request.app.state, "habits_service", None)
    if svc is None:
        raise HTTPException(status_code=503, detail="habits service não configurado")
    return svc


def _require_user(user_id: str | None) -> str:
    if user_id is None:
        raise HTTPException(status_code=401, detail="autenticação requerida")
    return user_id


class CreateHabitBody(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    color: str = Field("emerald", max_length=20)
    target_per_week: int = Field(7, ge=1, le=7)


class UpdateHabitBody(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=80)
    color: str | None = Field(None, max_length=20)
    target_per_week: int | None = Field(None, ge=1, le=7)
    archived: bool | None = None


def _habit_dict(h: Any) -> dict:
    d = asdict(h)
    return d


@router.get("/today")
async def get_today(
    request: Request,
    user_id: str | None = Depends(get_current_user_id),
) -> dict:
    uid = _require_user(user_id)
    svc = _service_or_503(request)
    overview = await svc.today_overview(uid)
    return {
        **overview,
        "habits": [_habit_dict(h) for h in overview["habits"]],
    }


@router.get("")
async def list_habits(
    request: Request,
    include_archived: bool = False,
    user_id: str | None = Depends(get_current_user_id),
) -> dict:
    uid = _require_user(user_id)
    svc = _service_or_503(request)
    habits = await svc.list_for_user(uid, include_archived=include_archived)
    return {"habits": [_habit_dict(h) for h in habits]}


@router.post("")
async def create_habit(
    body: CreateHabitBody,
    request: Request,
    user_id: str | None = Depends(get_current_user_id),
) -> dict:
    uid = _require_user(user_id)
    svc = _service_or_503(request)
    habit = await svc.create(
        user_id=uid,
        name=body.name,
        color=body.color,
        target_per_week=body.target_per_week,
    )
    return _habit_dict(habit)


@router.patch("/{habit_id}")
async def update_habit(
    habit_id: str,
    body: UpdateHabitBody,
    request: Request,
    user_id: str | None = Depends(get_current_user_id),
) -> dict:
    uid = _require_user(user_id)
    svc = _service_or_503(request)
    updated = await svc.update(
        habit_id, uid,
        name=body.name,
        color=body.color,
        target_per_week=body.target_per_week,
        archived=body.archived,
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="hábito não encontrado")
    return _habit_dict(updated)


@router.delete("/{habit_id}")
async def delete_habit(
    habit_id: str,
    request: Request,
    user_id: str | None = Depends(get_current_user_id),
) -> dict:
    uid = _require_user(user_id)
    svc = _service_or_503(request)
    rows = await svc.delete(habit_id, uid)
    if rows == 0:
        raise HTTPException(status_code=404, detail="hábito não encontrado")
    return {"ok": True}


@router.post("/{habit_id}/toggle")
async def toggle_habit(
    habit_id: str,
    request: Request,
    user_id: str | None = Depends(get_current_user_id),
) -> dict:
    uid = _require_user(user_id)
    svc = _service_or_503(request)
    new_state = await svc.toggle_log(habit_id, uid)
    return {"done": new_state}
