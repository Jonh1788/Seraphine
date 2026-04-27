"""Push routes — VAPID public key + subscribe/unsubscribe + test send."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from mod_tasks.routes import get_current_user_id

from aura.push.service import PushService

router = APIRouter(prefix="/push", tags=["push"])


def _service_or_503(request: Request) -> PushService:
    svc = getattr(request.app.state, "push_service", None)
    if svc is None:
        raise HTTPException(status_code=503, detail="push service não configurado")
    return svc


def _require_user(user_id: str | None) -> str:
    if user_id is None:
        raise HTTPException(status_code=401, detail="autenticação requerida")
    return user_id


class SubscribeKeys(BaseModel):
    p256dh: str = Field(..., min_length=1)
    auth: str = Field(..., min_length=1)


class SubscribeBody(BaseModel):
    endpoint: str = Field(..., min_length=10)
    keys: SubscribeKeys
    user_agent: str | None = Field(None, max_length=300)


class UnsubscribeBody(BaseModel):
    endpoint: str


@router.get("/vapid-public-key")
async def get_vapid_public_key(request: Request) -> dict:
    """Public endpoint — no auth needed. The browser uses this key
    to subscribe via the push service."""
    svc = _service_or_503(request)
    return {"key": svc.vapid_public_key_b64}


@router.post("/subscribe")
async def subscribe(
    body: SubscribeBody,
    request: Request,
    user_id: str | None = Depends(get_current_user_id),
) -> dict:
    uid = _require_user(user_id)
    svc = _service_or_503(request)
    sub = await svc.upsert_subscription(
        user_id=uid,
        endpoint=body.endpoint,
        p256dh=body.keys.p256dh,
        auth=body.keys.auth,
        user_agent=body.user_agent,
    )
    return {"id": sub.id, "ok": True}


@router.post("/unsubscribe")
async def unsubscribe(
    body: UnsubscribeBody,
    request: Request,
    user_id: str | None = Depends(get_current_user_id),
) -> dict:
    uid = _require_user(user_id)
    svc = _service_or_503(request)
    n = await svc.delete_subscription(uid, body.endpoint)
    return {"removed": n}


@router.post("/test")
async def send_test(
    request: Request,
    user_id: str | None = Depends(get_current_user_id),
) -> dict:
    uid = _require_user(user_id)
    svc = _service_or_503(request)
    sent = await svc.send_to_user(
        uid,
        {
            "title": "Aura ✓",
            "body": "Notificações ativas. Você verá os lembretes aqui.",
            "tag": "aura-test",
            "data": {"url": "/mais/lembretes"},
        },
    )
    return {"sent": sent}
