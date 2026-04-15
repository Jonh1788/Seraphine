"""LLM tool for creating recurring task rules."""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from seraphine.recurring.service import RecurringService
from seraphine.tools.base import Tool, ToolResult
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


def _build_schedule_text(frequency: str, weekday: int | None, day_of_month: int | None, time: str | None) -> str:
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
    return " ".join(parts)


def _build_card_html(
    title: str,
    description: str | None,
    frequency: str,
    weekday: int | None,
    day_of_month: int | None,
    time: str | None,
    materialized_today: bool,
) -> str:
    schedule = _build_schedule_text(frequency, weekday, day_of_month, time)
    freq_label = _FREQUENCY_LABELS.get(frequency, frequency)

    html = (
        '<!--card--><div class="rich-card rich-card--finance">'
        '  <div class="rich-card__header">'
        f'    <div class="rich-card__icon">{REPEAT}</div>'
        '    <div>'
        f'      <div class="rich-card__title">{title}</div>'
        f'      <div class="rich-card__subtitle">{schedule}</div>'
        '    </div>'
        '  </div>'
        '  <div class="rich-card__stats">'
        '    <div class="rich-card__stat">'
        '      <div class="rich-card__stat-label">Frequency</div>'
        f'      <div class="rich-card__stat-value">{freq_label}</div>'
        '    </div>'
    )
    if time:
        html += (
            '    <div class="rich-card__stat">'
            '      <div class="rich-card__stat-label">Time</div>'
            f'      <div class="rich-card__stat-value">{time}</div>'
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
            f'      <div class="rich-card__stat-value">{day_of_month}</div>'
            '    </div>'
        )
    html += '  </div>'

    if description:
        html += (
            f'<hr class="rich-card__divider">'
            f'<div class="rich-card__section">{description}</div>'
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
        "Thursday=3, Friday=4, Saturday=5, Sunday=6. If today matches "
        "the rule, a task is materialized immediately."
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
                "description": "Day of week (0=Monday..6=Sunday). Required for weekly.",
            },
            "day_of_month": {
                "type": "integer",
                "description": "Day of month (1..31). Required for monthly.",
            },
            "time": {
                "type": "string",
                "description": "Time in HH:MM 24h format (optional)",
            },
            "description": {
                "type": "string",
                "description": "Optional longer description",
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

        try:
            rule = await self._recurring.create(
                title=title,
                frequency=frequency,
                weekday=weekday,
                day_of_month=day_of_month,
                time=time_val,
                description=description,
            )
        except ValueError as exc:
            return ToolResult(ok=False, error=str(exc))

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

        schedule = _build_schedule_text(frequency, weekday, day_of_month, time_val)
        card_html = _build_card_html(
            title=title,
            description=description,
            frequency=frequency,
            weekday=weekday,
            day_of_month=day_of_month,
            time=time_val,
            materialized_today=materialized_today,
        )

        text = f"Recurring task created: \"{title}\" -- {schedule}."
        if materialized_today:
            text += " Today's occurrence has been created."

        return ToolResult(
            ok=True,
            output=text,
            metadata={
                "html_card": card_html,
                "recurring": rule.to_dict(),
                "materialized_today": materialized_today,
            },
        )
