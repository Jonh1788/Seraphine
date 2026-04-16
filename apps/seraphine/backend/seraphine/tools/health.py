"""Chat tools for Apple Health -- summaries + trend analysis.

Both tools are READ-ONLY: the frontend owns HealthKit ingestion and
pushes snapshots to the backend over HTTP. Tools only read whatever was
already synced. If no snapshot is present for the requested window the
tools return a soft error message ("no data yet") instead of a crash.
"""

from __future__ import annotations

import html as _html
import logging
from statistics import mean
from typing import Any

from seraphine.health.service import HealthService
from seraphine.tools.base import Tool, ToolResult
from seraphine.tools.svg_icons import (
    ACTIVITY,
    BED,
    FLAME_HEALTH,
    FOOTPRINTS,
    HEART_RATE,
    SCALE,
)

logger = logging.getLogger(__name__)


_METRIC_LABELS_PT: dict[str, str] = {
    "steps": "passos",
    "active_calories": "calorias ativas",
    "sleep": "sono",
    "weight": "peso",
    "heart_rate": "frequencia cardiaca de repouso",
}

_METRIC_UNITS: dict[str, str] = {
    "steps": "passos",
    "active_calories": "kcal",
    "sleep": "min",
    "weight": "kg",
    "heart_rate": "bpm",
}


def _format_minutes(total: float | None) -> str:
    if total is None:
        return "—"
    minutes = int(round(float(total)))
    if minutes <= 0:
        return "—"
    h = minutes // 60
    m = minutes % 60
    if h == 0:
        return f"{m} min"
    if m == 0:
        return f"{h}h"
    return f"{h}h {m}min"


def _format_int(value: int | float | None) -> str:
    if value is None:
        return "—"
    try:
        return f"{int(round(float(value))):,}".replace(",", ".")
    except (TypeError, ValueError):
        return str(value)


def _goal_color(percent: int) -> str:
    if percent >= 100:
        return "#4ade80"  # green
    if percent >= 60:
        return "#f59e0b"  # amber
    return "#ef4444"       # red


def _build_today_card(snapshot_dict: dict[str, Any]) -> str:
    steps = int(snapshot_dict.get("steps") or 0)
    cals = float(snapshot_dict.get("active_calories") or 0.0)
    sleep_min = snapshot_dict.get("sleep_minutes")
    sleep_quality = snapshot_dict.get("sleep_quality")
    rhr = snapshot_dict.get("resting_heart_rate")
    weight = snapshot_dict.get("weight_kg")
    workouts = snapshot_dict.get("workouts") or []

    steps_goal = 10_000
    pct = int(round((steps / steps_goal) * 100)) if steps_goal > 0 else 0
    bar_pct = max(0, min(100, pct))
    bar_color = _goal_color(pct)

    # Format workouts summary
    workout_row = ""
    if workouts:
        total_min = sum(
            float(w.get("duration_min") or 0) for w in workouts
        )
        primary = workouts[0]
        primary_type = _html.escape(str(primary.get("type") or "treino"))
        primary_min = int(round(float(primary.get("duration_min") or 0)))
        summary = (
            f"{len(workouts)} ({primary_type}, {primary_min}min)"
            if len(workouts) == 1
            else f"{len(workouts)} treinos ({int(round(total_min))}min)"
        )
    else:
        summary = "Nenhum"

    sleep_line = _format_minutes(
        float(sleep_min) if sleep_min is not None else None
    )
    if sleep_quality and sleep_line != "—":
        sleep_line = f"{sleep_line} ({_html.escape(str(sleep_quality))})"

    rhr_line = (
        f"{int(round(float(rhr)))} bpm" if rhr is not None else "—"
    )
    weight_line = (
        f"{float(weight):.1f} kg" if weight is not None else None
    )

    rows: list[str] = [
        (
            '    <div class="rich-card__row">'
            f'      <span class="rich-card__row-icon" style="color:#22d3ee">{FOOTPRINTS}</span>'
            '      <div class="rich-card__row-body">'
            f'        <div class="rich-card__row-label">Passos</div>'
            f'        <div class="rich-card__row-value">{_format_int(steps)} / {_format_int(steps_goal)}</div>'
            '        <div style="margin-top:6px;height:6px;width:100%;'
            'background:rgba(255,255,255,0.08);border-radius:999px;overflow:hidden">'
            f'          <div style="width:{bar_pct}%;height:100%;background:{bar_color};'
            'border-radius:999px;transition:width 300ms ease"></div>'
            '        </div>'
            '      </div>'
            '    </div>'
        ),
        (
            '    <div class="rich-card__row">'
            f'      <span class="rich-card__row-icon" style="color:#f97316">{FLAME_HEALTH}</span>'
            '      <div class="rich-card__row-body">'
            '        <div class="rich-card__row-label">Calorias ativas</div>'
            f'        <div class="rich-card__row-value">{_format_int(cals)} kcal</div>'
            '      </div>'
            '    </div>'
        ),
        (
            '    <div class="rich-card__row">'
            f'      <span class="rich-card__row-icon" style="color:#a78bfa">{BED}</span>'
            '      <div class="rich-card__row-body">'
            '        <div class="rich-card__row-label">Sono</div>'
            f'        <div class="rich-card__row-value">{_html.escape(sleep_line)}</div>'
            '      </div>'
            '    </div>'
        ),
        (
            '    <div class="rich-card__row">'
            f'      <span class="rich-card__row-icon" style="color:#4ade80">{ACTIVITY}</span>'
            '      <div class="rich-card__row-body">'
            '        <div class="rich-card__row-label">Treinos</div>'
            f'        <div class="rich-card__row-value">{_html.escape(summary)}</div>'
            '      </div>'
            '    </div>'
        ),
        (
            '    <div class="rich-card__row">'
            f'      <span class="rich-card__row-icon" style="color:#ef4444">{HEART_RATE}</span>'
            '      <div class="rich-card__row-body">'
            '        <div class="rich-card__row-label">FC repouso</div>'
            f'        <div class="rich-card__row-value">{_html.escape(rhr_line)}</div>'
            '      </div>'
            '    </div>'
        ),
    ]

    if weight_line:
        rows.append(
            '    <div class="rich-card__row">'
            f'      <span class="rich-card__row-icon" style="color:#22d3ee">{SCALE}</span>'
            '      <div class="rich-card__row-body">'
            '        <div class="rich-card__row-label">Peso</div>'
            f'        <div class="rich-card__row-value">{_html.escape(weight_line)}</div>'
            '      </div>'
            '    </div>'
        )

    date_str = _html.escape(str(snapshot_dict.get("date") or ""))

    return (
        '<!--card--><div class="rich-card rich-card--health">'
        '  <div class="rich-card__header">'
        f'    <div class="rich-card__icon" style="color:#ef4444">{HEART_RATE}</div>'
        '    <div>'
        f'      <div class="rich-card__title">Saude hoje</div>'
        f'      <div class="rich-card__subtitle">{date_str}</div>'
        '    </div>'
        '  </div>'
        '  <div class="rich-card__rows">'
        + "".join(rows) +
        '  </div>'
        '</div><!--/card-->'
    )


