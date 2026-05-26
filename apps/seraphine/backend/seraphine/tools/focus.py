"""Chat tools for focus -- query focus session statistics via LLM tool-calling."""

from __future__ import annotations

import logging
from typing import Any

from seraphine.focus.service import FocusService
from seraphine.tools.base import Tool, ToolResult

logger = logging.getLogger(__name__)


class GetFocusStatsTool(Tool):
    """Show focus session statistics for a period."""

    name = "get_focus_stats"
    description = (
        "Mostra estatisticas de foco do periodo (semana ou mes). Use quando "
        "o usuario perguntar 'como ta meu foco?', 'quantas sessoes fiz?', "
        "'estatisticas de foco', 'quanto tempo foquei essa semana', "
        "'meu streak de foco'."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "period": {
                "type": "string",
                "enum": ["week", "month"],
                "description": "Period to aggregate: 'week' (last 7 days) or 'month' (current month).",
            },
        },
        "required": [],
    }
    requires_confirmation = False
    category = "other"

    def __init__(self, focus_service: FocusService) -> None:
        self._svc = focus_service

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        period = str(args.get("period") or "week").strip()
        if period not in ("week", "month"):
            period = "week"

        try:
            stats = await self._svc.get_stats(period)
        except Exception as exc:
            logger.exception("get_focus_stats tool failed")
            return ToolResult(ok=False, error=str(exc))

        period_label = "semana" if period == "week" else "mes"
        total_sessions = stats.completed_sessions + stats.cancelled_sessions

        lines = [
            f"Foco ({period_label}):",
            f"- Tempo total: {stats.total_focus_min} min",
            f"- Sessoes completas: {stats.completed_sessions}/{total_sessions}",
            f"- Media por sessao: {stats.avg_session_min:.0f} min",
            f"- Streak: {stats.streak_days} dia(s)",
        ]
        if stats.interruption_rate > 0:
            lines.append(f"- Taxa de interrupcao: {stats.interruption_rate:.1%}")

        text = "\n".join(lines)
        return ToolResult(
            ok=True,
            output=text,
            metadata={"stats": stats.to_dict(), "period": period},
        )
