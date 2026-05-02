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


def _require_admin(request: Request, header_value: str | None) -> None:
    expected = getattr(request.app.state, "whatsapp_admin_token", None)
    if not expected or not secrets.compare_digest(
        header_value or "", expected,
    ):
        raise HTTPException(status_code=401, detail="admin token required")


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
    # Why: Evolution v2 only attaches WEBHOOK_GLOBAL_HEADERS in some
    # event paths; per-instance webhooks silently drop custom headers.
    # When the operator leaves AURA_EVOLUTION_WEBHOOK_TOKEN empty in
    # .env.prod we accept any inbound (Evolution lives on the internal
    # docker network, no public exposure). When set we still enforce
    # constant-time compare. On mismatch we log header keys to help
    # diagnose Evolution's header shape (no values logged).
    if expected:
        if not secrets.compare_digest(x_evolution_webhook_token or "", expected):
            logger.warning(
                "whatsapp webhook 401 — header keys=%s",
                sorted(request.headers.keys()),
            )
            raise HTTPException(status_code=401, detail="bad webhook token")

    svc = _service(request)
    raw = await request.json()
    try:
        event_lower = (raw.get("event") or "").lower()

        # qrcode.updated — Evolution v2 only delivers QRs through the
        # webhook stream (the /instance/connect endpoint just returns a
        # subscriber count). Cache the latest base64 so /admin/qr can
        # serve it. Tolerate both the data.qrcode.{base64,code} and
        # data.{base64,code} shapes that v2 has used across versions.
        if event_lower in ("qrcode.updated", "qrcode_updated"):
            data = raw.get("data") or {}
            qrobj = data.get("qrcode") if isinstance(data, dict) else None
            if not isinstance(qrobj, dict):
                qrobj = data if isinstance(data, dict) else {}
            b64 = qrobj.get("base64") or qrobj.get("code")
            if isinstance(b64, str):
                svc.cache_qr(b64)
                logger.info(
                    "wa webhook: cached qrcode.updated (len=%d)", len(b64),
                )
            else:
                logger.info(
                    "wa webhook: qrcode.updated received but no base64/code "
                    "in data; data keys=%s",
                    sorted((data or {}).keys()) if isinstance(data, dict) else "<non-dict>",
                )
            return {"ok": True}

        # connection.update — clear cached QR once we're 'open'. Full
        # data dump (TEMP) so we can see lastDisconnect details from
        # Baileys when the handshake is failing.
        if event_lower in ("connection.update", "connection_update"):
            data = raw.get("data") or {}
            state = data.get("state") if isinstance(data, dict) else None
            if state == "open":
                svc.clear_qr()
            import json as _json
            try:
                dump = _json.dumps(data, default=str)[:600]
            except Exception:
                dump = str(data)[:600]
            logger.info(
                "wa webhook: connection.update state=%r data=%s",
                state, dump,
            )
            return {"ok": True}

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


@router.get("/status")
async def status(
    request: Request,
    user_id: Optional[str] = Depends(get_current_user_id),
) -> dict[str, Any]:
    uid = _require_user(user_id)
    svc = _service(request)
    return await svc.get_status(uid)


@router.post("/disconnect")
async def disconnect(
    request: Request,
    user_id: Optional[str] = Depends(get_current_user_id),
) -> dict[str, bool]:
    uid = _require_user(user_id)
    svc = _service(request)
    await svc.disconnect(uid)
    return {"ok": True}


@router.get("/admin/qr")
async def admin_qr(
    request: Request,
    x_aura_admin_token: Optional[str] = Header(None),
) -> dict[str, Optional[str]]:
    """Latest QR for the operator one-shot scan.

    Why two sources: Evolution v2 only delivers QR codes through the
    qrcode.updated webhook (the /instance/connect endpoint just opens
    a subscriber count). We cache the latest one in WhatsAppService and
    serve it from memory. Older Evolution variants and the client.get_qr
    fallback are kept for compatibility — if the cache is empty we ask
    the upstream just in case.
    """
    _require_admin(request, x_aura_admin_token)
    svc = _service(request)
    cached = svc.latest_qr
    if cached:
        return {"qr": cached, "state": "qr_ready"}
    qr, state = await svc._client.get_qr()
    return {"qr": qr, "state": state}


@router.get("/admin/status")
async def admin_status(
    request: Request,
    x_aura_admin_token: Optional[str] = Header(None),
) -> dict[str, Any]:
    _require_admin(request, x_aura_admin_token)
    svc = _service(request)
    return await svc._client.get_status()