def _build_trend_card(
    metric: str,
    points: list[dict[str, Any]],
    days: int,
) -> str:
    label = _METRIC_LABELS_PT.get(metric, metric)
    unit = _METRIC_UNITS.get(metric, "")
    values = [float(p.get("value") or 0) for p in points]
    if not values:
        return (
            '<!--card--><div class="rich-card rich-card--health">'
            '  <div class="rich-card__header">'
            f'    <div class="rich-card__icon" style="color:#a78bfa">{ACTIVITY}</div>'
            '    <div>'
            f'      <div class="rich-card__title">Tendencia: {_html.escape(label)}</div>'
            '      <div class="rich-card__subtitle">Sem dados ainda</div>'
            '    </div>'
            '  </div>'
            '</div><!--/card-->'
        )

    vmin = min(values)
    vmax = max(values)
    avg = mean(values)
    first_v = values[0]
    last_v = values[-1]
    direction = "estavel"
    if last_v > first_v * 1.05:
        direction = "subindo"
    elif last_v < first_v * 0.95:
        direction = "caindo"

    # Sparkline SVG: normalized to 120x32.
    width = 220.0
    height = 42.0
    pad = 3.0
    span = max(vmax - vmin, 1e-6)
    if len(values) == 1:
        coords = f"{pad},{height - pad}"
    else:
        step = (width - 2 * pad) / (len(values) - 1)
        pts: list[str] = []
        for i, v in enumerate(values):
            x = pad + i * step
            y = height - pad - ((v - vmin) / span) * (height - 2 * pad)
            pts.append(f"{x:.1f},{y:.1f}")
        coords = " ".join(pts)

    stroke_color = "#22d3ee"
    if direction == "subindo" and metric in {"steps", "active_calories", "sleep"}:
        stroke_color = "#4ade80"
    elif direction == "caindo" and metric in {"steps", "active_calories", "sleep"}:
        stroke_color = "#ef4444"
    elif direction == "subindo" and metric == "heart_rate":
        stroke_color = "#ef4444"

    avg_fmt = f"{int(round(avg)):,}".replace(",", ".") if metric in ("steps", "active_calories") else f"{avg:.1f}"
    subtitle = (
        f"Media {avg_fmt} {unit} · {direction} · "
        f"{len(values)}/{days} dias"
    )

    return (
        '<!--card--><div class="rich-card rich-card--health">'
        '  <div class="rich-card__header">'
        f'    <div class="rich-card__icon" style="color:{stroke_color}">{ACTIVITY}</div>'
        '    <div>'
        f'      <div class="rich-card__title">Tendencia: {_html.escape(label)}</div>'
        f'      <div class="rich-card__subtitle">{_html.escape(subtitle)}</div>'
        '    </div>'
        '  </div>'
        '  <div style="margin-top:10px">'
        f'    <svg viewBox="0 0 {width:.0f} {height:.0f}" width="100%" height="42"'
        '      xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none">'
        f'      <polyline fill="none" stroke="{stroke_color}" stroke-width="2" '
        f'        stroke-linecap="round" stroke-linejoin="round" points="{coords}"/>'
        '    </svg>'
        '  </div>'
        '</div><!--/card-->'
    )


