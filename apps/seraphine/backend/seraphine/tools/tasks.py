"""Task tools — lets the LLM create/manage tasks with rich HTML cards."""

from __future__ import annotations

import html as _html
import logging
from typing import Any

from seraphine.tools.base import Tool, ToolResult
from seraphine.tools.svg_icons import (
    ALERT_TRIANGLE,
    CHECK_CIRCLE,
    CIRCLE,
    CLIPBOARD,
    CLOCK,
)

logger = logging.getLogger(__name__)

_STATUS_LABELS: dict[str, tuple[str, str]] = {
    # status -> (label, icon)
    "pending": ("Pendente", CIRCLE),
    "approved": ("Em andamento", CLOCK),
    "completed": ("Concluido", CHECK_CIRCLE),
    "rejected": ("Descartado", CIRCLE),
    "failed": ("Falhou", ALERT_TRIANGLE),
}

_PRIORITY_LABELS: dict[str, str] = {
    "low": "Baixa",
    "med": "Media",
    "high": "Alta",
}


def _build_task_card(
    *,
    title: str,
    status: str,
    due_date: str | None = None,
    due_time: str | None = None,
    priority: str | None = None,
) -> str:
    """Build an HTML card for a task using the rich-card design system."""
    safe_title = _html.escape(title)
    label, _status_icon = _STATUS_LABELS.get(status, ("Pendente", CIRCLE))
    icon = CLIPBOARD

    meta_parts: list[str] = [label]
    if priority and priority in _PRIORITY_LABELS:
        meta_parts.append(f"Prioridade {_PRIORITY_LABELS[priority]}")
    if due_date:
        # Format as DD/MM
        if len(due_date) >= 10:
            date_str = f"{due_date[8:10]}/{due_date[5:7]}"
        else:
            date_str = due_date
        if due_time:
            date_str += f" {due_time}"
        meta_parts.append(date_str)

    meta_str = " &middot; ".join(meta_parts)

    return (
        '<!--card--><div class="rich-card rich-card--tasks">'
        '  <div class="rich-card__item">'
        f'    <div class="rich-card__item-icon rich-card__icon--tasks">{icon}</div>'
        f'    <div class="rich-card__item-body">'
        f'      <div class="rich-card__item-title">{safe_title}</div>'
        f'      <div class="rich-card__item-meta">{meta_str}</div>'
        f'    </div>'
        f'  </div>'
        f'</div><!--/card-->'
    )


class CreateTaskTool(Tool):
    """Create a task in Seraphine's internal task system."""

    name = "create_task"
    description = (
        "Create a task/to-do item in Seraphine's Kanban board. Use this "
        "whenever the user asks you to create a task, reminder-like to-do, "
        "or actionable item they want to track. The task will appear in "
        "the Kanban view under 'Pendentes'."
    )
    json_schema = {
        "type": "object",
        "properties": {
            "title": {
                "type": "string",
                "description": "Short title for the task.",
            },
            "description": {
                "type": "string",
                "description": "Optional longer description or notes.",
            },
            "due_date": {
                "type": "string",
                "description": "Optional deadline in YYYY-MM-DD format.",
            },
            "due_time": {
                "type": "string",
                "description": "Optional time in HH:MM (24h) format.",
            },
            "priority": {
                "type": "string",
                "enum": ["low", "med", "high"],
                "description": "Optional priority level.",
            },
        },
        "required": ["title"],
    }
    requires_confirmation = False
    category = "meta"

    def __init__(self, task_service: Any) -> None:
        self._svc = task_service

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        title = str(args.get("title", "")).strip()
        if not title:
            return ToolResult(ok=False, error="title is required")

        description = str(args.get("description") or "").strip()
        due_date = args.get("due_date") or None
        due_time = args.get("due_time") or None
        priority = args.get("priority") or None

        try:
            task_id = await self._svc.create_task(
                type="generic",
                title=title,
                description=description,
                source="chat",
                payload={},
                due_date=due_date,
                due_time=due_time,
                priority=priority,
            )
        except Exception as exc:
            logger.exception("create_task tool failed")
            return ToolResult(ok=False, error=str(exc))

        card_html = _build_task_card(
            title=title,
            status="pending",
            due_date=due_date,
            due_time=due_time,
            priority=priority,
        )

        parts = [f"Tarefa criada: {title}"]
        if due_date:
            parts.append(f"Entrega: {due_date}")
        if priority:
            parts.append(f"Prioridade: {_PRIORITY_LABELS.get(priority, priority)}")

        return ToolResult(
            ok=True,
            output=". ".join(parts) + ".",
            metadata={"task_id": task_id, "html_card": card_html},
        )
