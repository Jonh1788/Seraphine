"""LLM tool for creating recurring task rules."""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from seraphine.recurring.service import RecurringService
from seraphine.tools.base import Tool, ToolResult
from seraphine.tools.cards import text as _esc
from seraphine.tools.svg_icons import CALENDAR_DAYS, REPEAT

logger = logging.getLogger(__name__)

SP_TZ = ZoneInfo("America/Sao_Paulo")

_WEEKDAY_NAMES = [
    "Monday", "Tuesday", "Wednesday", "Thursday",
    "Friday", "Saturday", "Sunday",
]

_FREQUENCY_LABELS = {
    "daily": "Daily",
    "weekly": "Weekly",
    "monthly": "Monthly",
}


def _build_schedule_text(
    frequency: str,
    weekday: int | None,
    day_of_month: int | None,
    time: str | None,
    end_date: str | None = None,
) -> str:
    """Human-readable schedule summary."""
    parts: list[str] = []
    if frequency == "daily":
        parts.append("Every day")
    elif frequency == "weekly" and weekday is not None:
        parts.append(f"Every {_WEEKDAY_NAMES[weekday]}")
    elif frequency == "monthly" and day_of_month is not None:
        parts.append(f"Every month, day {day_of_month}")
    else:
        parts.append(_FREQUENCY_LABELS.get(frequency, frequency))
    if time:
        parts.append(f"at {time}")
    if end_date:
        parts.append(f"until {end_date}")
    return " ".join(parts)


_REMIND_LABELS = {
    "at_time": "no horário",
    "1h_before": "1h antes",
}


def _remind_sentence(remind: str | None) -> str:
    """Frase que vai no `output` da tool. Vazia quando não há lembrete."""
    if not remind:
        return ""
    label = _REMIND_LABELS.get(remind, remind)
    return f" Com lembrete {label}."


def _build_card_html(
    title: str,
    description: str | None,
    frequency: str,
    weekday: int | None,
    day_of_month: int | None,
    time: str | None,
    materialized_today: bool,
    end_date: str | None = None,
) -> str:
    schedule = _build_schedule_text(
        frequency, weekday, day_of_month, time, end_date,
    )
    freq_label = _FREQUENCY_LABELS.get(frequency, frequency)

    html = (
        '<!--card--><div class="rich-card rich-card--finance">'
        '  <div class="rich-card__header">'
        f'    <div class="rich-card__icon">{REPEAT}</div>'
        '    <div>'
        f'      <div class="rich-card__title">{_esc(title)}</div>'
        f'      <div class="rich-card__subtitle">{_esc(schedule)}</div>'
        '    </div>'
        '  </div>'
        '  <div class="rich-card__stats">'
        '    <div class="rich-card__stat">'
        '      <div class="rich-card__stat-label">Frequency</div>'
        f'      <div class="rich-card__stat-value">{_esc(freq_label)}</div>'
        '    </div>'
    )
    if time:
        html += (
            '    <div class="rich-card__stat">'
            '      <div class="rich-card__stat-label">Time</div>'
            f'      <div class="rich-card__stat-value">{_esc(time)}</div>'
            '    </div>'
        )
    if frequency == "weekly" and weekday is not None:
        html += (
            '    <div class="rich-card__stat">'
            '      <div class="rich-card__stat-label">Day</div>'
            f'      <div class="rich-card__stat-value">{_WEEKDAY_NAMES[weekday]}</div>'
            '    </div>'
        )
    if frequency == "monthly" and day_of_month is not None:
        html += (
            '    <div class="rich-card__stat">'
            '      <div class="rich-card__stat-label">Day of month</div>'
            f'      <div class="rich-card__stat-value">{_esc(day_of_month)}</div>'
            '    </div>'
        )
    if end_date:
        html += (
            '    <div class="rich-card__stat">'
            '      <div class="rich-card__stat-label">Until</div>'
            f'      <div class="rich-card__stat-value">{_esc(end_date)}</div>'
            '    </div>'
        )
    html += '  </div>'

    if description:
        html += (
            f'<hr class="rich-card__divider">'
            f'<div class="rich-card__section">{_esc(description)}</div>'
        )

    if materialized_today:
        html += (
            f'<hr class="rich-card__divider">'
            f'<div class="rich-card__item">'
            f'  <div class="rich-card__item-icon">{CALENDAR_DAYS}</div>'
            f'  <div class="rich-card__item-body">'
            f'    <div class="rich-card__item-title">Today\'s task created</div>'
            f'  </div>'
            f'</div>'
        )

    html += '</div><!--/card-->'
    return html