class HealthSummaryTool(Tool):
    """Today's Apple Health summary: steps, calories, workouts, sleep, HR."""

    name = "health_summary"
    description = (
        "Get the user's Apple Health summary for today: steps, active "
        "calories, workouts, sleep duration & quality, resting heart "
        "rate, and latest weight. Use when the user asks about their "
        "health, fitness, sleep, activity, or saude (PT-BR: 'como estou "
        "de saude?', 'quantos passos', 'dormi bem?', 'meu resumo de "
        "hoje'). Returns a rich HTML card."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {},
    }
    requires_confirmation = False
    category = "other"

    def __init__(self, health_service: HealthService) -> None:
        self._svc = health_service

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        try:
            snapshot = await self._svc.get_today()
        except Exception as exc:
            logger.exception("health_summary: get_today failed")
            return ToolResult(ok=False, error=str(exc))

        if snapshot is None:
            return ToolResult(
                ok=True,
                output=(
                    "Ainda nao ha dados de saude sincronizados hoje. Abra o "
                    "Seraphine no Mac pra sincronizar com o Apple Saude."
                ),
                metadata={"health_snapshot": None},
            )

        snap_dict = snapshot.to_dict()
        card_html = _build_today_card(snap_dict)

        parts: list[str] = []
        parts.append(f"{snapshot.steps:,} passos".replace(",", "."))
        if snapshot.active_calories > 0:
            parts.append(
                f"{int(round(snapshot.active_calories))} kcal ativas"
            )
        if snapshot.sleep_minutes:
            parts.append(f"sono {_format_minutes(snapshot.sleep_minutes)}")
        if snapshot.workouts:
            parts.append(f"{len(snapshot.workouts)} treino(s)")
        if snapshot.resting_heart_rate:
            parts.append(
                f"FC repouso {int(round(snapshot.resting_heart_rate))} bpm"
            )

        text = "Resumo de hoje: " + ", ".join(parts) + "."

        return ToolResult(
            ok=True,
            output=text,
            metadata={
                "health_snapshot": snap_dict,
                "html_card": card_html,
            },
        )


class HealthTrendTool(Tool):
    """Trend analysis of one health metric over a configurable window."""

    name = "health_trend"
    description = (
        "Analyze a health metric trend over the last N days. Use when "
        "the user asks about patterns ('minha media de passos', 'estou "
        "dormindo menos?', 'meu peso nas ultimas semanas', 'como esta "
        "minha frequencia cardiaca'). Returns a sparkline card with "
        "average, direction (subindo/caindo/estavel), min/max."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "metric": {
                "type": "string",
                "enum": [
                    "steps", "active_calories", "sleep",
                    "weight", "heart_rate",
                ],
                "description": (
                    "Which metric to analyze. 'sleep' uses total minutes "
                    "per night; 'heart_rate' uses the resting HR per day."
                ),
            },
            "days": {
                "type": "integer",
                "minimum": 2,
                "maximum": 90,
                "description": "Number of trailing days to include. Default 14.",
            },
        },
        "required": ["metric"],
    }
    requires_confirmation = False
    category = "other"

    def __init__(self, health_service: HealthService) -> None:
        self._svc = health_service

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        metric = str(args.get("metric") or "").strip()
        if not metric:
            return ToolResult(ok=False, error="metric is required")

        days_raw = args.get("days")
        try:
            days = int(days_raw) if days_raw is not None else 14
        except (TypeError, ValueError):
            return ToolResult(ok=False, error="days must be an integer")
        if days < 2 or days > 90:
            return ToolResult(ok=False, error="days must be 2..90")

        try:
            points = await self._svc.get_trend(metric=metric, days=days)
        except ValueError as exc:
            return ToolResult(ok=False, error=str(exc))
        except Exception as exc:
            logger.exception("health_trend: get_trend failed")
            return ToolResult(ok=False, error=str(exc))

        points_dict = [p.to_dict() for p in points]
        card_html = _build_trend_card(metric, points_dict, days)

        if not points:
            text = (
                f"Sem dados suficientes pra {metric} nos ultimos {days} "
                f"dias."
            )
        else:
            values = [float(p.get("value") or 0) for p in points_dict]
            avg = mean(values)
            if metric in ("steps", "active_calories"):
                avg_str = f"{int(round(avg)):,}".replace(",", ".")
            else:
                avg_str = f"{avg:.1f}"
            unit = _METRIC_UNITS.get(metric, "")
            label = _METRIC_LABELS_PT.get(metric, metric)
            text = (
                f"Media de {label} nos ultimos {days} dias: "
                f"{avg_str} {unit} ({len(points)} dias com dados)."
            )

        return ToolResult(
            ok=True,
            output=text,
            metadata={
                "metric": metric,
                "days": days,
                "points": points_dict,
                "html_card": card_html,
            },
        )
