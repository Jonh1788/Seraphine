"""095 — Contextual shortcuts HTTP API."""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from seraphine.contextual.service import ContextualActionsService

router = APIRouter(prefix="/contextual", tags=["contextual"])
logger = logging.getLogger(__name__)


def _service_or_503(request: Request) -> ContextualActionsService:
    svc: Optional[ContextualActionsService] = getattr(
        request.app.state, "contextual_service", None,
    )
    if svc is None:
        raise HTTPException(status_code=503, detail="contextual service not configured")
    return svc


@router.get("/actions")
async def get_actions(request: Request, app: str = "") -> dict[str, Any]:
    """Return ranked contextual actions for the given app name."""
    svc = _service_or_503(request)
    if not app.strip():
        return {"actions": []}
    actions = await asyncio.to_thread(svc.get_ranked_actions, app)
    return {"actions": [a.to_dict() for a in actions]}


class UsedBody(BaseModel):
    app_name: str = ""

    model_config = {"extra": "forbid"}


@router.post("/actions/{action_id}/used")
async def record_usage(
    request: Request,
    action_id: str,
    body: UsedBody,
) -> dict[str, bool]:
    """Record that the user clicked a contextual action."""
    svc = _service_or_503(request)
    await asyncio.to_thread(svc.record_usage, body.app_name, action_id)
    return {"ok": True}


@router.get("/settings")
async def get_settings(request: Request) -> dict[str, Any]:
    svc = _service_or_503(request)
    return svc.get_settings()


class PatchSettingsBody(BaseModel):
    enabled: bool | None = None

    model_config = {"extra": "allow"}


@router.patch("/settings")
async def patch_settings(
    request: Request,
    body: PatchSettingsBody,
) -> dict[str, Any]:
    svc = _service_or_503(request)
    return svc.update_settings(body.model_dump(exclude_unset=True))
