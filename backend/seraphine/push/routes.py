"""Web Push subscription management endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Request
from pydantic import BaseModel

router = APIRouter(tags=["push"])


class SubscriptionPayload(BaseModel):
    endpoint: str
    keys: dict  # {p256dh, auth}


@router.get("/push/vapid-public-key")
async def get_vapid_key(request: Request):
    push = getattr(request.app.state, "push_service", None)
    if not push:
        return {"key": None}
    return {"key": push.public_key}


@router.post("/push/subscribe")
async def subscribe(request: Request, payload: SubscriptionPayload):
    push = getattr(request.app.state, "push_service", None)
    if not push:
        return {"ok": False, "error": "push not configured"}
    push.add_subscription({"endpoint": payload.endpoint, "keys": payload.keys})
    return {"ok": True}


@router.post("/push/unsubscribe")
async def unsubscribe(request: Request, payload: SubscriptionPayload):
    push = getattr(request.app.state, "push_service", None)
    if push:
        push.remove_subscription(payload.endpoint)
    return {"ok": True}
