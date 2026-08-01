"""Chat tools for habits -- create and toggle habits via LLM tool-calling."""

from __future__ import annotations

import logging
from typing import Any

from seraphine.habits.service import HabitService
from seraphine.tools.base import Tool, ToolResult
from seraphine.tools.cards import css_color as _css_color
from seraphine.tools.cards import text as _esc
from seraphine.tools.svg_icons import (
    CHECK_CIRCLE,
    FLAME,
    HABIT_ICONS,
    REPEAT,
)

logger = logging.getLogger(__name__)


_FREQUENCY_LABELS_PT = {
    "daily": "Todo dia",
    "weekdays": "Dias de semana",
    "custom": "Dias selecionados",
}

_WEEKDAY_SHORT_PT = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sab", "Dom"]


def _resolve_habit_id(habits: list[dict[str, Any]], title_query: str) -> dict[str, Any] | None:
    """Return the first active habit whose title contains ``title_query``
    (case-insensitive substring). Falls back to exact match precedence."""
    q = (title_query or "").strip().lower()
    if not q:
        return None
    exact: dict[str, Any] | None = None
    substr: dict[str, Any] | None = None
    for h in habits:
        t = str(h.get("title") or "").lower()
        if t == q and exact is None:
            exact = h
        if q in t and substr is None:
            substr = h
    return exact or substr


def _build_toggle_card(
    habit: dict[str, Any],
    current_streak: int,
    best_streak: int,
    completed: bool,
) -> str:
    title = _esc(habit.get("title") or "")
    color = _css_color(habit.get("color") or "")
    icon_key = str(habit.get("icon") or "check")
    icon_svg = HABIT_ICONS.get(icon_key, HABIT_ICONS["check"])

    status_label = "Concluido hoje" if completed else "Desmarcado"
    status_icon = CHECK_CIRCLE

    streak_html = ""
    if current_streak > 0:
        streak_html = (
            '    <div class="rich-card__stat">'
            '      <div class="rich-card__stat-label">Sequencia atual</div>'
            f'      <div class="rich-card__stat-value">{FLAME} {current_streak} dia{"s" if current_streak != 1 else ""}</div>'
            '    </div>'
        )

    best_html = ""
    if best_streak > 0:
        best_html = (
            '    <div class="rich-card__stat">'
            '      <div class="rich-card__stat-label">Melhor sequencia</div>'
            f'      <div class="rich-card__stat-value">{best_streak} dias</div>'
            '    </div>'
        )

    return (
        '<!--card--><div class="rich-card rich-card--habit">'
        '  <div class="rich-card__header">'
        f'    <div class="rich-card__icon" style="color:{color}">{icon_svg}</div>'
        '    <div>'
        f'      <div class="rich-card__title">{title}</div>'
        f'      <div class="rich-card__subtitle">{status_icon} {status_label}</div>'
        '    </div>'
        '  </div>'
        '  <div class="rich-card__stats">'
        f'{streak_html}{best_html}'
        '  </div>'
        '</div><!--/card-->'
    )


def _build_create_card(habit: dict[str, Any]) -> str:
    title = _esc(habit.get("title") or "")
    color = _css_color(habit.get("color") or "")
    icon_key = str(habit.get("icon") or "check")
    icon_svg = HABIT_ICONS.get(icon_key, HABIT_ICONS["check"])
    frequency = str(habit.get("frequency") or "daily")
    freq_label = _FREQUENCY_LABELS_PT.get(frequency, frequency)
    target_days = habit.get("target_days") or []

    subtitle = freq_label
    if frequency == "custom" and target_days:
        try:
            names = ", ".join(
                _WEEKDAY_SHORT_PT[int(d)] for d in target_days
                if 0 <= int(d) <= 6
            )
            if names:
                subtitle = f"{freq_label}: {names}"
        except (TypeError, ValueError):
            pass

    return (
        '<!--card--><div class="rich-card rich-card--habit">'
        '  <div class="rich-card__header">'
        f'    <div class="rich-card__icon" style="color:{color}">{icon_svg}</div>'
        '    <div>'
        f'      <div class="rich-card__title">{title}</div>'
        f'      <div class="rich-card__subtitle">{REPEAT} {_esc(subtitle)}</div>'
        '    </div>'
        '  </div>'
        '</div><!--/card-->'
    )


