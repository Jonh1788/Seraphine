"""Web Push subscription management endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Request
from pydantic import BaseModel

router = APIRouter(tags=["push"])


class PushKeys(BaseModel):
    p256dh: str
    auth: str


class PushSubscribePayload(BaseModel):
    endpoint: str
    keys: PushKeys
    expirationTime: int | None = None


class PushUnsubscribePayload(BaseModel):
    """Unsubscribe only needs the endpoint, but we accept the full
    PushSubscription shape from the browser for symmetry."""

    endpoint: str


@router.get("/push/vapid-public-key")
async def get_vapid_key(request: Request):
    push = getattr(request.app.state, "push_service", None)
    if not push:
        return {"key": None}
    return {"key": push.public_key}


@router.post("/push/subscribe")
async def subscribe(request: Request, payload: PushSubscribePayload):
    push = getattr(request.app.state, "push_service", None)
    if not push:
        return {"ok": False, "error": "push not configured"}
    await push.add_subscription({
        "endpoint": payload.endpoint,
        "keys": {"p256dh": payload.keys.p256dh, "auth": payload.keys.auth},
    })
    return {"ok": True}


@router.post("/push/unsubscribe")
async def unsubscribe(request: Request, payload: PushUnsubscribePayload):
    push = getattr(request.app.state, "push_service", None)
    if push:
        await push.remove_subscription(payload.endpoint)
    return {"ok": True}


@router.get("/push/status")
async def push_status(request: Request):
    push = getattr(request.app.state, "push_service", None)
    if not push:
        return {"configured": False, "subscription_count": 0, "endpoints": []}
    return {
        "configured": True,
        "subscription_count": push.subscription_count,
        "endpoints": [ep[:80] + "..." if len(ep) > 80 else ep for ep in push.list_endpoints()],
    }


class TestPayload(BaseModel):
    title: str = "Seraphine — teste"
    body: str = "Notificacao de teste. Se voce viu isso, o push ta funcionando."
    url: str = "/"


@router.post("/push/test")
async def push_test(request: Request, payload: TestPayload | None = None):
    push = getattr(request.app.state, "push_service", None)
    if not push:
        return {"ok": False, "error": "push not configured"}
    p = payload or TestPayload()
    sent = await push.send_notification(title=p.title, body=p.body, url=p.url, tag="push-test")
    return {"ok": True, "sent": sent, "subscribers": push.subscription_count}
