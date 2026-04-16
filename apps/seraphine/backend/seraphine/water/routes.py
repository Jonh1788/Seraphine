"""Water tracking HTTP API -- single-tenant, no auth required."""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from seraphine.water.service import WaterService

router = APIRouter(prefix="/water", tags=["water"])
logger = logging.getLogger(__name__)


class CreateProfileBody(BaseModel):
    weight_kg: float = Field(gt=0)
    activity_level: str
    height_cm: float | None = Field(default=None, gt=0)
    reminder_enabled: bool | None = None
    reminder_start: str | None = None
    reminder_end: str | None = None
    reminder_interval_hours: int | None = Field(default=None, ge=1, le=12)

    model_config = {"extra": "forbid"}


class IntakeBody(BaseModel):
    amount_ml: int = Field(gt=0, le=5000)

    model_config = {"extra": "forbid"}


def _service_or_503(request: Request) -> WaterService:
    svc: Optional[WaterService] = getattr(
        request.app.state, "water_service", None,
    )
    if svc is None:
        raise HTTPException(status_code=503, detail="water service not configured")
    return svc


@router.get("/profile")
async def get_profile(request: Request) -> dict[str, Any]:
    svc = _service_or_503(request)
    profile = await svc.get_profile()
    if profile is None:
        raise HTTPException(status_code=404, detail="water profile not configured")
    return {"profile": profile.to_dict()}


@router.put("/profile")
async def put_profile(
    request: Request,
    body: CreateProfileBody,
) -> dict[str, Any]:
    svc = _service_or_503(request)
    try:
        profile = await svc.set_profile(
            weight_kg=body.weight_kg,
            activity_level=body.activity_level,
            height_cm=body.height_cm,
            reminder_enabled=body.reminder_enabled,
            reminder_start=body.reminder_start,
            reminder_end=body.reminder_end,
            reminder_interval_hours=body.reminder_interval_hours,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return {"profile": profile.to_dict()}


@router.post("/intake")
async def post_intake(
    request: Request,
    body: IntakeBody,
) -> dict[str, Any]:
    svc = _service_or_503(request)
    try:
        result = await svc.add_intake(body.amount_ml)
    except LookupError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return result


@router.get("/today")
async def today(request: Request) -> dict[str, Any]:
    svc = _service_or_503(request)
    return await svc.get_today()


@router.get("/history")
async def history(
    request: Request,
    days: int = Query(default=7, ge=1, le=365),
) -> dict[str, Any]:
    svc = _service_or_503(request)
    try:
        items = await svc.get_history(days)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return {"history": items}


@router.delete("/logs/{log_id}")
async def delete_log(
    request: Request,
    log_id: int,
) -> dict[str, bool]:
    svc = _service_or_503(request)
    ok = await svc.delete_log(log_id)
    if not ok:
        raise HTTPException(status_code=404, detail="water log not found")
    return {"ok": True}
