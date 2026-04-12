"""Notification callback fired when a reminder triggers."""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime
from zoneinfo import ZoneInfo

logger = logging.getLogger(__name__)

SP_TZ = ZoneInfo("America/Sao_Paulo")


async def notify_reminder(app_state: object, reminder_id: str, message: str) -> None:
    """Push the reminder to all connected WS clients and persist it."""
    fired_at = datetime.now(SP_TZ).isoformat()

    # 1. Push to all connected WS clients
    ws_clients: set = getattr(app_state, "ws_clients", set())
    dead: list = []
    for ws in ws_clients:
        try:
            await ws.send_json({
                "type": "reminder",
                "reminder_id": reminder_id,
                "message": message,
                "fired_at": fired_at,
            })
            # Also inject as a chat bubble so it shows in ChatView
            turn_id = str(uuid.uuid4())
            await ws.send_json({
                "type": "token",
                "conversation_id": "system",
                "turn_id": turn_id,
                "text": f"Lembrete: {message}",
            })
            await ws.send_json({
                "type": "turn_end",
                "conversation_id": "system",
                "turn_id": turn_id,
            })

            # 3. Queue for TTS speech (say the reminder aloud)
            try:
                from seraphine.ws.routes import _enqueue_speech

                await _enqueue_speech(ws, f"Lembrete: {message}", turn_id)
            except Exception as exc:
                logger.debug("TTS enqueue for reminder failed: %s", exc)
        except Exception:
            dead.append(ws)

    for ws in dead:
        ws_clients.discard(ws)

    # 2. Persist as notification in the store
    store = getattr(app_state, "store", None)
    if store is not None:
        try:
            await store.add_notification(
                event="reminder.fired",
                task_id=reminder_id,
                title=f"Lembrete: {message[:80]}",
                summary=message,
                payload=json.dumps(
                    {"reminder_id": reminder_id, "message": message, "fired_at": fired_at},
                    ensure_ascii=False,
                ),
            )
        except Exception as exc:
            logger.warning("Failed to persist reminder notification: %s", exc)
