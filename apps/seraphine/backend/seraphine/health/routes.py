"""Apple Health HTTP API -- single-tenant, no auth required.

Endpoints:
- POST /health/snapshot    -- ingest a daily snapshot from the Tauri bridge
- GET  /health/today       -- today's snapshot (or empty)
- GET  /health/recent      -- last N days
- GET  /health/trend       -- metric trend points
- GET  /health/weekly      -- aggregated weekly report
- DELETE /health/{date}    -- remove a snapshot (debug/maintenance)
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from seraphine.health.service import HealthService

router = APIRouter(prefix="/health", tags=["health"])
logger = logging.getLogger(__name__)


class WorkoutBody(BaseModel):
    type: str = Field(min_length=1, max_length=64)
    start: str
    end: str
    duration_min: float = Field(ge=0)
    calories: float | None = Field(default=None, ge=0)
    distance_km: float | None = Field(default=None, ge=0)

    model_config = {"extra": "forbid"}


class SnapshotBody(BaseModel):
    date: str
    steps: int = Field(default=0, ge=0)
    active_calories: float = Field(default=0.0, ge=0)
    resting_heart_rate: float | None = Field(default=None, ge=20, le=220)
    sleep_minutes: float | None = Field(default=None, ge=0, le=60 * 24)
    sleep_quality: str | None = Field(default=None, max_length=16)
    weight_kg: float | None = Field(default=None, gt=0, le=500)
    workouts: list[WorkoutBody] = Field(default_factory=list)

    model_config = {"extra": "forbid"}


# NOTE: /health is also the Seraphine liveness probe path used in
# bootstrap.py. Keep this router mounted so the module-specific routes
# (/health/today, /health/snapshot, etc.) don't collide with the bare
# /health endpoint declared in main.py via FastAPI.get("/health").


def _service_or_503(request: Request) -> HealthService:
    svc: Optional[HealthService] = getattr(
        request.app.state, "health_service", None,
    )
    if svc is None:
        raise HTTPException(status_code=503, detail="health service not configured")
    return svc


@router.post("/snapshot")
async def post_snapshot(
    request: Request,
    body: SnapshotBody,
) -> dict[str, Any]:
    svc = _service_or_503(request)
    try:
        snapshot = await svc.store_snapshot(
            date=body.date,
            steps=body.steps,
            active_calories=body.active_calories,
            resting_heart_rate=body.resting_heart_rate,
            sleep_minutes=body.sleep_minutes,
            sleep_quality=body.sleep_quality,
            weight_kg=body.weight_kg,
            workouts=[w.model_dump() for w in body.workouts],
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return {"snapshot": snapshot.to_dict()}


@router.get("/today")
async def get_today(request: Request) -> dict[str, Any]:
    svc = _service_or_503(request)
    snapshot = await svc.get_today()
    return {"snapshot": snapshot.to_dict() if snapshot else None}


@router.get("/recent")
async def get_recent(
    request: Request,
    days: int = Query(default=7, ge=1, le=365),
) -> dict[str, Any]:
    svc = _service_or_503(request)
    try:
        snapshots = await svc.get_recent(days=days)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return {"snapshots": [s.to_dict() for s in snapshots]}


@router.get("/trend")
async def get_trend(
    request: Request,
    metric: str = Query(..., min_length=1),
    days: int = Query(default=14, ge=1, le=365),
) -> dict[str, Any]:
    svc = _service_or_503(request)
    try:
        points = await svc.get_trend(metric=metric, days=days)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return {
        "metric": metric,
        "days": days,
        "points": [p.to_dict() for p in points],
    }


@router.get("/weekly")
async def get_weekly(request: Request) -> dict[str, Any]:
    svc = _service_or_503(request)
    return await svc.get_weekly_report()


@router.delete("/{iso_date}")
async def delete_snapshot(
    request: Request,
    iso_date: str,
) -> dict[str, bool]:
    svc = _service_or_503(request)
    try:
        ok = await svc.delete_snapshot(iso_date)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    if not ok:
        raise HTTPException(status_code=404, detail="snapshot not found")
    return {"ok": True}
