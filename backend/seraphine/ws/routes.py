from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from seraphine.conversation.engine import ConversationEngine

logger = logging.getLogger("seraphine.ws")

router = APIRouter()


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
            if not isinstance(payload, dict):
                await ws.send_json(EchoMessage(data={"raw": payload}).model_dump())
                continue

            mtype = payload.get("type")
            if mtype == "ping":
                await ws.send_json(PongMessage(ts=_now_iso()).model_dump())
            elif mtype == "user_message":
                engine: ConversationEngine = ws.app.state.engine
                conv_id = payload.get("conversation_id")
                content = payload.get("content", "")
                async for event in engine.handle_user_message(conv_id, content):
                    await ws.send_json(event.model_dump())
            else:
                await ws.send_json(EchoMessage(data=payload).model_dump())
    except WebSocketDisconnect:
        logger.info("WS disconnected: %s", client)