class CreateRecurringTaskTool(Tool):
    name = "create_recurring_task"
    description = (
        "Create a recurring task rule (daily, weekly, or monthly). "
        "Use when the user describes something that repeats over time, "
        "e.g. 'take out the trash every Monday at 10:00', 'every day take "
        "medicine at 8am', 'every month on the 5th pay rent'. Convert "
        "weekdays to weekday numbers: Monday=0, Tuesday=1, Wednesday=2, "
        "Thursday=3, Friday=4, Saturday=5, Sunday=6. OMIT weekday for "
        "daily/monthly rules and day_of_month for daily/weekly rules — never "
        "pass a placeholder like -1 or 0. When the user bounds the habit in "
        "time ('por 20 dias', 'até sexta', 'nesse mês'), ALWAYS pass end_date "
        "— otherwise the rule fires forever. If today matches the rule, a "
        "task is materialized immediately. To change or remove an existing "
        "rule use update_recurring_task / delete_recurring_task; do NOT "
        "create a second rule for the same thing."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "title": {
                "type": "string",
                "description": "Short title for the recurring task",
            },
            "frequency": {
                "type": "string",
                "enum": ["daily", "weekly", "monthly"],
                "description": "How often the task repeats",
            },
            "weekday": {
                "type": "integer",
                "minimum": 0,
                "maximum": 6,
                "description": (
                    "Day of week (0=Monday..6=Sunday). Required for weekly. "
                    "Omit entirely for daily and monthly."
                ),
            },
            "day_of_month": {
                "type": "integer",
                "minimum": 1,
                "maximum": 31,
                "description": (
                    "Day of month (1..31). Required for monthly. "
                    "Omit entirely for daily and weekly."
                ),
            },
            "time": {
                "type": "string",
                "description": "Time in HH:MM 24h format (optional)",
            },
            "end_date": {
                "type": "string",
                "description": (
                    "Last day the rule fires, inclusive, in YYYY-MM-DD. Use "
                    "for time-boxed habits ('20 dias', 'até o fim do mês'). "
                    "Omit for an open-ended rule."
                ),
            },
            "description": {
                "type": "string",
                "description": "Optional longer description",
            },
            "remind": {
                "type": "string",
                "enum": ["at_time", "1h_before", ""],
                "description": (
                    "When to notify. Omit for the default (at_time when there "
                    "is a time). Empty string turns the reminder off. A "
                    "recurring rule cannot remind a day early: each occurrence "
                    "is created on its own due date, so '1d_before' would "
                    "already be in the past — use it only in add_task."
                ),
            },
        },
        "required": ["title", "frequency"],
    }
    requires_confirmation = False
    category = "other"

    def __init__(self, recurring_service: RecurringService) -> None:
        self._recurring = recurring_service

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        title = (args.get("title") or "").strip()
        if not title:
            return ToolResult(ok=False, error="title is required")

        frequency = (args.get("frequency") or "").strip()
        weekday = args.get("weekday")
        day_of_month = args.get("day_of_month")
        time_val = args.get("time")
        description = args.get("description")
        end_date = args.get("end_date")

        try:
            rule = await self._recurring.create(
                title=title,
                frequency=frequency,
                weekday=weekday,
                day_of_month=day_of_month,
                time=time_val,
                description=description,
                end_date=end_date,
                remind=args.get("remind"),
            )
        except ValueError as exc:
            return ToolResult(ok=False, error=str(exc))

        # The service drops fields the frequency doesn't use; render the card
        # from the stored rule so it never echoes a sentinel back at the user.
        weekday = rule.weekday
        day_of_month = rule.day_of_month
        end_date = rule.end_date

        # Materialize today if applicable
        materialized_today = False
        try:
            task_id = await self._recurring.materialize_for_rule_if_due(
                rule, datetime.now(SP_TZ),
            )
            if task_id is not None:
                materialized_today = True
        except Exception:
            logger.exception("create_recurring_task: immediate materialize failed")

        schedule = _build_schedule_text(
            frequency, weekday, day_of_month, time_val, end_date,
        )
        card_html = _build_card_html(
            title=title,
            description=description,
            frequency=frequency,
            weekday=weekday,
            day_of_month=day_of_month,
            time=time_val,
            materialized_today=materialized_today,
            end_date=end_date,
        )

        # rule_id belongs in `output`, not just metadata: the engine forwards
        # only output/error to the model, so without it a follow-up "muda pra
        # 19h" has nothing to target and the model creates a duplicate rule.
        text = (
            f"Recurring task created: \"{title}\" -- {schedule}."
            f" rule_id={rule.id}"
        )
        # O modelo só lê `output`; sem esta frase ele não tem como dizer ao
        # usuário que a regra vai de fato avisar (ou que não vai).
        text += _remind_sentence(rule.remind)
        if materialized_today:
            text += " Today's occurrence has been created."

        meta: dict[str, Any] = {
            "recurring": rule.to_dict(),
            "materialized_today": materialized_today,
            "html_card": card_html,
        }
        if materialized_today and task_id is not None:
            today_str = datetime.now(SP_TZ).date().isoformat()
            meta["task"] = {
                "id": task_id,
                "title": title,
                "status": "pending",
                "due_date": today_str,
                "due_time": time_val,
                "priority": None,
                "description": description,
            }

        return ToolResult(
            ok=True,
            output=text,
            metadata=meta,
        )


