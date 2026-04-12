"""Reminder tools — create, list, cancel scheduled reminders."""

from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from seraphine.tools.base import Tool, ToolResult

logger = logging.getLogger(__name__)

SP_TZ = ZoneInfo("America/Sao_Paulo")


def _parse_time(raw: str) -> datetime | None:
    """Parse flexible time formats into a timezone-aware datetime.

    Supported formats:
    - ISO 8601: "2026-04-12T14:00:00-03:00"
    - Time today: "14:00", "14h", "14h30", "9:30"
    - Relative: "em 30 minutos", "em 2 horas", "+30m", "+2h"
    """
    raw = raw.strip()
    now = datetime.now(SP_TZ)

    # ISO 8601 — try first
    try:
        dt = datetime.fromisoformat(raw)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=SP_TZ)
        return dt
    except ValueError:
        pass

    # "+30m" / "+2h"
    rel = re.match(r"\+(\d+)(m|h)", raw, re.IGNORECASE)
    if rel:
        val = int(rel.group(1))
        unit = rel.group(2).lower()
        if unit == "m":
            return now + timedelta(minutes=val)
        return now + timedelta(hours=val)

    # Relative: "em X minutos/horas"
    rel = re.match(
        r"em\s+(\d+)\s*(?:minuto|min|m(?:inutos)?)\b",
        raw,
        re.IGNORECASE,
    )
    if rel:
        return now + timedelta(minutes=int(rel.group(1)))
    rel = re.match(
        r"em\s+(\d+)\s*(?:hora|h(?:oras)?)\b",
        raw,
        re.IGNORECASE,
    )
    if rel:
        return now + timedelta(hours=int(rel.group(1)))

    # Time today: "14:00", "14h", "14h30", "9:30"
    m = re.match(r"(\d{1,2})[h:](\d{2})?$", raw)
    if m:
        hour = int(m.group(1))
        minute = int(m.group(2)) if m.group(2) else 0
        dt = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        # If the time already passed today, schedule for tomorrow
        if dt <= now:
            dt += timedelta(days=1)
        return dt

    return None


class CreateReminderTool(Tool):
    name = "create_reminder"
    description = (
        "Create a scheduled reminder. The `time` parameter MUST be in ISO 8601 format "
        "(e.g. '2026-04-12T14:00:00-03:00') or a simple time like '14:00'. "
        "Convert any natural-language time the user says into one of these formats "
        "before calling this tool. The timezone is America/Sao_Paulo (UTC-3). "
        "Use `recurring` for repeating reminders: 'daily', 'weekly', or 'hourly'."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "message": {
                "type": "string",
                "description": "What to remind the user about",
            },
            "time": {
                "type": "string",
                "description": (
                    "When to fire the reminder. ISO 8601 (e.g. '2026-04-12T14:00:00-03:00') "
                    "or simple time ('14:00', '14h30', 'em 30 minutos')."
                ),
            },
            "recurring": {
                "type": "string",
                "enum": ["daily", "weekly", "hourly"],
                "description": "Optional. Set for repeating reminders.",
            },
        },
        "required": ["message", "time"],
    }
    requires_confirmation = False
    category = "other"

    def __init__(self, scheduler: Any) -> None:
        self._scheduler = scheduler

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        message = args.get("message", "").strip()
        time_raw = args.get("time", "").strip()
        recurring = args.get("recurring") or None

        if not message:
            return ToolResult(ok=False, error="message is required")
        if not time_raw:
            return ToolResult(ok=False, error="time is required")

        fire_at = _parse_time(time_raw)
        if fire_at is None:
            return ToolResult(
                ok=False,
                error=f"Could not parse time: '{time_raw}'. Use ISO 8601 or 'HH:MM'.",
            )

        try:
            rid = self._scheduler.add_reminder(
                fire_at=fire_at,
                message=message,
                recurring=recurring,
            )
        except Exception as e:
            logger.exception("Failed to create reminder")
            return ToolResult(ok=False, error=str(e))

        return ToolResult(
            ok=True,
            output=(
                f"Lembrete criado (id={rid}). "
                f"Dispara em {fire_at.strftime('%d/%m/%Y %H:%M')} "
                f"(America/Sao_Paulo)"
                + (f", recorrente: {recurring}" if recurring else "")
                + "."
            ),
        )


class ListRemindersTool(Tool):
    name = "list_reminders"
    description = "List all scheduled reminders with their ID, time, and message."
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {},
    }
    requires_confirmation = False
    category = "other"

    def __init__(self, scheduler: Any) -> None:
        self._scheduler = scheduler

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        try:
            reminders = self._scheduler.list_reminders()
        except Exception as e:
            return ToolResult(ok=False, error=str(e))

        if not reminders:
            return ToolResult(ok=True, output="Nenhum lembrete agendado.")

        lines = []
        for r in reminders:
            line = f"- ID: {r['id']}, Mensagem: {r['message']}"
            if r.get("next_run"):
                line += f", Proximo disparo: {r['next_run']}"
            if r.get("recurring"):
                line += f", Recorrente: {r['recurring']}"
            lines.append(line)
        return ToolResult(ok=True, output="\n".join(lines))


class CancelReminderTool(Tool):
    name = "cancel_reminder"
    description = "Cancel a scheduled reminder by its ID."
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "reminder_id": {
                "type": "string",
                "description": "The ID of the reminder to cancel",
            },
        },
        "required": ["reminder_id"],
    }
    requires_confirmation = False
    category = "other"

    def __init__(self, scheduler: Any) -> None:
        self._scheduler = scheduler

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        rid = args.get("reminder_id", "").strip()
        if not rid:
            return ToolResult(ok=False, error="reminder_id is required")

        ok = self._scheduler.cancel_reminder(rid)
        if ok:
            return ToolResult(ok=True, output=f"Lembrete {rid} cancelado.")
        return ToolResult(ok=False, error=f"Lembrete {rid} nao encontrado.")
