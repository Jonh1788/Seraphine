"""REST router for the WhatsApp bridge integration.

Proxies status/QR endpoints to the Node.js bridge and receives
incoming message webhooks, broadcasting them to connected WS clients.
"""

from __future__ import annotations

import json
import logging
import uuid
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request

from seraphine.whatsapp.client import WhatsAppBridgeClient, WhatsAppBridgeError

router = APIRouter(tags=["whatsapp"])
logger = logging.getLogger(__name__)


def _client_or_503(request: Request) -> WhatsAppBridgeClient:
    client: Optional[WhatsAppBridgeClient] = getattr(
        request.app.state, "whatsapp_client", None
    )
    if client is None:
        raise HTTPException(
            status_code=503,
            detail="whatsapp integration not configured (set SERAPHINE_WHATSAPP_BRIDGE_URL)",
        )
    return client


# ----------------------------------------------------------------------
# Proxy endpoints
# ----------------------------------------------------------------------


@router.get("/whatsapp/status")
async def whatsapp_status(request: Request) -> dict[str, Any]:
    """Proxy to bridge GET /api/status."""
    client = _client_or_503(request)
    try:
        return await client.status()
    except WhatsAppBridgeError as e:
        raise HTTPException(status_code=502, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"bridge unreachable: {e}")


@router.get("/whatsapp/qr")
async def whatsapp_qr(request: Request) -> dict[str, Any]:
    """Proxy to bridge GET /api/qr. Returns QR data URL for frontend."""
    client = _client_or_503(request)
    try:
        return await client.qr()
    except WhatsAppBridgeError as e:
        raise HTTPException(status_code=502, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"bridge unreachable: {e}")


# ----------------------------------------------------------------------
# Webhook — incoming messages from bridge
# ----------------------------------------------------------------------


@router.post("/webhook/whatsapp")
async def webhook_whatsapp(request: Request) -> dict[str, bool]:
    """Receive incoming message notifications from the bridge.

    Stores in the notifications table and pushes a
    ``whatsapp_notification`` event to all connected WS clients.
    """
    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="invalid JSON body")

    event_type = payload.get("event", "message")
    chat_id = payload.get("chatId", "")
    chat_name = payload.get("chatName", "")
    message = payload.get("message", {})
    author = message.get("author", chat_name)
    body = message.get("body", "")
    msg_id = message.get("id", "")

    # 1. Persist notification
    store = getattr(request.app.state, "store", None)
    if store is not None:
        try:
            await store.add_notification(
                event=f"whatsapp.{event_type}",
                task_id=msg_id,
                title=f"WhatsApp: {author}",
                summary=body[:500] if body else "",
                payload=json.dumps(payload, ensure_ascii=False, default=str),
            )
        except Exception as e:
            logger.warning("failed to persist whatsapp notification: %s", e)

    # 2. Broadcast to all connected WS clients
    ws_clients: set = getattr(request.app.state, "ws_clients", set())
    notif_msg = {
        "type": "whatsapp_notification",
        "event": event_type,
        "chatId": chat_id,
        "chatName": chat_name,
        "author": author,
        "body": body,
        "messageId": msg_id,
        "timestamp": message.get("timestamp"),
    }
    dead: list[Any] = []
    for ws in ws_clients:
        try:
            await ws.send_json(notif_msg)
        except Exception:
            dead.append(ws)
    for ws in dead:
        ws_clients.discard(ws)

    return {"ok": True}
