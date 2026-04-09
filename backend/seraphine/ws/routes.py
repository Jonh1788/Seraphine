from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

logger = logging.getLogger("seraphine.ws")

router = APIRouter()


class PingMessage(BaseModel):
    type: str  # "ping"


class PongMessage(BaseModel):
    type: str = "pong"
    ts: str


class EchoMessage(BaseModel):
    type: str = "echo"
    data: dict[str, Any]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@router.websocket("/ws/conversation")
async def conversation_ws(ws: WebSocket) -> None:
    await ws.accept()
    client = f"{ws.client.host}:{ws.client.port}" if ws.client else "?"
    logger.info("WS connected: %s", client)
    try:
        while True:
            payload = await ws.receive_json()
            if isinstance(payload, dict) and payload.get("type") == "ping":
                await ws.send_json(PongMessage(ts=_now_iso()).model_dump())
            else:
                await ws.send_json(EchoMessage(data=payload if isinstance(payload, dict) else {"raw": payload}).model_dump())
    except WebSocketDisconnect:
        logger.info("WS disconnected: %s", client)
