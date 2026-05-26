"""Insights HTTP API -- single-tenant, no auth required."""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query, Request

from seraphine.insights.correlations import compute_correlations
from seraphine.insights.service import InsightEngine
from seraphine.insights.weekly import (
    generate_weekly_report,
    get_or_generate_current_week,
)

router = APIRouter(prefix="/insights", tags=["insights"])
logger = logging.getLogger(__name__)

_VALID_TYPES = frozenset({
    "finance", "tasks", "habits", "productivity", "health", "cross_domain",
})


def _service_or_503(request: Request) -> InsightEngine:
    svc: Optional[InsightEngine] = getattr(
        request.app.state, "insight_engine", None,
    )
    if svc is None:
        raise HTTPException(status_code=503, detail="insight engine not configured")
    return svc


@router.get("")
async def list_insights(
    request: Request,
    type: Optional[str] = Query(None, description="Filter by insight type"),
) -> dict[str, Any]:
    svc = _service_or_503(request)
    if type is not None and type not in _VALID_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"invalid type: {type!r} (valid: {', '.join(sorted(_VALID_TYPES))})",
        )
    items = await svc.list_active(type_filter=type)
    # On-demand generation when the table is empty (first boot, fresh DB).
    if not items and type is None:
        try:
            await svc.refresh_all()
        except Exception:
            logger.exception("on-demand refresh_all failed")
        items = await svc.list_active(type_filter=type)
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


@router.get("/correlations")
async def list_correlations(
    request: Request,
    days: int = Query(30, ge=7, le=90, description="Lookback window in days"),
) -> dict[str, Any]:
    """Return raw correlation data for all significant cross-domain pairs."""
    _service_or_503(request)  # ensure engine is up
    store = getattr(request.app.state, "store", None)
    if store is None:
        raise HTTPException(status_code=503, detail="store not configured")
    try:
        corrs = await compute_correlations(store, days=days)
    except Exception as exc:
        logger.exception("compute_correlations failed")
        raise HTTPException(
            status_code=500, detail=f"correlation computation failed: {exc}",
        )
    return {
        "days": days,
        "correlations": [c.to_dict() for c in corrs],
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
