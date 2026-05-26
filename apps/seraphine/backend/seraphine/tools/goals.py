"""Chat tools for goals -- create, list, and update progress via LLM tool-calling."""

from __future__ import annotations

import logging
from typing import Any

from seraphine.goals.service import GoalService
from seraphine.tools.base import Tool, ToolResult

logger = logging.getLogger(__name__)


_AREA_LABELS_PT = {
    "saude": "Saude",
    "carreira": "Carreira",
    "financas": "Financas",
    "pessoal": "Pessoal",
    "aprendizado": "Aprendizado",
    "relacionamentos": "Relacionamentos",
}

_TIMEFRAME_LABELS_PT = {
    "quarterly": "Trimestral",
    "yearly": "Anual",
    "open_ended": "Sem prazo",
}


class CreateGoalTool(Tool):
    """Create a new personal goal."""

    name = "create_goal"
    description = (
        "Create a new personal goal (OKR-style) for the user. Use when they "
        "say things like 'quero comecar a correr', 'meu objetivo e economizar "
        "10 mil', 'quero aprender ingles este ano', 'preciso melhorar minha "
        "saude', 'cria um goal de...'. Goals have an area (saude, carreira, "
        "financas, pessoal, aprendizado, relacionamentos) and a timeframe "
        "(quarterly, yearly, open_ended). Optionally set start/end dates."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "title": {
                "type": "string",
                "description": "Short title for the goal.",
            },
            "area": {
                "type": "string",
                "enum": [
                    "saude", "carreira", "financas",
                    "pessoal", "aprendizado", "relacionamentos",
                ],
                "description": "Life area this goal belongs to.",
            },
            "timeframe": {
                "type": "string",
                "enum": ["quarterly", "yearly", "open_ended"],
                "description": "Time horizon for the goal.",
            },
            "description": {
                "type": "string",
                "description": "Optional longer description of the goal.",
            },
            "start_date": {
                "type": "string",
                "description": "Optional start date (YYYY-MM-DD).",
            },
            "end_date": {
                "type": "string",
                "description": "Optional end/deadline date (YYYY-MM-DD).",
            },
        },
        "required": ["title", "area", "timeframe"],
    }
    requires_confirmation = False
    category = "other"

    def __init__(self, goal_service: GoalService) -> None:
        self._svc = goal_service

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        title = str(args.get("title") or "").strip()
        if not title:
            return ToolResult(ok=False, error="title is required")

        area = str(args.get("area") or "").strip()
        timeframe = str(args.get("timeframe") or "").strip()

        kwargs: dict[str, Any] = {
            "title": title,
            "area": area,
            "timeframe": timeframe,
        }
        if args.get("description"):
            kwargs["description"] = args["description"]
        if args.get("start_date"):
            kwargs["start_date"] = args["start_date"]
        if args.get("end_date"):
            kwargs["end_date"] = args["end_date"]

        try:
            goal = await self._svc.create_goal(**kwargs)
        except ValueError as exc:
            return ToolResult(ok=False, error=str(exc))
        except Exception as exc:
            logger.exception("create_goal tool failed")
            return ToolResult(ok=False, error=str(exc))

        area_label = _AREA_LABELS_PT.get(area, area)
        tf_label = _TIMEFRAME_LABELS_PT.get(timeframe, timeframe)
        text = f"Goal criado: \"{title}\" ({area_label}, {tf_label})."

        return ToolResult(
            ok=True,
            output=text,
            metadata={
                "goal_id": goal.id,
                "goal": goal.to_dict(),
            },
        )


class ListGoalsTool(Tool):
    """List the user's goals with progress."""

    name = "list_goals"
    description = (
        "List the user's personal goals with their progress. Use when "
        "they ask about their goals, objectives, OKRs, or want to see "
        "what they're working toward -- e.g. 'quais sao meus goals?', "
        "'como estao meus objetivos?', 'mostra meus goals de saude'."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "area": {
                "type": "string",
                "enum": [
                    "saude", "carreira", "financas",
                    "pessoal", "aprendizado", "relacionamentos",
                ],
                "description": "Optional filter by life area.",
            },
            "status": {
                "type": "string",
                "enum": ["active", "paused", "completed", "abandoned"],
                "description": "Optional filter by status (default: active).",
            },
        },
        "required": [],
    }
    requires_confirmation = False
    category = "other"

    def __init__(self, goal_service: GoalService) -> None:
        self._svc = goal_service

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        area = args.get("area")
        status = args.get("status")

        try:
            goals = await self._svc.list_goals(area=area, status=status)
        except Exception as exc:
            logger.exception("list_goals tool failed")
            return ToolResult(ok=False, error=str(exc))

        if not goals:
            filter_desc = ""
            if area:
                filter_desc += f" na area {_AREA_LABELS_PT.get(area, area)}"
            if status:
                filter_desc += f" com status {status}"
            return ToolResult(
                ok=True,
                output=f"Nenhum goal encontrado{filter_desc}.",
                metadata={"goals": []},
            )

        lines: list[str] = []
        for g in goals:
            progress_str = f"{g.progress:.0f}%"
            area_label = _AREA_LABELS_PT.get(g.area, g.area)
            lines.append(
                f"- {g.title} ({area_label}) — {progress_str} concluido"
            )

        text = f"{len(goals)} goal(s):\n" + "\n".join(lines)

        return ToolResult(
            ok=True,
            output=text,
            metadata={
                "goals": [g.to_dict() for g in goals],
            },
        )


class UpdateGoalProgressTool(Tool):
    """Update a key result's current value."""

    name = "update_goal_progress"
    description = (
        "Update the progress of a specific key result for a goal. Use "
        "when the user reports progress on a goal -- e.g. 'ja corri 50km "
        "este mes', 'economizei mais 500 reais', 'terminei o curso de X'. "
        "Requires the key_result_id and the new current_value."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "key_result_id": {
                "type": "string",
                "description": "The UUID of the key result to update.",
            },
            "current_value": {
                "type": "number",
                "description": "The new current value for the key result.",
            },
        },
        "required": ["key_result_id", "current_value"],
    }
    requires_confirmation = False
    category = "other"

    def __init__(self, goal_service: GoalService) -> None:
        self._svc = goal_service

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        kr_id = str(args.get("key_result_id") or "").strip()
        if not kr_id:
            return ToolResult(ok=False, error="key_result_id is required")

        current_value = args.get("current_value")
        if current_value is None:
            return ToolResult(ok=False, error="current_value is required")

        try:
            kr = await self._svc.update_key_result(
                kr_id, current_value=float(current_value),
            )
        except ValueError as exc:
            return ToolResult(ok=False, error=str(exc))
        except Exception as exc:
            logger.exception("update_goal_progress tool failed")
            return ToolResult(ok=False, error=str(exc))

        if kr is None:
            return ToolResult(ok=False, error="key result not found")

        text = (
            f"Key result \"{kr.title}\" atualizado: "
            f"{kr.current_value}/{kr.target_value}"
        )
        if kr.unit:
            text += f" {kr.unit}"
        text += f" ({kr.progress:.0f}%)."

        return ToolResult(
            ok=True,
            output=text,
            metadata={
                "key_result": kr.to_dict(),
            },
        )
