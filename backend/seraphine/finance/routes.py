"""REST router for the Finance module.

Exposes CRUD endpoints for financial entries, monthly summaries,
and recurring rules.  The FinanceService instance is read from
``request.app.state.finance_service`` (set during lifespan startup).
"""

from __future__ import annotations

import dataclasses
import logging
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from seraphine.finance.models import FinancialEntry
from seraphine.finance.service import FinanceService

router = APIRouter(tags=["finance"])
logger = logging.getLogger(__name__)


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

def _service_or_503(request: Request) -> FinanceService:
    svc: Optional[FinanceService] = getattr(
        request.app.state, "finance_service", None
    )
    if svc is None:
        raise HTTPException(
            status_code=503,
            detail="finance service not configured",
        )
    return svc


def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


# ------------------------------------------------------------------
# Request / response models
# ------------------------------------------------------------------

class EntryCreate(BaseModel):
    type: str
    amount: float
    category: str
    description: str
    date: str | None = None
    currency: str = "BRL"
    source: str = "manual"
    status: str = "confirmed"


class StatusUpdate(BaseModel):
    status: str


class BulkCreate(BaseModel):
    entries: list[EntryCreate]


# ------------------------------------------------------------------
# Endpoints
# ------------------------------------------------------------------

@router.get("/finance/summary")
async def finance_summary(
    request: Request,
    month: int | None = None,
    year: int | None = None,
) -> dict[str, Any]:
    """Monthly income/expense summary with per-category breakdown."""
    svc = _service_or_503(request)
    now = datetime.now(timezone.utc)
    m = month if month is not None else now.month
    y = year if year is not None else now.year
    try:
        return await svc.get_monthly_summary(m, y)
    except Exception as e:
        logger.exception("finance summary failed")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/finance/balance")
async def finance_balance(request: Request) -> dict[str, Any]:
    """Overall balance across all confirmed entries."""
    svc = _service_or_503(request)
    try:
        return await svc.get_overall_balance()
    except Exception as e:
        logger.exception("finance balance failed")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/finance/entries")
async def finance_list_entries(
    request: Request,
    month: int | None = None,
    year: int | None = None,
    category: str | None = None,
    type: str | None = None,
    status: str | None = None,
    limit: int = 100,
) -> dict[str, Any]:
    """List financial entries with optional filters."""
    svc = _service_or_503(request)
    try:
        entries = await svc.list_entries(
            month=month,
            year=year,
            category=category,
            type=type,
            status=status,
            limit=limit,
        )
        return {"entries": [dataclasses.asdict(e) for e in entries]}
    except Exception as e:
        logger.exception("finance list entries failed")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/finance/entries")
async def finance_add_entry(request: Request, body: EntryCreate) -> dict[str, Any]:
    """Create a single financial entry."""
    svc = _service_or_503(request)
    entry = FinancialEntry(
        id=None,
        type=body.type,
        amount=body.amount,
        currency=body.currency,
        category=body.category,
        description=body.description,
        date=body.date or _today(),
        source=body.source,
        status=body.status,
    )
    try:
        entry_id = await svc.add_entry(entry)
        return {"id": entry_id, "ok": True}
    except Exception as e:
        logger.exception("finance add entry failed")
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/finance/entries/{entry_id}/status")
async def finance_update_status(
    request: Request,
    entry_id: int,
    body: StatusUpdate,
) -> dict[str, bool]:
    """Update the status of a financial entry."""
    svc = _service_or_503(request)
    if body.status not in ("confirmed", "pending_review"):
        raise HTTPException(
            status_code=422,
            detail="status must be 'confirmed' or 'pending_review'",
        )
    try:
        await svc.update_entry_status(entry_id, body.status)
        return {"ok": True}
    except Exception as e:
        logger.exception("finance update status failed")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/finance/entries/{entry_id}")
async def finance_delete_entry(
    request: Request,
    entry_id: int,
) -> dict[str, bool]:
    """Delete a financial entry."""
    svc = _service_or_503(request)
    try:
        await svc.delete_entry(entry_id)
        return {"ok": True}
    except Exception as e:
        logger.exception("finance delete entry failed")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/finance/recurring")
async def finance_list_recurring(request: Request) -> dict[str, Any]:
    """List active recurring rules."""
    svc = _service_or_503(request)
    try:
        rules = await svc.list_recurring(active_only=True)
        return {"rules": [dataclasses.asdict(r) for r in rules]}
    except Exception as e:
        logger.exception("finance list recurring failed")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/finance/entries/bulk")
async def finance_bulk_create(
    request: Request,
    body: BulkCreate,
) -> dict[str, Any]:
    """Create multiple financial entries at once."""
    svc = _service_or_503(request)
    ids: list[int] = []
    try:
        for item in body.entries:
            entry = FinancialEntry(
                id=None,
                type=item.type,
                amount=item.amount,
                currency=item.currency,
                category=item.category,
                description=item.description,
                date=item.date or _today(),
                source=item.source,
                status=item.status,
            )
            entry_id = await svc.add_entry(entry)
            ids.append(entry_id)
        return {"ids": ids, "count": len(ids)}
    except Exception as e:
        logger.exception("finance bulk create failed")
        raise HTTPException(status_code=500, detail=str(e))
