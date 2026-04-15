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

    name = "add_task"
    description = (
        "Create a task/to-do item in Seraphine's internal Kanban board AND calendar. "
        "ALWAYS prefer this over reminders and over any MCP/Supertasks tool. Use when "
        "the user wants to do something, schedule something, track something, or asks "
        "you to remind them about something. The task shows up as an interactive "
        "card in the chat with toggleable status. "
        "Triggers: 'preciso', 'tenho que', 'lembrar', 'agendar', 'marcar', "
        "'fazer', 'cobrar', 'levar', 'comprar', 'ligar', 'pagar', 'enviar'."
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
            metadata={
                "task_id": task_id,
                "task": {
                    "id": task_id,
                    "title": title,
                    "status": "pending",
                    "due_date": due_date,
                    "due_time": due_time,
                    "priority": priority,
                    "description": description,
                },
                "html_card": card_html,
            },
        )


class UpdateTaskTool(Tool):
    """Update an existing task."""

    name = "update_task"
    description = (
        "Update an existing task by its ID. Use when the user asks to change, "
        "edit, reschedule, or modify a task that was already created. You can "
        "update the title, description, due_date, due_time, priority, or status. "
        "The task_id comes from the add_task tool result or from context. "
        "When the user says 'muda pra amanhã', 'troca o horário', 'cancela', "
        "'já fiz', 'concluir', use this tool on the task from the conversation."
    )
    json_schema = {
        "type": "object",
        "properties": {
            "task_id": {
                "type": "integer",
                "description": "ID of the task to update (from add_task result).",
            },
            "title": {
                "type": "string",
                "description": "New title (omit to keep current).",
            },
            "description": {
                "type": "string",
                "description": "New description (omit to keep current).",
            },
            "due_date": {
                "type": "string",
                "description": "New date in YYYY-MM-DD (empty string clears it).",
            },
            "due_time": {
                "type": "string",
                "description": "New time in HH:MM (empty string clears it).",
            },
            "priority": {
                "type": "string",
                "enum": ["low", "med", "high", ""],
                "description": "New priority (empty string clears it).",
            },
            "status": {
                "type": "string",
                "enum": ["pending", "approved", "completed", "rejected"],
                "description": "New status.",
            },
        },
        "required": ["task_id"],
    }
    requires_confirmation = False
    category = "meta"

    def __init__(self, task_service: Any) -> None:
        self._svc = task_service

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        task_id = args.get("task_id")
        if task_id is None:
            return ToolResult(ok=False, error="task_id is required")

        kwargs: dict[str, Any] = {}
        for field in ("title", "description", "status", "priority"):
            if field in args and args[field] is not None:
                val = args[field]
                if field == "priority" and val == "":
                    kwargs["unset_priority"] = True
                else:
                    kwargs[field] = val

        if "due_date" in args:
            val = args["due_date"]
            if val == "" or val is None:
                kwargs["unset_due_date"] = True
            else:
                kwargs["due_date"] = val

        if "due_time" in args:
            val = args["due_time"]
            if val == "" or val is None:
                kwargs["unset_due_time"] = True
            else:
                kwargs["due_time"] = val

        if not kwargs:
            return ToolResult(ok=False, error="No fields to update.")

        try:
            await self._svc.update_task(int(task_id), **kwargs)
            task = await self._svc.get_task(int(task_id))
        except Exception as exc:
            logger.exception("update_task tool failed")
            return ToolResult(ok=False, error=str(exc))

        if task is None:
            return ToolResult(ok=False, error=f"Task {task_id} not found.")

        card_html = _build_task_card(
            title=task.title,
            task_id=task.id,
            status=task.status,
            due_date=task.due_date,
            due_time=task.due_time,
            priority=task.priority,
        )

        return ToolResult(
            ok=True,
            output=f"Tarefa #{task_id} atualizada: {task.title}.",
            metadata={
                "task_id": task_id,
                "task": {
                    "id": task.id,
                    "title": task.title,
                    "status": task.status,
                    "due_date": task.due_date,
                    "due_time": task.due_time,
                    "priority": task.priority,
                    "description": task.description,
                },
                "html_card": card_html,
            },
        )
