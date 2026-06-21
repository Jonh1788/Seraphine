"""Insights HTTP API -- single-tenant, no auth required."""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Query, Request

from seraphine.insights.correlations import compute_correlations
from seraphine.insights.service import InsightEngine
from seraphine.insights.weekly import (
    generate_weekly_report,
    get_or_generate_current_week,
)

router = APIRouter(prefix="/insights", tags=["insights"])
logger = logging.getLogger(__name__)

_SP_TZ = ZoneInfo("America/Sao_Paulo")
_DEFAULT_CATEGORY = "Foco"

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


@router.get("/time-by-category")
async def time_by_category(
    request: Request,
    period: str = Query("week", description="'week' (last 7d) or 'month' (MTD)"),
) -> dict[str, Any]:
    """Sum focus minutes by category -- backs 'Onde foi seu tempo'.

    Only completed-or-not 'work' sessions count toward focus time. Reads
    ``focus_sessions`` directly so it works regardless of which service is
    wired; gracefully degrades to an empty list when the table or the
    ``category`` column is absent (very old DBs).
    """
    if period not in ("week", "month"):
        raise HTTPException(status_code=422, detail="period must be 'week' or 'month'")
    store = getattr(request.app.state, "store", None)
    if store is None:
        raise HTTPException(status_code=503, detail="store not configured")

    today = datetime.now(_SP_TZ).date()
    if period == "month":
        start_date = today.replace(day=1)
    else:
        start_date = today - timedelta(days=6)

    start_utc = datetime(
        start_date.year, start_date.month, start_date.day,
        tzinfo=_SP_TZ,
    ).astimezone(timezone.utc).isoformat()
    end_utc = datetime(
        today.year, today.month, today.day,
        hour=23, minute=59, second=59,
        tzinfo=_SP_TZ,
    ).astimezone(timezone.utc).isoformat()

    def _work() -> list[dict[str, Any]]:
        with store._connect() as conn:
            tbl = conn.execute(
                "SELECT name FROM sqlite_master"
                " WHERE type='table' AND name='focus_sessions'",
            ).fetchone()
            if tbl is None:
                return []
            cols = {
                row[1]
                for row in conn.execute(
                    "PRAGMA table_info(focus_sessions)",
                ).fetchall()
            }
            cat_expr = "category" if "category" in cols else f"'{_DEFAULT_CATEGORY}'"
            rows = conn.execute(
                f"SELECT COALESCE(NULLIF(TRIM({cat_expr}), ''), '{_DEFAULT_CATEGORY}')"
                "   AS cat,"
                "   SUM(duration_sec) AS total_sec,"
                "   COUNT(*) AS sessions"
                " FROM focus_sessions"
                " WHERE type = 'work' AND started_at BETWEEN ? AND ?"
                " GROUP BY cat"
                " ORDER BY total_sec DESC",
                (start_utc, end_utc),
            ).fetchall()
        return [
            {
                "category": str(r[0]),
                "focus_min": int(r[1] or 0) // 60,
                "sessions": int(r[2] or 0),
            }
            for r in rows
        ]

    try:
        items = await asyncio.to_thread(_work)
    except Exception as exc:
        logger.exception("time_by_category failed")
        raise HTTPException(status_code=500, detail=f"aggregation failed: {exc}")

    total_min = sum(i["focus_min"] for i in items)
    for i in items:
        i["pct"] = round(i["focus_min"] / total_min * 100, 1) if total_min > 0 else 0.0

    return {"period": period, "total_focus_min": total_min, "categories": items}
