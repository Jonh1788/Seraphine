"""Notification callback fired when a reminder triggers.

Delivery priority:
1. Push to all connected WS clients (instant — chat bubble + TTS)
2. Persist as notification (delivered on reconnect)
3. Email via Gmail as fallback when no WS client is connected
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import datetime
from zoneinfo import ZoneInfo

logger = logging.getLogger(__name__)


def _fire_and_log(coro, *, name: str) -> None:
    """Schedule ``coro`` as a background task and log any exception it raises.

    Plain ``asyncio.create_task`` swallows exceptions when nobody awaits
    the task; this helper attaches a done-callback that surfaces failures
    to the module logger so background work can't fail silently.
    """

    task = asyncio.create_task(coro, name=name)

    def _on_done(t: asyncio.Task) -> None:
        if t.cancelled():
            return
        exc = t.exception()
        if exc is not None:
            logger.exception("Background task %s failed", name, exc_info=exc)

    task.add_done_callback(_on_done)


SP_TZ = ZoneInfo("America/Sao_Paulo")

# Seconds to wait before sending email fallback. If a WS client
# connects in this window, skip the email (user already saw it).
_EMAIL_FALLBACK_DELAY = 60


async def notify_reminder(app_state: object, reminder_id: str, message: str) -> None:
    """Push the reminder through all available channels."""
    fired_at = datetime.now(SP_TZ).isoformat()
    fired_at_human = datetime.now(SP_TZ).strftime("%H:%M")

    # 1. Push to all connected WS clients
    ws_clients: set = getattr(app_state, "ws_clients", set())
    delivered_to_ws = False
    dead: list = []
    # Snapshot the set: TTS/send coroutines below may add or remove
    # clients concurrently, which would raise "set changed size during
    # iteration" on the live set.
    for ws in list(ws_clients):
        try:
            await ws.send_json({
                "type": "reminder",
                "reminder_id": reminder_id,
                "message": message,
                "fired_at": fired_at,
            })
            turn_id = str(uuid.uuid4())
            await ws.send_json({
                "type": "token",
                "conversation_id": "system",
                "turn_id": turn_id,
                "text": f"🔔 Lembrete: {message}",
            })
            await ws.send_json({
                "type": "turn_end",
                "conversation_id": "system",
                "turn_id": turn_id,
            })
            # TTS
            try:
                from seraphine.ws.routes import _enqueue_speech
                await _enqueue_speech(ws, f"Lembrete: {message}", turn_id)
            except Exception as exc:
                logger.debug("TTS enqueue for reminder failed: %s", exc)
            delivered_to_ws = True
        except Exception:
            dead.append(ws)

    for ws in dead:
        ws_clients.discard(ws)

    # 2. Persist as notification (delivered on reconnect if missed)
    store = getattr(app_state, "store", None)
    if store is not None:
        try:
            await store.add_notification(
                event="reminder.fired",
                task_id=reminder_id,
                title=f"🔔 Lembrete: {message[:80]}",
                summary=message,
                payload=json.dumps(
                    {"reminder_id": reminder_id, "message": message, "fired_at": fired_at},
                    ensure_ascii=False,
                ),
            )
        except Exception as exc:
            logger.warning("Failed to persist reminder notification: %s", exc)

        # Timeline event — best-effort.
        try:
            await store.add_event(
                event_type="reminder_fired",
                summary=message[:200],
                source="system",
                metadata={"reminder_id": reminder_id, "fired_at": fired_at},
            )
        except Exception as exc:
            logger.debug("add_event for reminder_fired failed: %s", exc)

    # 3. Web Push fallback — if nobody was connected
    if not delivered_to_ws:
        push = getattr(app_state, "push_service", None)
        if push:
            try:
                await push.send_notification(
                    title="Lembrete",
                    body=message,
                    url="/?view=chat",
                    tag=f"reminder-{reminder_id}",
                )
            except Exception as exc:
                logger.warning("Web Push send for reminder failed: %s", exc)

    # 4. Email fallback — if nobody was connected, send via Gmail
    if not delivered_to_ws:
        _fire_and_log(
            _email_fallback(app_state, reminder_id, message, fired_at_human),
            name=f"reminder_email_fallback:{reminder_id}",
        )


async def _email_fallback(
    app_state: object, reminder_id: str, message: str, time_str: str,
) -> None:
    """Wait a short window, then send an email if still no WS client saw it."""
    await asyncio.sleep(_EMAIL_FALLBACK_DELAY)

    # Re-check: maybe a client connected in the meantime
    ws_clients: set = getattr(app_state, "ws_clients", set())
    if ws_clients:
        logger.info("Reminder %s: WS client reconnected, skipping email fallback", reminder_id)
        return

    google_client = getattr(app_state, "google_client", None)
    if google_client is None:
        logger.info("Reminder %s: no Google client, can't send email fallback", reminder_id)
        return

    try:
        authed = await google_client.is_authed()
        if not authed:
            logger.info("Reminder %s: Google not authed, skipping email", reminder_id)
            return
    except Exception:
        return

    # Get user's email from the Google auth status
    try:
        from google_integration.client import GMAIL_API
        profile = await google_client._authed_request("GET", f"{GMAIL_API}/users/me/profile")
        user_email = profile.json().get("emailAddress", "")
        if not user_email:
            return
    except Exception as e:
        logger.warning("Reminder email fallback: couldn't get user email: %s", e)
        return

    # Send self-email
    try:
        import base64
        from email.mime.text import MIMEText

        mime = MIMEText(
            f"🔔 Lembrete da Seraphine ({time_str}):\n\n{message}\n\n"
            f"(Este email foi enviado porque o frontend da Seraphine estava fechado "
            f"quando o lembrete disparou.)",
            _charset="utf-8",
        )
        mime["To"] = user_email
        mime["Subject"] = f"🔔 Lembrete: {message[:60]}"
        raw = base64.urlsafe_b64encode(mime.as_bytes()).decode("ascii")

        await google_client._authed_request(
            "POST",
            f"{GMAIL_API}/users/me/messages/send",
            json={"raw": raw},
        )
        logger.info("Reminder %s: email fallback sent to %s", reminder_id, user_email)
    except Exception as e:
        logger.warning("Reminder email fallback failed: %s", e)