def _rule_line(rule: Any) -> str:
    """One-line rendering that carries the id, so a follow-up edit can
    target the rule without a second lookup."""
    schedule = _build_schedule_text(
        rule.frequency, rule.weekday, rule.day_of_month, rule.time,
        rule.end_date,
    )
    state = "active" if rule.active else "paused"
    # Sem esta marca, "esse aqui me avisa?" só teria resposta chutada.
    alarm = (
        f" · com lembrete {_REMIND_LABELS.get(rule.remind, rule.remind)}"
        if rule.remind
        else ""
    )
    return f"- {rule.title} — {schedule} [{state}]{alarm} rule_id={rule.id}"


class ListRecurringTasksTool(Tool):
    name = "list_recurring_tasks"
    description = (
        "List every recurring task rule with its rule_id, schedule and "
        "active/paused state. Call this BEFORE creating a recurring task the "
        "user might already have, and whenever the user asks to change, "
        "move, pause or remove a recurring reminder — the rule_id you get "
        "here is what update_recurring_task and delete_recurring_task need. "
        "Recurring rules do NOT show up in list_reminders."
    )
    json_schema: dict[str, Any] = {"type": "object", "properties": {}}
    requires_confirmation = False
    category = "other"

    def __init__(self, recurring_service: RecurringService) -> None:
        self._recurring = recurring_service

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        rules = await self._recurring.list_all()
        if not rules:
            return ToolResult(
                ok=True,
                output="No recurring task rules yet.",
                metadata={"recurring": []},
            )
        lines = "\n".join(_rule_line(r) for r in rules)
        return ToolResult(
            ok=True,
            output=f"{len(rules)} recurring rule(s):\n{lines}",
            metadata={"recurring": [r.to_dict() for r in rules]},
        )


