"""Recurring tasks HTTP API — JWT-protected, per-user scoped."""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from mod_tasks.routes import get_current_user_id

from aura.recurring.service import RecurringService

router = APIRouter(prefix="/recurring", tags=["recurring"])
logger = logging.getLogger(__name__)


class CreateRecurringBody(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    frequency: str
    weekday: int | None = None
    day_of_month: int | None = None
    time: str | None = None
    description: str | None = None
    # None = use the user's profile defaults at materialize time.
    # [] = explicit "no extras" (occurrence still fires at the time).
    reminder_offsets: list[int] | None = None


class PatchRecurringBody(BaseModel):
    active: bool | None = None
    time: str | None = None
    weekday: int | None = None
    day_of_month: int | None = None
    title: str | None = None
    description: str | None = None
    reminder_offsets: list[int] | None = None

    model_config = {"extra": "forbid"}


def _service_or_503(request: Request) -> RecurringService:
    svc: Optional[RecurringService] = getattr(
        request.app.state, "recurring_service", None,
    )
    if svc is None:
        raise HTTPException(status_code=503, detail="recurring service não configurado")
    return svc


def _require_user(user_id: str | None) -> str:
    if user_id is None:
        raise HTTPException(status_code=401, detail="autenticação requerida")
    return user_id


@router.get("")
async def list_rules(
    request: Request,
    user_id: str | None = Depends(get_current_user_id),
) -> dict[str, Any]:
    uid = _require_user(user_id)
    svc = _service_or_503(request)
    rules = await svc.list_for_user(uid)
    return {"recurring": [r.to_dict() for r in rules]}


@router.post("")
async def create_rule(
    request: Request,
    body: CreateRecurringBody,
    user_id: str | None = Depends(get_current_user_id),
) -> dict[str, Any]:
    uid = _require_user(user_id)
    svc = _service_or_503(request)
    try:
        rule = await svc.create(
            user_id=uid,
            title=body.title,
            frequency=body.frequency,
            weekday=body.weekday,
            day_of_month=body.day_of_month,
            time=body.time,
            description=body.description,
            reminder_offsets=body.reminder_offsets,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return {"id": rule.id, "recurring": rule.to_dict()}


@router.patch("/{rule_id}")
async def patch_rule(
    request: Request,
    rule_id: str,
    body: PatchRecurringBody,
    user_id: str | None = Depends(get_current_user_id),
) -> dict[str, Any]:
    uid = _require_user(user_id)
    svc = _service_or_503(request)
    fields = body.model_dump(exclude_unset=True)
    try:
        rule = await svc.update(
            rule_id,
            uid,
            active=fields.get("active"),
            time=fields.get("time"),
            weekday=fields.get("weekday"),
            day_of_month=fields.get("day_of_month"),
            title=fields.get("title"),
            description=fields.get("description"),
            reminder_offsets=fields.get("reminder_offsets"),
            _time_provided="time" in fields,
            _weekday_provided="weekday" in fields,
            _day_of_month_provided="day_of_month" in fields,
            _description_provided="description" in fields,
            _reminder_offsets_provided="reminder_offsets" in fields,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    if rule is None:
        raise HTTPException(status_code=404, detail="regra não encontrada")
    return {"recurring": rule.to_dict()}


@router.delete("/{rule_id}")
async def delete_rule(
    request: Request,
    rule_id: str,
    user_id: str | None = Depends(get_current_user_id),
) -> dict[str, bool]:
    uid = _require_user(user_id)
    svc = _service_or_503(request)
    affected = await svc.delete(rule_id, uid)
    if not affected:
        raise HTTPException(status_code=404, detail="regra não encontrada")
    return {"ok": True}
