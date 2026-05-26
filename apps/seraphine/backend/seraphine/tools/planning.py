"""Chat tools for planning -- generate daily plan via LLM tool-calling."""

from __future__ import annotations

import logging
from typing import Any

from seraphine.planning.service import PlanningService
from seraphine.tools.base import Tool, ToolResult

logger = logging.getLogger(__name__)


class GeneratePlanTool(Tool):
    """Generate the daily plan."""

    name = "generate_plan"
    description = (
        "Gera o plano do dia com blocos de tempo, prioridades e alertas. "
        "Use quando o usuario perguntar 'qual o plano de hoje?', 'organiza "
        "meu dia', 'gera meu plano', 'o que tenho pra fazer hoje?', "
        "'monta minha agenda'."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {},
        "required": [],
    }
    requires_confirmation = False
    category = "other"

    def __init__(self, planning_service: PlanningService) -> None:
        self._svc = planning_service

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        try:
            plan = await self._svc.generate_plan()
        except Exception as exc:
            logger.exception("generate_plan tool failed")
            return ToolResult(ok=False, error=str(exc))

        blocks = plan.time_blocks
        priorities = plan.priorities
        ctx = plan.context

        lines: list[str] = []

        # Context summary
        ctx_parts: list[str] = []
        if ctx.sleep_hours is not None:
            ctx_parts.append(f"sono: {ctx.sleep_hours}h")
        ctx_parts.append(f"energia: {ctx.energy_estimate}")
        ctx_parts.append(f"{ctx.meetings_count} reuniao(oes)")
        ctx_parts.append(f"{ctx.free_slots_min} min livres")
        lines.append("Contexto: " + ", ".join(ctx_parts))

        # Priorities
        if priorities:
            lines.append(f"\nPrioridades ({len(priorities)}):")
            for p in priorities:
                prio_str = f" [{p['priority']}]" if p.get("priority") else ""
                lines.append(f"  - {p['title']}{prio_str}")

        # Time blocks
        if blocks:
            lines.append(f"\nBlocos ({len(blocks)}):")
            for b in blocks:
                reason_str = f" -- {b.reason}" if b.reason else ""
                lines.append(f"  {b.start}-{b.end} [{b.type}] {b.title}{reason_str}")

        # At-risk alerts
        at_risk = plan.at_risk
        habits_risk = at_risk.get("habits", [])
        goals_risk = at_risk.get("goals", [])
        if habits_risk or goals_risk:
            lines.append("\nAlertas:")
            for h in habits_risk:
                lines.append(
                    f"  - Habito em risco: {h['title']} (streak: {h['current_streak']})"
                )
            for g in goals_risk:
                lines.append(
                    f"  - Goal em risco: {g['title']} ({g['progress']:.0f}%)"
                )

        text = "\n".join(lines)
        return ToolResult(
            ok=True,
            output=text,
            metadata={"plan": plan.to_dict()},
        )
