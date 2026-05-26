"""094 -- Notification Intelligence HTTP API."""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from seraphine.notifications.service import NotificationService

router = APIRouter(prefix="/notifications", tags=["notifications"])
logger = logging.getLogger(__name__)


def _service_or_503(request: Request) -> NotificationService:
    svc: Optional[NotificationService] = getattr(
        request.app.state, "notification_service", None,
    )
    if svc is None:
        raise HTTPException(status_code=503, detail="notification service not configured")
    return svc


# ------------------------------------------------------------------
# Settings
# ------------------------------------------------------------------


@router.get("/settings")
async def get_settings(request: Request) -> dict[str, Any]:
    svc = _service_or_503(request)
    settings = await svc.get_settings()
    return settings.to_dict()


class SettingsPatch(BaseModel):
    quiet_hours_start: str | None = None
    quiet_hours_end: str | None = None
    dnd_apps: list[str] | None = None
    batching_enabled: bool | None = None
    per_type_enabled: dict[str, bool] | None = None


@router.patch("/settings")
async def patch_settings(request: Request, body: SettingsPatch) -> dict[str, Any]:
    svc = _service_or_503(request)
    patch = {k: v for k, v in body.model_dump().items() if v is not None}
    if not patch:
        settings = await svc.get_settings()
        return settings.to_dict()
    updated = await svc.update_settings(patch)
    return updated.to_dict()


# ------------------------------------------------------------------
# Queue
# ------------------------------------------------------------------


@router.get("/queue")
async def get_queue(request: Request) -> dict[str, Any]:
    svc = _service_or_503(request)
    items = await svc.get_pending_queue()
    return {"queue": items, "count": len(items)}


@router.post("/queue/flush")
async def flush_queue(request: Request) -> dict[str, Any]:
    svc = _service_or_503(request)
    flushed = await svc.flush_queue()
    return {"flushed": flushed, "count": len(flushed)}


# ------------------------------------------------------------------
# Feedback
# ------------------------------------------------------------------


class FeedbackBody(BaseModel):
    notification_type: str
    action: str  # opened | dismissed | snoozed | ignored


@router.post("/{notification_id}/feedback")
async def post_feedback(
    request: Request, notification_id: str, body: FeedbackBody,
) -> dict[str, str]:
    svc = _service_or_503(request)
    try:
        await svc.record_feedback(notification_id, body.notification_type, body.action)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return {"ok": "recorded"}


# ------------------------------------------------------------------
# Priority weights
# ------------------------------------------------------------------


@router.get("/priority-weights")
async def get_priority_weights(request: Request) -> dict[str, Any]:
    svc = _service_or_503(request)
    weights = await svc.get_priority_weights()
    return {"weights": weights}


# ------------------------------------------------------------------
# DND status
# ------------------------------------------------------------------


@router.get("/dnd-status")
async def get_dnd_status(request: Request) -> dict[str, Any]:
    svc = _service_or_503(request)
    return await svc.get_dnd_status()