class UpdateRecurringTaskTool(Tool):
    name = "update_recurring_task"
    description = (
        "Change an existing recurring task rule by its rule_id: its time, "
        "title, frequency, end date, or pause/resume it. Use this — never a "
        "second create_recurring_task — when the user says things like "
        "'muda o de 21 pra 19', 'troca o horário', 'para com esse lembrete', "
        "'deixa até sexta'. Pass remind to change whether it notifies "
        "('' silences it without deleting the rule). Get rule_id from "
        "list_recurring_tasks or from a previous create_recurring_task "
        "result. Only the fields you pass change; everything else is left "
        "alone."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "rule_id": {
                "type": "string",
                "description": "UUID of the rule (from list_recurring_tasks).",
            },
            "title": {"type": "string", "description": "New title."},
            "time": {
                "type": "string",
                "description": "New time in HH:MM 24h (empty string clears it).",
            },
            "frequency": {
                "type": "string",
                "enum": ["daily", "weekly", "monthly"],
                "description": (
                    "New frequency. Switching to weekly needs weekday; "
                    "switching to monthly needs day_of_month."
                ),
            },
            "weekday": {
                "type": "integer",
                "minimum": 0,
                "maximum": 6,
                "description": "New day of week (0=Monday..6=Sunday), weekly only.",
            },
            "day_of_month": {
                "type": "integer",
                "minimum": 1,
                "maximum": 31,
                "description": "New day of month (1..31), monthly only.",
            },
            "end_date": {
                "type": "string",
                "description": (
                    "New last day (YYYY-MM-DD, inclusive). Empty string "
                    "removes the end date and makes the rule open-ended."
                ),
            },
            "description": {"type": "string", "description": "New description."},
            "remind": {
                "type": "string",
                "enum": ["at_time", "1h_before", ""],
                "description": (
                    "When to notify. Omit to leave the reminder as it is. "
                    "Empty string turns it off. A recurring rule cannot remind "
                    "a day early: each occurrence is created on its own due "
                    "date, so '1d_before' would already be in the past — use "
                    "it only in update_task."
                ),
            },
            "active": {
                "type": "boolean",
                "description": "false pauses the rule, true resumes it.",
            },
        },
        "required": ["rule_id"],
    }
    requires_confirmation = False
    category = "other"

    def __init__(self, recurring_service: RecurringService) -> None:
        self._recurring = recurring_service

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        rule_id = (args.get("rule_id") or "").strip()
        if not rule_id:
            return ToolResult(ok=False, error="rule_id is required")

        kwargs: dict[str, Any] = {}
        if args.get("title") is not None:
            kwargs["title"] = args["title"]
        if args.get("active") is not None:
            kwargs["active"] = bool(args["active"])
        if args.get("frequency") is not None:
            kwargs["frequency"] = (args["frequency"] or "").strip()
        # Empty string is a deliberate "clear this field" from the model, so
        # these three go through the _provided flags rather than a None check.
        if "time" in args:
            kwargs["time"] = args["time"] or None
            kwargs["_time_provided"] = True
        if "end_date" in args:
            kwargs["end_date"] = args["end_date"] or None
            kwargs["_end_date_provided"] = True
        if "description" in args:
            kwargs["description"] = args["description"]
            kwargs["_description_provided"] = True
        if "weekday" in args:
            kwargs["weekday"] = args["weekday"]
            kwargs["_weekday_provided"] = True
        if "day_of_month" in args:
            kwargs["day_of_month"] = args["day_of_month"]
            kwargs["_day_of_month_provided"] = True
        # `update` não deduz lembrete de horário nenhum: se o campo não vier
        # aqui explicitamente, a regra fica com o lembrete que já tinha.
        if "remind" in args:
            kwargs["remind"] = args["remind"] or None
            kwargs["_remind_provided"] = True

        if not kwargs:
            return ToolResult(ok=False, error="No fields to update.")

        try:
            rule = await self._recurring.update(rule_id, **kwargs)
        except ValueError as exc:
            return ToolResult(ok=False, error=str(exc))
        if rule is None:
            return ToolResult(ok=False, error=f"Rule {rule_id} not found.")

        schedule = _build_schedule_text(
            rule.frequency, rule.weekday, rule.day_of_month, rule.time,
            rule.end_date,
        )
        card_html = _build_card_html(
            title=rule.title,
            description=rule.description,
            frequency=rule.frequency,
            weekday=rule.weekday,
            day_of_month=rule.day_of_month,
            time=rule.time,
            materialized_today=False,
            end_date=rule.end_date,
        )
        state = "" if rule.active else " (paused)"
        return ToolResult(
            ok=True,
            output=(
                f"Recurring task updated: \"{rule.title}\" -- {schedule}"
                f"{state}. rule_id={rule.id}"
                f"{_remind_sentence(rule.remind)}"
            ),
            metadata={"recurring": rule.to_dict(), "html_card": card_html},
        )


class DeleteRecurringTaskTool(Tool):
    name = "delete_recurring_task"
    description = (
        "Permanently delete a recurring task rule by its rule_id. Use when "
        "the user says 'apaga esse lembrete recorrente', 'cancela de vez', or "
        "when you need to remove a duplicate rule you created by mistake. To "
        "merely stop it temporarily, prefer update_recurring_task with "
        "active=false. Get rule_id from list_recurring_tasks."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "rule_id": {
                "type": "string",
                "description": "UUID of the rule (from list_recurring_tasks).",
            },
        },
        "required": ["rule_id"],
    }
    requires_confirmation = False
    category = "other"

    def __init__(self, recurring_service: RecurringService) -> None:
        self._recurring = recurring_service

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        rule_id = (args.get("rule_id") or "").strip()
        if not rule_id:
            return ToolResult(ok=False, error="rule_id is required")

        rule = await self._recurring.get(rule_id)
        if rule is None:
            return ToolResult(ok=False, error=f"Rule {rule_id} not found.")

        affected = await self._recurring.delete(rule_id)
        if not affected:
            return ToolResult(ok=False, error=f"Rule {rule_id} not found.")
        return ToolResult(
            ok=True,
            output=f"Recurring rule deleted: \"{rule.title}\".",
            metadata={"deleted_id": rule_id},
        )
