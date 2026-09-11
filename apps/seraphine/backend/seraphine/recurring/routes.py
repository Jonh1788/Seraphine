"""Recurring tasks HTTP API -- single-tenant, no auth required."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from seraphine.recurring.routine_service import RoutineService
from seraphine.recurring.service import RecurringService

router = APIRouter(prefix="/recurring", tags=["recurring"])
logger = logging.getLogger(__name__)


class CreateRecurringBody(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    frequency: str
    weekday: int | None = None
    day_of_month: int | None = None
    time: str | None = None
    end_date: str | None = None
    description: str | None = None
    # "at_time" | "1h_before" | "" (desliga). Omitido = padrão do serviço
    # (at_time quando há hora). `1d_before` não vale para regra recorrente.
    remind: str | None = None


class PatchRecurringBody(BaseModel):
    active: bool | None = None
    time: str | None = None
    weekday: int | None = None
    day_of_month: int | None = None
    frequency: str | None = None
    end_date: str | None = None
    title: str | None = None
    description: str | None = None
    remind: str | None = None

    model_config = {"extra": "forbid"}


def _service_or_503(request: Request) -> RecurringService:
    svc: Optional[RecurringService] = getattr(
        request.app.state, "recurring_service", None,
    )
    if svc is None:
        raise HTTPException(status_code=503, detail="recurring service not configured")
    return svc


def _routine_service_or_503(request: Request) -> RoutineService:
    svc: Optional[RoutineService] = getattr(
        request.app.state, "routine_service", None,
    )
    if svc is None:
        raise HTTPException(status_code=503, detail="routine service not configured")
    return svc


# ----------------------------------------------------------------------
# Routines: prompt launchers (distinct from recurring task rules above).
# Mounted under /recurring/routines so they ride the existing proxy.
# Declared before the /{rule_id} routes so the static segment wins.
# ----------------------------------------------------------------------


class CreateRoutineBody(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    prompt: str = Field(default="", max_length=4000)
    detail: str = Field(default="", max_length=400)
    kind: str = "manual"
    trigger: str | None = None
    enabled: bool = True
    icon: str | None = None
    icon_bg: str | None = None
    icon_color: str | None = None
    job_name: str | None = None


class PatchRoutineBody(BaseModel):
    enabled: bool | None = None
    name: str | None = None
    detail: str | None = None
    trigger: str | None = None
    prompt: str | None = None
    kind: str | None = None

    model_config = {"extra": "forbid"}


@router.get("/routines")
async def list_routines(request: Request) -> dict[str, Any]:
    svc = _routine_service_or_503(request)
    routines = await svc.list_all()
    return {"routines": [r.to_dict() for r in routines]}


@router.post("/routines")
async def create_routine(
    request: Request,
    body: CreateRoutineBody,
) -> dict[str, Any]:
    svc = _routine_service_or_503(request)
    try:
        routine = await svc.create(
            name=body.name,
            prompt=body.prompt,
            detail=body.detail,
            kind=body.kind,
            trigger=body.trigger,
            enabled=body.enabled,
            icon=body.icon,
            icon_bg=body.icon_bg,
            icon_color=body.icon_color,
            job_name=body.job_name,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return {"id": routine.id, "routine": routine.to_dict()}


@router.patch("/routines/{routine_id}")
async def patch_routine(
    request: Request,
    routine_id: str,
    body: PatchRoutineBody,
) -> dict[str, Any]:
    svc = _routine_service_or_503(request)
    fields = body.model_dump(exclude_unset=True)
    try:
        routine = await svc.update(
            routine_id,
            enabled=fields.get("enabled"),
            name=fields.get("name"),
            detail=fields.get("detail"),
            trigger=fields.get("trigger"),
            prompt=fields.get("prompt"),
            kind=fields.get("kind"),
            _trigger_provided="trigger" in fields,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    if routine is None:
        raise HTTPException(status_code=404, detail="routine not found")
    return {"routine": routine.to_dict()}


@router.post("/routines/{routine_id}/run")
async def run_routine(
    request: Request,
    routine_id: str,
) -> dict[str, Any]:
    """Resolve a routine's prompt for launching into the chat composer.

    The actual send happens client-side (AppLayout pushes the prompt into the
    composer with auto-send); this endpoint is the server-side source of truth
    for the prompt text so the catalog can evolve without a frontend redeploy.
    """
    svc = _routine_service_or_503(request)
    routine = await svc.get(routine_id)
    if routine is None:
        raise HTTPException(status_code=404, detail="routine not found")
    return {"id": routine.id, "prompt": routine.prompt}


@router.delete("/routines/{routine_id}")
async def delete_routine(
    request: Request,
    routine_id: str,
) -> dict[str, bool]:
    svc = _routine_service_or_503(request)
    affected = await svc.delete(routine_id)
    if not affected:
        # Either not found, or a builtin routine which is protected.
        raise HTTPException(
            status_code=404, detail="routine not found or not deletable",
        )
    return {"ok": True}


@router.get("")
async def list_rules(request: Request) -> dict[str, Any]:
    svc = _service_or_503(request)
    rules = await svc.list_all()
    return {"recurring": [r.to_dict() for r in rules]}


@router.post("")
async def create_rule(
    request: Request,
    body: CreateRecurringBody,
) -> dict[str, Any]:
    svc = _service_or_503(request)
    try:
        rule = await svc.create(
            title=body.title,
            frequency=body.frequency,
            weekday=body.weekday,
            day_of_month=body.day_of_month,
            time=body.time,
            description=body.description,
            end_date=body.end_date,
            remind=body.remind,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return {"id": rule.id, "recurring": rule.to_dict()}


@router.post("/{rule_id}/today/complete")
async def complete_today(request: Request, rule_id: str) -> dict[str, Any]:
    """Conclui a ocorrência de hoje. Alvo do botão "Concluir" da
    notificação nativa do iOS, que carrega o rule_id e não o task_id."""
    svc = _service_or_503(request)
    task_id = await svc.complete_today(rule_id, datetime.now(timezone.utc))
    if task_id is None:
        raise HTTPException(
            status_code=404, detail="no occurrence for this rule today",
        )
    return {"ok": True, "task_id": task_id}


@router.patch("/{rule_id}")
async def patch_rule(
    request: Request,
    rule_id: str,
    body: PatchRecurringBody,
) -> dict[str, Any]:
    svc = _service_or_503(request)
    fields = body.model_dump(exclude_unset=True)
    try:
        rule = await svc.update(
            rule_id,
            active=fields.get("active"),
            time=fields.get("time"),
            weekday=fields.get("weekday"),
            day_of_month=fields.get("day_of_month"),
            frequency=fields.get("frequency"),
            end_date=fields.get("end_date"),
            title=fields.get("title"),
            description=fields.get("description"),
            remind=fields.get("remind"),
            _remind_provided="remind" in fields,
            _time_provided="time" in fields,
            _weekday_provided="weekday" in fields,
            _day_of_month_provided="day_of_month" in fields,
            _end_date_provided="end_date" in fields,
            _description_provided="description" in fields,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    if rule is None:
        raise HTTPException(status_code=404, detail="rule not found")
    return {"recurring": rule.to_dict()}


@router.delete("/{rule_id}")
async def delete_rule(
    request: Request,
    rule_id: str,
) -> dict[str, bool]:
    svc = _service_or_503(request)
    affected = await svc.delete(rule_id)
    if not affected:
        raise HTTPException(status_code=404, detail="rule not found")
    return {"ok": True}
