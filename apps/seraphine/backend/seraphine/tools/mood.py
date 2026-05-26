"""Chat tools for mood -- log check-ins and query trends via LLM tool-calling."""

from __future__ import annotations

import logging
from typing import Any

from seraphine.mood.service import MoodService
from seraphine.tools.base import Tool, ToolResult

logger = logging.getLogger(__name__)


class LogMoodTool(Tool):
    """Register the user's current mood."""

    name = "log_mood"
    description = (
        "Registra o humor atual do usuario. Use quando ele disser como esta "
        "se sentindo -- ex: 'to feliz', 'me sinto ansioso', 'estou cansado', "
        "'humor otimo hoje'. O label deve ser uma palavra simples descrevendo "
        "o humor (feliz, triste, ansioso, cansado, motivado, neutro, etc)."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "label": {
                "type": "string",
                "description": (
                    "Mood label -- a single word describing the mood "
                    "(e.g. feliz, triste, ansioso, cansado, motivado, neutro)."
                ),
            },
        },
        "required": ["label"],
    }
    requires_confirmation = False
    category = "other"

    def __init__(self, mood_service: MoodService) -> None:
        self._svc = mood_service

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        label = str(args.get("label") or "").strip()
        if not label:
            return ToolResult(ok=False, error="label is required")

        try:
            log = await self._svc.checkin(label)
        except ValueError as exc:
            return ToolResult(ok=False, error=str(exc))
        except Exception as exc:
            logger.exception("log_mood tool failed")
            return ToolResult(ok=False, error=str(exc))

        return ToolResult(
            ok=True,
            output=f"Humor registrado: {log.label} (valence={log.valence}, arousal={log.arousal}).",
            metadata={"mood_log": log.to_dict()},
        )


class GetMoodTrendTool(Tool):
    """Show mood trend over the last N days."""

    name = "get_mood_trend"
    description = (
        "Mostra a tendencia de humor dos ultimos N dias. Use quando o "
        "usuario perguntar 'como tem sido meu humor?', 'tendencia de humor', "
        "'meu humor essa semana', 'como estive nos ultimos dias'."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "days": {
                "type": "integer",
                "minimum": 1,
                "maximum": 365,
                "description": "Number of days to look back (default 7).",
            },
        },
        "required": [],
    }
    requires_confirmation = False
    category = "other"

    def __init__(self, mood_service: MoodService) -> None:
        self._svc = mood_service

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        try:
            days = int(args.get("days") or 7)
        except (TypeError, ValueError):
            days = 7

        try:
            trend = await self._svc.get_trend(days)
        except ValueError as exc:
            return ToolResult(ok=False, error=str(exc))
        except Exception as exc:
            logger.exception("get_mood_trend tool failed")
            return ToolResult(ok=False, error=str(exc))

        day_entries = trend.get("days", [])
        if not day_entries:
            return ToolResult(
                ok=True,
                output=f"Nenhum registro de humor nos ultimos {days} dias.",
                metadata={"trend": trend},
            )

        lines: list[str] = []
        for d in day_entries:
            lines.append(
                f"- {d['date']}: {d['predominant_label']} "
                f"(valence={d['avg_valence']}, {d['count']} registro(s))"
            )

        text = f"Tendencia de humor ({days} dias, {len(day_entries)} com dados):\n" + "\n".join(lines)
        return ToolResult(
            ok=True,
            output=text,
            metadata={"trend": trend},
        )
