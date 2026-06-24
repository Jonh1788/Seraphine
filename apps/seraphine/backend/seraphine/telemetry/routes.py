from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request

router = APIRouter(prefix="/telemetry", tags=["telemetry"])


@router.get("/summary")
async def telemetry_summary(request: Request, days: int = 7) -> dict[str, Any]:
    svc = getattr(request.app.state, "telemetry_service", None)
    if svc is None:
        return {
            "days": days,
            "total": {"input_tokens": 0, "output_tokens": 0, "cost_usd": 0, "calls": 0},
            "by_model": [],
            "by_feature": [],
            "by_backend": [],
        }
    return await svc.summary(days=days)
