"""Planning HTTP API -- single-tenant, no auth required (SDD 093)."""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from seraphine.planning.service import PlanningService

router = APIRouter(prefix="/planning", tags=["planning"])
logger = logging.getLogger(__name__)


# ------------------------------------------------------------------
# Request bodies
# ------------------------------------------------------------------

class PatchBlockBody(BaseModel):
    start: str | None = None
    end: str | None = None
    title: str | None = None
    type: str | None = None

    model_config = {"extra": "forbid"}


class FeedbackBody(BaseModel):
    blocks_executed: int = 0
    tasks_done: int = 0


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

def _get_service(request: Request) -> PlanningService:
    svc = getattr(request.app.state, "planning_service", None)
    if svc is None:
        raise HTTPException(503, "Planning service not available")
    return svc


# ------------------------------------------------------------------
# Routes
# ------------------------------------------------------------------

@router.get("/today")
async def get_today_plan(request: Request) -> dict[str, Any]:
    """Generate (or re-generate) today's daily plan."""
    svc = _get_service(request)
    plan = await svc.generate_plan()
    return plan.to_dict()


@router.post("/accept")
async def accept_plan(request: Request) -> dict[str, Any]:
    """Mark today's plan as accepted and create calendar events."""
    svc = _get_service(request)
    result = await svc.accept_plan()
    if not result.get("ok"):
        raise HTTPException(404, result.get("error", "Erro desconhecido"))
    return result


@router.patch("/blocks/{block_id}")
async def update_block(
    block_id: str,
    body: PatchBlockBody,
    request: Request,
) -> dict[str, Any]:
    """Adjust a single time block in today's plan."""
    svc = _get_service(request)
    result = await svc.update_block(
        block_id,
        start=body.start,
        end=body.end,
        title=body.title,
        block_type=body.type,
    )
    if not result.get("ok"):
        raise HTTPException(404, result.get("error", "Erro desconhecido"))
    return result


@router.post("/feedback")
async def record_feedback(
    body: FeedbackBody,
    request: Request,
) -> dict[str, Any]:
    """Record end-of-day execution feedback."""
    svc = _get_service(request)
    result = await svc.record_feedback(
        blocks_executed=body.blocks_executed,
        tasks_done=body.tasks_done,
    )
    if not result.get("ok"):
        raise HTTPException(404, result.get("error", "Erro desconhecido"))
    return result


@router.get("/history")
async def get_history(
    request: Request,
    days: int = 7,
) -> list[dict[str, Any]]:
    """Return past plan summaries with feedback."""
    svc = _get_service(request)
    return await svc.get_history(days=days)
