from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from seraphine.conversation.audio_engine import (
    AudioEngine,
    ErrorEvent as AudioErrorEvent,
    TokenEvent as AudioTokenEvent,
    TtsChunkEvent,
    TtsEndEvent,
    TtsStartEvent,
    TurnEndEvent as AudioTurnEndEvent,
)
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
    audio_buf = bytearray()
    try:
        while True:
            message = await ws.receive()
            if message.get("type") == "websocket.disconnect":
                break

            if "bytes" in message and message["bytes"] is not None:
                audio_buf.extend(message["bytes"])
                continue

            text = message.get("text")
            if text is None:
                continue

            try:
                import json

                payload = json.loads(text)
            except json.JSONDecodeError:
                continue

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
                if engine.tools is None:
                    async for event in engine.handle_user_message(conv_id, content):
                        await ws.send_json(event.model_dump())
                else:
                    import asyncio as _asyncio

                    async def _drive_turn() -> None:
                        async for event in engine.handle_user_message(conv_id, content):
                            await ws.send_json(event.model_dump())

                    turn_task = _asyncio.create_task(_drive_turn())
                    recv_task: _asyncio.Task[Any] | None = None
                    while not turn_task.done():
                        if recv_task is None:
                            recv_task = _asyncio.create_task(ws.receive())
                        done, _pending = await _asyncio.wait(
                            {turn_task, recv_task},
                            return_when=_asyncio.FIRST_COMPLETED,
                        )
                        if recv_task in done:
                            inner = recv_task.result()
                            recv_task = None
                            if inner.get("type") == "websocket.disconnect":
                                turn_task.cancel()
                                raise WebSocketDisconnect()
                            inner_text = inner.get("text")
                            if inner_text is None:
                                continue
                            try:
                                inner_payload = json.loads(inner_text)
                            except json.JSONDecodeError:
                                continue
                            if (
                                isinstance(inner_payload, dict)
                                and inner_payload.get("type") == "tool_approval"
                            ):
                                rid = str(inner_payload.get("request_id", ""))
                                approved = bool(inner_payload.get("approved", False))
                                ok = await engine.submit_approval(rid, approved)
                                if not ok:
                                    await ws.send_json(
                                        {
                                            "type": "error",
                                            "code": "unknown_request_id",
                                            "message": rid,
                                        }
                                    )
                    if recv_task is not None and not recv_task.done():
                        recv_task.cancel()
                        try:
                            await recv_task
                        except BaseException:
                            pass
                    await turn_task
            elif mtype == "audio_start":
                audio_buf = bytearray()
            elif mtype == "audio_end":
                audio_engine: AudioEngine | None = getattr(
                    ws.app.state, "audio_engine", None
                )
                if audio_engine is None:
                    await ws.send_json(
                        {
                            "type": "error",
                            "code": "audio_engine_unavailable",
                            "message": "audio engine not configured",
                        }
                    )
                    audio_buf = bytearray()
                    continue
                conv_id = payload.get("conversation_id")
                buf = bytes(audio_buf)
                async for event in audio_engine.handle_user_audio(conv_id, buf):
                    if isinstance(event, TtsChunkEvent):
                        await ws.send_bytes(event.pcm)
                    elif isinstance(event, TtsStartEvent):
                        await ws.send_json(
                            {
                                "type": "tts_start",
                                "turn_id": event.turn_id,
                                "sample_rate": event.sample_rate,
                            }
                        )
                    elif isinstance(event, TtsEndEvent):
                        await ws.send_json(
                            {"type": "tts_end", "turn_id": event.turn_id}
                        )
                    elif isinstance(
                        event, (AudioTokenEvent, AudioTurnEndEvent, AudioErrorEvent)
                    ):
                        await ws.send_json(event.model_dump())
                audio_buf = bytearray()
            else:
                await ws.send_json(EchoMessage(data=payload).model_dump())
    except WebSocketDisconnect:
        logger.info("WS disconnected: %s", client)
