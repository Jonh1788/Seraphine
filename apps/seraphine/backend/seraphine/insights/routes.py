"""Insights HTTP API -- single-tenant, no auth required."""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request

from seraphine.insights.service import InsightEngine
from seraphine.insights.weekly import (
    generate_weekly_report,
    get_or_generate_current_week,
)

router = APIRouter(prefix="/insights", tags=["insights"])
logger = logging.getLogger(__name__)


def _service_or_503(request: Request) -> InsightEngine:
    svc: Optional[InsightEngine] = getattr(
        request.app.state, "insight_engine", None,
    )
    if svc is None:
        raise HTTPException(status_code=503, detail="insight engine not configured")
    return svc


@router.get("")
async def list_insights(request: Request) -> dict[str, Any]:
    svc = _service_or_503(request)
    items = await svc.list_active()
    # On-demand generation when the table is empty (first boot, fresh DB).
    if not items:
        try:
            await svc.refresh_all()
        except Exception:
            logger.exception("on-demand refresh_all failed")
        items = await svc.list_active()
    return {"insights": [i.to_dict() for i in items]}


@router.post("/refresh")
async def refresh_insights(request: Request) -> dict[str, Any]:
    svc = _service_or_503(request)
    try:
        generated = await svc.refresh_all()
    except Exception as exc:
        logger.exception("refresh_all failed")
        raise HTTPException(status_code=500, detail=f"refresh failed: {exc}")
    items = await svc.list_active()
    return {
        "generated": len(generated),
        "insights": [i.to_dict() for i in items],
    }


@router.post("/{insight_id}/dismiss")
async def dismiss_insight(
    request: Request, insight_id: str,
) -> dict[str, bool]:
    svc = _service_or_503(request)
    ok = await svc.dismiss(insight_id)
    if not ok:
        raise HTTPException(status_code=404, detail="insight not found")
    return {"ok": True}


@router.get("/weekly-report")
async def weekly_report(request: Request) -> dict[str, Any]:
    svc = _service_or_503(request)
    store = getattr(request.app.state, "store", None)
    if store is None:
        raise HTTPException(status_code=503, detail="store not configured")
    report = await get_or_generate_current_week(store, svc)
    return {"report": report.to_dict()}


@router.post("/weekly-report/generate")
async def weekly_report_generate(request: Request) -> dict[str, Any]:
    svc = _service_or_503(request)
    store = getattr(request.app.state, "store", None)
    if store is None:
        raise HTTPException(status_code=503, detail="store not configured")
    report = await generate_weekly_report(store, svc)
    return {"report": report.to_dict()}
