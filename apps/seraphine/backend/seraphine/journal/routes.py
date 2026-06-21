"""Journal HTTP API -- single-tenant, no auth required."""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from seraphine.journal.service import JournalService

router = APIRouter(prefix="/journal", tags=["journal"])
logger = logging.getLogger(__name__)


# -- Pydantic bodies ------------------------------------------------


class JournalCreateBody(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    content: str = Field(default="", max_length=20_000)
    tags: list[str] | None = None
    date: str | None = None  # optional override, defaults to today SP
    # Composer-selected mood. When provided, it wins over the conversation
    # mood snapshot so the user's chosen face actually feeds the histogram/map.
    mood_label: str | None = Field(default=None, max_length=40)
    mood_valence: float | None = Field(default=None, ge=-1.0, le=1.0)

    model_config = {"extra": "forbid"}


class JournalUpdateBody(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    content: str | None = Field(default=None, max_length=20_000)
    tags: list[str] | None = None

    model_config = {"extra": "forbid"}


# -- Helper ----------------------------------------------------------


def _service_or_503(request: Request) -> JournalService:
    svc: Optional[JournalService] = getattr(
        request.app.state, "journal_service", None,
    )
    if svc is None:
        raise HTTPException(status_code=503, detail="journal service not configured")
    return svc


def _today_sp() -> str:
    from datetime import datetime
    from zoneinfo import ZoneInfo

    return datetime.now(ZoneInfo("America/Sao_Paulo")).date().isoformat()


# -- Endpoints -------------------------------------------------------


@router.get("/search")
async def journal_search(
    request: Request,
    q: str = Query(..., min_length=1),
    limit: int = Query(default=10, ge=1, le=50),
) -> dict[str, Any]:
    """Semantic search across journal entries."""
    svc = _service_or_503(request)
    results = await svc.search(q, limit=limit)
    return {"results": results}


@router.get("")
async def journal_list(
    request: Request,
    month: int | None = Query(default=None, ge=1, le=12),
    year: int | None = Query(default=None, ge=2020, le=2100),
    type: str | None = Query(default=None),
    q: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> dict[str, Any]:
    svc = _service_or_503(request)
    entries = await svc.get_entries(
        month=month, year=year, type=type, q=q,
        limit=limit, offset=offset,
    )
    total = await svc.get_entries(
        month=month, year=year, type=type, q=q,
        limit=10_000, offset=0,
    )
    return {"entries": [e.to_dict() for e in entries], "total": len(total)}


@router.get("/stats")
async def journal_stats(request: Request) -> dict[str, int]:
    """Writing stats aggregated over existing entry dates (read-only)."""
    svc = _service_or_503(request)
    return await svc.get_stats()


@router.get("/{entry_id}")
async def journal_get(request: Request, entry_id: str) -> dict[str, Any]:
    svc = _service_or_503(request)
    entry = await svc.get_entry(entry_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="entry not found")
    return {"entry": entry.to_dict()}


@router.post("")
async def journal_create(
    request: Request,
    body: JournalCreateBody,
) -> dict[str, Any]:
    svc = _service_or_503(request)
    date = body.date or _today_sp()

    # Mood resolution: the composer-selected mood (body) always wins. Only when
    # the user did not pick a face do we fall back to today's conversation mood.
    mood_label: str | None = body.mood_label
    mood_valence: float | None = body.mood_valence
    if mood_valence is None and mood_label is None:
        mood_service = getattr(request.app.state, "mood_service", None)
        if mood_service is not None:
            try:
                today_mood = await mood_service.get_today()
                current = today_mood.get("current")
                if current:
                    mood_label = current.get("label")
                    mood_valence = current.get("valence")
            except Exception:
                pass

    entry = await svc.create_entry(
        date=date,
        type="manual",
        title=body.title,
        content=body.content,
        mood_label=mood_label,
        mood_valence=mood_valence,
        tags=body.tags,
        source="user",
    )

    # Best-effort, non-blocking Seraphine reflection on the entry. Falls back to
    # null (no callout) when no LLM is configured or generation fails.
    try:
        reflection = await svc.generate_reflection(body.content)
        if reflection:
            await svc.set_reflection(entry.id, reflection)
            entry.reflection = reflection
    except Exception as e:
        logger.warning("journal: reflection step skipped: %s", e)

    return {"entry": entry.to_dict()}


@router.patch("/{entry_id}")
async def journal_update(
    request: Request,
    entry_id: str,
    body: JournalUpdateBody,
) -> dict[str, Any]:
    svc = _service_or_503(request)
    existing = await svc.get_entry(entry_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="entry not found")
    if existing.source != "user":
        raise HTTPException(
            status_code=403,
            detail="auto-generated entries are read-only",
        )
    updated = await svc.update_entry(
        entry_id,
        title=body.title,
        content=body.content,
        tags=body.tags,
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="entry not found")
    return {"entry": updated.to_dict()}


@router.delete("/{entry_id}")
async def journal_delete(
    request: Request,
    entry_id: str,
) -> dict[str, Any]:
    svc = _service_or_503(request)
    existing = await svc.get_entry(entry_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="entry not found")
    if existing.source != "user":
        raise HTTPException(
            status_code=403,
            detail="auto-generated entries are read-only",
        )
    deleted = await svc.delete_entry(entry_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="entry not found")
    return {"ok": True}
