"""FastAPI router for the WhatsApp integration (T9 slice)."""

from __future__ import annotations

import logging
import secrets
from typing import Any, Optional

from fastapi import (
    APIRouter, BackgroundTasks, Depends, Header, HTTPException, Request,
)
from pydantic import BaseModel, Field

from mod_tasks.routes import get_current_user_id

from aura.whatsapp.phone import InvalidPhone
from aura.whatsapp.service import CooldownError

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/whatsapp", tags=["whatsapp"])


# ---- Pydantic ---------------------------------------------------------

class StartConnectBody(BaseModel):
    # Defer real phone validation to the service (normalize_e164 raises
    # InvalidPhone -> 400). Keeping the schema permissive here lets bad
    # input reach the canonical validator instead of bouncing as 422.
    phone: str = Field(min_length=1, max_length=32)


class VerifyBody(BaseModel):
    code: str = Field(min_length=1, max_length=10)


# ---- Helpers ----------------------------------------------------------

def _service(request: Request) -> Any:
    svc = getattr(request.app.state, "whatsapp_service", None)
    if svc is None:
        raise HTTPException(status_code=503, detail="whatsapp not configured")
    return svc


def _require_user(user_id: str | None) -> str:
    if user_id is None:
        raise HTTPException(status_code=401, detail="autenticação requerida")
    return user_id


def _adapt_evolution_payload(raw: dict[str, Any]) -> dict[str, Any] | None:
    """Map Evolution's webhook envelope to the routing-layer shape.

    Accepts only ``messages.upsert`` events and only inbound (not
    ``fromMe``). 1:1 chats have ``@s.whatsapp.net`` JIDs; groups end
    in ``@g.us``.
    """
    event = (raw.get("event") or "").lower()
    if event != "messages.upsert":
        logger.debug("wa webhook: ignored event=%r", raw.get("event"))
        return None
    data = raw.get("data") or {}
    key = data.get("key") or {}
    if key.get("fromMe"):
        return None
    remote = key.get("remoteJid") or ""
    if not remote:
        return None
    is_group = remote.endswith("@g.us")
    bare = remote.split("@", 1)[0]
    phone = ("+" + bare) if bare.isdigit() else None
    msg = data.get("message") or {}
    text = (
        msg.get("conversation")
        or (msg.get("extendedTextMessage") or {}).get("text")
        or ""
    ).strip()
    if not text:
        logger.debug(
            "wa webhook: messages.upsert with no text body "
            "(message keys=%s); dropping",
            list(msg.keys()),
        )
        return None
    return {"phone_e164": phone, "text": text, "is_group": is_group}


# ---- Routes -----------------------------------------------------------

@router.post("/webhook")
async def webhook(
    request: Request,
    background: BackgroundTasks,
    x_evolution_webhook_token: Optional[str] = Header(None),
) -> dict[str, bool]:
    expected = getattr(request.app.state, "whatsapp_webhook_token", None)
    if not expected or not secrets.compare_digest(
        x_evolution_webhook_token or "", expected
    ):
        raise HTTPException(status_code=401, detail="bad webhook token")

    svc = _service(request)
    raw = await request.json()
    try:
        payload = _adapt_evolution_payload(raw)
        if payload is None:
            return {"ok": True}
        decision = await svc.route_inbound(payload)
        if decision is None:
            return {"ok": True}
        # Run the LLM loop in the background so Evolution's retry
        # window doesn't tick while we wait on Anthropic.
        background.add_task(
            svc.process_user_message,
            decision["user_id"],
            decision["conversation_id"],
            decision["text"],
        )
    except Exception:
        logger.exception("whatsapp webhook handler failed")
    return {"ok": True}


@router.post("/connect/start")
async def connect_start(
    request: Request,
    body: StartConnectBody,
    user_id: Optional[str] = Depends(get_current_user_id),
) -> dict[str, bool]:
    uid = _require_user(user_id)
    svc = _service(request)
    try:
        await svc.start_verification(uid, body.phone)
    except CooldownError as e:
        raise HTTPException(status_code=429, detail=str(e))
    except InvalidPhone as e:
        raise HTTPException(status_code=400, detail=f"telefone inválido: {e}")
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"ok": True}


@router.post("/connect/verify")
async def connect_verify(
    request: Request,
    body: VerifyBody,
    user_id: Optional[str] = Depends(get_current_user_id),
) -> dict[str, bool]:
    uid = _require_user(user_id)
    svc = _service(request)
    ok = await svc.verify(uid, body.code)
    if not ok:
        raise HTTPException(status_code=400, detail="código inválido ou expirado")
    return {"ok": True}
