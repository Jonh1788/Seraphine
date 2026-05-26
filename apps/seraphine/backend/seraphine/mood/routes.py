"""Mood tracking HTTP API -- single-tenant, no auth required."""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from seraphine.mood.service import MoodService

router = APIRouter(prefix="/mood", tags=["mood"])
logger = logging.getLogger(__name__)


class CheckinBody(BaseModel):
    label: str = Field(min_length=1, max_length=50)
    valence: float | None = Field(default=None, ge=-1.0, le=1.0)
    arousal: float | None = Field(default=None, ge=0.0, le=1.0)

    model_config = {"extra": "forbid"}


def _service_or_503(request: Request) -> MoodService:
    svc: Optional[MoodService] = getattr(
        request.app.state, "mood_service", None,
    )
    if svc is None:
        raise HTTPException(status_code=503, detail="mood service not configured")
    return svc


@router.get("/today")
async def mood_today(request: Request) -> dict[str, Any]:
    svc = _service_or_503(request)
    return await svc.get_today()


@router.get("/trend")
async def mood_trend(
    request: Request,
    days: int = Query(default=14, ge=1, le=365),
) -> dict[str, Any]:
    svc = _service_or_503(request)
    try:
        return await svc.get_trend(days)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.post("/checkin")
async def mood_checkin(
    request: Request,
    body: CheckinBody,
) -> dict[str, Any]:
    svc = _service_or_503(request)
    log = await svc.checkin(
        body.label,
        valence=body.valence,
        arousal=body.arousal,
    )
    return {"log": log.to_dict()}