class ToggleHabitTool(Tool):
    """Mark a habit as done (or undone) for today."""

    name = "toggle_habit"
    description = (
        "Mark a habit as done for today (or toggle it off). Use this when the "
        "user reports having completed one of their tracked habits -- "
        "typical triggers in PT-BR: 'bebi agua', 'fiz exercicio', 'li', "
        "'meditei', 'marca o habito', 'corri', 'treinei', 'dormi cedo'. "
        "Match the habit by its title (case-insensitive, substring)."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "habit_title": {
                "type": "string",
                "description": (
                    "Habit title or partial title to match against the user's "
                    "active habits."
                ),
            },
            "completed": {
                "type": "boolean",
                "description": (
                    "Optional. When true (default) ensures the habit is "
                    "marked as done today. When false, clears today's entry."
                ),
            },
        },
        "required": ["habit_title"],
    }
    requires_confirmation = False
    category = "other"

    def __init__(self, habit_service: HabitService) -> None:
        self._svc = habit_service

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        title_query = str(args.get("habit_title") or "").strip()
        if not title_query:
            return ToolResult(ok=False, error="habit_title is required")

        want_completed = args.get("completed")
        if want_completed is None:
            want_completed = True

        try:
            habits = await self._svc.list_with_today_status()
        except Exception as exc:
            logger.exception("toggle_habit: failed to list habits")
            return ToolResult(ok=False, error=str(exc))

        match = _resolve_habit_id(habits, title_query)
        if match is None:
            return ToolResult(
                ok=False,
                error=f"no active habit matches {title_query!r}",
            )

        habit_id = str(match.get("id") or "")
        today_done = bool(match.get("today_completed"))

        # If the habit is already in the desired state, do nothing
        if bool(want_completed) == today_done:
            current = int(match.get("current_streak") or 0)
            best = int(match.get("best_streak") or 0)
            card_html = _build_toggle_card(match, current, best, today_done)
            return ToolResult(
                ok=True,
                output=(
                    f"Habito \"{match.get('title')}\" ja estava "
                    f"{'marcado' if today_done else 'desmarcado'} hoje."
                ),
                metadata={
                    "habit_id": habit_id,
                    "today_completed": today_done,
                    "current_streak": current,
                    "best_streak": best,
                    "html_card": card_html,
                },
            )

        try:
            result = await self._svc.toggle(habit_id)
        except Exception as exc:
            logger.exception("toggle_habit: toggle failed")
            return ToolResult(ok=False, error=str(exc))
        if result is None:
            return ToolResult(ok=False, error="habit not found")

        log = result.get("log") or {}
        now_completed = bool(log.get("completed"))
        current = int(result.get("current_streak") or 0)
        best = int(result.get("best_streak") or 0)
        card_html = _build_toggle_card(match, current, best, now_completed)

        verb = "concluido" if now_completed else "desmarcado"
        text = f"Habito \"{match.get('title')}\" {verb}."
        if now_completed and current > 0:
            text += f" Sequencia: {current} dia{'s' if current != 1 else ''}."

        return ToolResult(
            ok=True,
            output=text,
            metadata={
                "habit_id": habit_id,
                "today_completed": now_completed,
                "current_streak": current,
                "best_streak": best,
                "log": log,
                "html_card": card_html,
            },
        )


class CreateHabitTool(Tool):
    """Create a new tracked habit."""

    name = "create_habit"
    description = (
        "Create a new habit for the user to track. Habits have a title, a "
        "frequency ('daily', 'weekdays', or 'custom'), and optional icon and "
        "color. Use when the user wants to start tracking something -- "
        "e.g. 'quero criar o habito de beber agua todo dia', 'cria um habito "
        "de correr na segunda, quarta e sexta'. For 'custom' frequency, "
        "provide target_days as integers where 0=Monday..6=Sunday."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "title": {
                "type": "string",
                "description": "Short title for the habit.",
            },
            "frequency": {
                "type": "string",
                "enum": ["daily", "weekdays", "custom"],
                "description": (
                    "How often the habit should be performed. 'daily' = every "
                    "day, 'weekdays' = Monday..Friday, 'custom' = specific "
                    "weekdays provided in target_days."
                ),
            },
            "target_days": {
                "type": "array",
                "items": {"type": "integer", "minimum": 0, "maximum": 6},
                "description": (
                    "Weekdays (0=Monday..6=Sunday). Required when "
                    "frequency='custom'."
                ),
            },
            "icon": {
                "type": "string",
                "enum": [
                    "check", "droplet", "run", "book", "brain", "heart",
                    "dumbbell", "moon", "sun", "flame",
                ],
                "description": "Optional icon key.",
            },
            "color": {
                "type": "string",
                "description": "Optional hex color (#RRGGBB).",
            },
        },
        "required": ["title", "frequency"],
    }
    requires_confirmation = False
    category = "other"

    def __init__(self, habit_service: HabitService) -> None:
        self._svc = habit_service

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        title = str(args.get("title") or "").strip()
        if not title:
            return ToolResult(ok=False, error="title is required")

        frequency = str(args.get("frequency") or "").strip()
        target_days = args.get("target_days")
        icon = args.get("icon")
        color = args.get("color")

        kwargs: dict[str, Any] = {
            "title": title,
            "frequency": frequency,
            "target_days": target_days,
        }
        if icon is not None:
            kwargs["icon"] = icon
        if color is not None:
            kwargs["color"] = color

        try:
            habit = await self._svc.create(**kwargs)
        except ValueError as exc:
            return ToolResult(ok=False, error=str(exc))
        except Exception as exc:
            logger.exception("create_habit tool failed")
            return ToolResult(ok=False, error=str(exc))

        habit_dict = habit.to_dict()
        card_html = _build_create_card(habit_dict)

        freq_label = _FREQUENCY_LABELS_PT.get(frequency, frequency)
        text = f"Habito criado: \"{title}\" ({freq_label})."

        return ToolResult(
            ok=True,
            output=text,
            metadata={
                "habit_id": habit.id,
                "habit": habit_dict,
                "html_card": card_html,
            },
        )
