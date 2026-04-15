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
    tasks: list[dict[str, str | None]] | None = None,
    title: str = "",
    task_id: str | int | None = None,
    status: str = "pending",
    due_date: str | None = None,
    due_time: str | None = None,
    priority: str | None = None,
) -> str:
    """Build an Aura-style HTML card for task(s).

    Accepts either a list of task dicts (batch) or a single task via
    the title/task_id/status/due_date/due_time/priority params.
    """
    if tasks is None:
        tasks = [
            {
                "title": title,
                "task_id": str(task_id) if task_id is not None else "",
                "status": status,
                "due_date": due_date,
                "due_time": due_time,
                "priority": priority,
            }
        ]

    count = len(tasks)
    count_label = f"{count} tarefa{'s' if count != 1 else ''}"

    # --- header ---
    header = (
        '<div class="task-chat-card__header">'
        f'  <div class="rich-card__icon rich-card__icon--tasks">{CLIPBOARD}</div>'
        '  <div>'
        '    <div class="rich-card__title">Tarefas</div>'
        f'    <div class="rich-card__subtitle">{count_label}</div>'
        '  </div>'
        '</div>'
    )

    # --- group tasks by date label ---
    from datetime import date as _date  # noqa: WPS433 (local import ok)

    def _date_label(d: str | None) -> str:
        if not d or len(d) < 10:
            return ""
        try:
            parsed = _date.fromisoformat(d[:10])
        except ValueError:
            return d
        if parsed == _date.today():
            return "HOJE"
        return f"{parsed.day:02d}/{parsed.month:02d}"

    # Build items HTML
    items_html = ""
    current_group = object()
    for t in tasks:
        t_title = _html.escape(str(t.get("title") or ""))
        t_status = str(t.get("status") or "pending")
        t_id = str(t.get("task_id") or "")
        t_due_date = t.get("due_date")
        t_due_time = t.get("due_time")

        # Date group label
        group = _date_label(t_due_date)  # type: ignore[arg-type]
        if group and group != current_group:
            current_group = group
            items_html += (
                f'<div class="task-chat-card__date-group">{group}</div>'
            )

        # Status icon
        is_done = t_status == "completed"
        status_icon = CHECK_CIRCLE if is_done else CIRCLE
        next_status = "pending" if is_done else "completed"
        strike = " task-chat-card__title--done" if is_done else ""

        # Time display
        time_html = ""
        if t_due_time:
            time_html = (
                f'<span class="task-chat-card__time">'
                f'{CLOCK} {_html.escape(str(t_due_time))}'
                f'</span>'
            )

        items_html += (
            f'<div class="task-chat-card__item">'
            f'  <span class="task-chat-card__toggle"'
            f'    data-task-id="{_html.escape(t_id)}"'
            f'    data-action="toggle-status"'
            f'    data-current-status="{_html.escape(t_status)}"'
            f'    data-next-status="{next_status}">'
            f'    {status_icon}'
            f'  </span>'
            f'  <span class="task-chat-card__title{strike}">{t_title}</span>'
            f'  {time_html}'
            f'</div>'
        )

    return (
        f'<!--card--><div class="rich-card rich-card--tasks task-chat-card">'
        f'{header}{items_html}'
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
            task_id=task_id,
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
