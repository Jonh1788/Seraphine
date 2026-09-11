"""REST router for the Finance module.

Multi-tenant aware: every endpoint depends on ``get_current_user_id``
(re-exported from mod_tasks so apps override one symbol for both
modules). Seraphine uses the default (returns None ⇒ all rows). Aura
overrides to validate JWT.
"""

from __future__ import annotations

import dataclasses
import logging
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

# Re-use the same dep symbol that mod-tasks defines so apps only need
# one dependency_overrides entry to scope every shared module.
from mod_tasks.routes import get_current_user_id

from mod_finance.models import FinancialEntry
from mod_finance.service import FinanceService

router = APIRouter(tags=["finance"])
logger = logging.getLogger(__name__)


def _service_or_503(request: Request) -> FinanceService:
    svc: Optional[FinanceService] = getattr(
        request.app.state, "finance_service", None,
    )
    if svc is None:
        raise HTTPException(
            status_code=503, detail="finance service not configured",
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
    user_id: str | None = Depends(get_current_user_id),
) -> dict[str, Any]:
    svc = _service_or_503(request)
    now = datetime.now(timezone.utc)
    m = month if month is not None else now.month
    y = year if year is not None else now.year
    try:
        return await svc.get_monthly_summary(m, y, user_id=user_id)
    except Exception as e:
        logger.exception("finance summary failed")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/finance/balance")
async def finance_balance(
    request: Request,
    user_id: str | None = Depends(get_current_user_id),
) -> dict[str, Any]:
    svc = _service_or_503(request)
    try:
        return await svc.get_overall_balance(user_id=user_id)
    except Exception as e:
        logger.exception("finance balance failed")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/finance/entries")
async def finance_list_entries(
    request: Request,
    month: int | None = None,
    year: int | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    category: str | None = None,
    type: str | None = None,
    status: str | None = None,
    limit: int = 100,
    user_id: str | None = Depends(get_current_user_id),
) -> dict[str, Any]:
    """`month`/`year` recortam pelo MÊS DE CAIXA; `date_from`/`date_to`
    (ISO, extremos incluídos) recortam pela DATA DA COMPRA.

    Quem desenha um período — o calendário, uma semana — pergunta pela data
    da compra: pedir o mês de caixa e depois posicionar por `date` faria a
    compra no cartão sumir do dia em que ela aconteceu.
    """
    svc = _service_or_503(request)
    try:
        entries = await svc.list_entries(
            month=month, year=year, date_from=date_from, date_to=date_to,
            category=category, type=type, status=status, limit=limit,
            user_id=user_id,
        )
        return {"entries": [dataclasses.asdict(e) for e in entries]}
    except ValueError as e:
        # Data fora do ISO é pedido malformado, não erro do servidor: um 500
        # aqui mandaria o cliente tentar de novo com a mesma data para sempre.
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        logger.exception("finance list entries failed")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/finance/entries")
async def finance_add_entry(
    request: Request,
    body: EntryCreate,
    user_id: str | None = Depends(get_current_user_id),
) -> dict[str, Any]:
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
        entry_id = await svc.add_entry(entry, user_id=user_id)
        return {"id": entry_id, "ok": True}
    except Exception as e:
        logger.exception("finance add entry failed")
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/finance/entries/{entry_id}/status")
async def finance_update_status(
    request: Request,
    entry_id: int,
    body: StatusUpdate,
    user_id: str | None = Depends(get_current_user_id),
) -> dict[str, bool]:
    svc = _service_or_503(request)
    if body.status not in ("confirmed", "pending_review"):
        raise HTTPException(
            status_code=422,
            detail="status must be 'confirmed' or 'pending_review'",
        )
    try:
        affected = await svc.update_entry_status(entry_id, body.status, user_id=user_id)
    except Exception as e:
        logger.exception("finance update status failed")
        raise HTTPException(status_code=500, detail=str(e))
    if not affected:
        raise HTTPException(status_code=404, detail="entry not found")
    return {"ok": True}


@router.delete("/finance/entries/{entry_id}")
async def finance_delete_entry(
    request: Request,
    entry_id: int,
    user_id: str | None = Depends(get_current_user_id),
) -> dict[str, bool]:
    svc = _service_or_503(request)
    try:
        affected = await svc.delete_entry(entry_id, user_id=user_id)
    except Exception as e:
        logger.exception("finance delete entry failed")
        raise HTTPException(status_code=500, detail=str(e))
    if not affected:
        raise HTTPException(status_code=404, detail="entry not found")
    return {"ok": True}


@router.get("/finance/recurring")
async def finance_list_recurring(
    request: Request,
    user_id: str | None = Depends(get_current_user_id),
) -> dict[str, Any]:
    svc = _service_or_503(request)
    try:
        rules = await svc.list_recurring(active_only=True, user_id=user_id)
        return {"rules": [dataclasses.asdict(r) for r in rules]}
    except Exception as e:
        logger.exception("finance list recurring failed")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/finance/entries/bulk")
async def finance_bulk_create(
    request: Request,
    body: BulkCreate,
    user_id: str | None = Depends(get_current_user_id),
) -> dict[str, Any]:
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
            entry_id = await svc.add_entry(entry, user_id=user_id)
            ids.append(entry_id)
        # Best-effort timeline event (only when the app exposes a store
        # with add_event — Seraphine does, Aura may not).
        store = getattr(request.app.state, "store", None)
        if store is not None and ids:
            add_event = getattr(store, "add_event", None)
            if callable(add_event):
                try:
                    await add_event(
                        event_type="finance_import",
                        summary=f"Imported {len(ids)} finance entries",
                        source="finance",
                        metadata={"count": len(ids)},
                    )
                except Exception as exc:
                    logger.debug("add_event for finance_import failed: %s", exc)
        return {"ids": ids, "count": len(ids)}
    except Exception as e:
        logger.exception("finance bulk create failed")
        raise HTTPException(status_code=500, detail=str(e))
