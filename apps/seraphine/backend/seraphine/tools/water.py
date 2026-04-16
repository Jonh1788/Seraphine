"""Chat tools for water tracking -- log intakes and set up profile.

Single-tenant tools that talk to ``WaterService`` and return rich HTML
cards with progress bars. No emojis.
"""

from __future__ import annotations

import html as _html
import logging
from typing import Any

from seraphine.tools.base import Tool, ToolResult
from seraphine.tools.svg_icons import DROPLET
from seraphine.water.service import WaterService

logger = logging.getLogger(__name__)


# Shared preset sizes in ml. Keys match the tool schema enum.
PRESET_SIZES: dict[str, int] = {
    "copo": 250,
    "copão": 400,
    "garrafa_pequena": 500,
    "garrafa": 600,
    "garrafão": 1000,
}

_DEFAULT_AMOUNT_ML = 250


_ACTIVITY_LABELS_PT: dict[str, str] = {
    "sedentary": "Sedentario",
    "moderate": "Moderado",
    "active": "Ativo",
}


def _resolve_amount(args: dict[str, Any]) -> int:
    """Pick amount_ml from the args: explicit > preset > default 250ml."""
    raw = args.get("amount_ml")
    if raw is not None:
        try:
            val = int(raw)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"amount_ml must be an integer, got {raw!r}") from exc
        if val <= 0:
            raise ValueError(f"amount_ml must be > 0, got {val}")
        return val
    preset = args.get("preset")
    if preset is not None:
        key = str(preset).strip()
        if key not in PRESET_SIZES:
            raise ValueError(
                f"invalid preset: {preset!r} (must be one of "
                f"{', '.join(sorted(PRESET_SIZES))})"
            )
        return PRESET_SIZES[key]
    return _DEFAULT_AMOUNT_ML


def _build_intake_card(
    amount_ml: int,
    total_today: int,
    goal: int,
    percent: int,
) -> str:
    # Clamp visual bar to [0..100]
    bar_percent = max(0, min(100, int(percent)))
    total_txt = f"{total_today} ml"
    goal_txt = f"{goal} ml" if goal > 0 else "—"
    amount_txt = f"{amount_ml} ml"
    return (
        '<!--card--><div class="rich-card rich-card--water">'
        '  <div class="rich-card__header">'
        f'    <div class="rich-card__icon" style="color:#22d3ee">{DROPLET}</div>'
        '    <div>'
        f'      <div class="rich-card__title">+{_html.escape(amount_txt)}</div>'
        f'      <div class="rich-card__subtitle">'
        f'{_html.escape(total_txt)} de {_html.escape(goal_txt)} hoje ({bar_percent}%)'
        '</div>'
        '    </div>'
        '  </div>'
        '  <div style="margin-top:12px;height:8px;width:100%;'
        'background:rgba(34,211,238,0.15);border-radius:999px;overflow:hidden">'
        f'    <div style="width:{bar_percent}%;height:100%;background:#22d3ee;'
        'border-radius:999px;transition:width 300ms ease"></div>'
        '  </div>'
        '</div><!--/card-->'
    )


def _build_setup_card(profile: dict[str, Any]) -> str:
    goal = int(profile.get("daily_goal_ml") or 0)
    weight = profile.get("weight_kg")
    activity_raw = str(profile.get("activity_level") or "")
    activity = _ACTIVITY_LABELS_PT.get(activity_raw, activity_raw)
    subtitle_parts: list[str] = []
    if weight is not None:
        subtitle_parts.append(f"{weight} kg")
    if activity:
        subtitle_parts.append(activity)
    subtitle = " · ".join(subtitle_parts) if subtitle_parts else "Configuracao salva"
    return (
        '<!--card--><div class="rich-card rich-card--water">'
        '  <div class="rich-card__header">'
        f'    <div class="rich-card__icon" style="color:#22d3ee">{DROPLET}</div>'
        '    <div>'
        f'      <div class="rich-card__title">Meta: {goal} ml/dia</div>'
        f'      <div class="rich-card__subtitle">{_html.escape(subtitle)}</div>'
        '    </div>'
        '  </div>'
        '</div><!--/card-->'
    )


class LogWaterTool(Tool):
    """Record a water intake entry for today."""

    name = "log_water"
    description = (
        "Register a water intake for today. Use when the user reports having "
        "just drunk water -- typical PT-BR triggers: 'bebi agua', 'tomei "
        "agua', 'um copo d'agua', 'uma garrafa', 'bebi 500ml'. Accepts either "
        "an explicit amount_ml or a preset size. If neither is provided, "
        "defaults to 250 ml (um copo). Returns an HTML card with a progress "
        "bar showing the day's total against the goal."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "amount_ml": {
                "type": "integer",
                "minimum": 1,
                "maximum": 5000,
                "description": "Explicit intake size in milliliters.",
            },
            "preset": {
                "type": "string",
                "enum": ["copo", "copão", "garrafa_pequena", "garrafa", "garrafão"],
                "description": (
                    "Named size. copo=250ml, copão=400ml, "
                    "garrafa_pequena=500ml, garrafa=600ml, garrafão=1000ml."
                ),
            },
        },
    }
    requires_confirmation = False
    category = "other"

    def __init__(self, water_service: WaterService) -> None:
        self._svc = water_service

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        try:
            amount_ml = _resolve_amount(args or {})
        except ValueError as exc:
            return ToolResult(ok=False, error=str(exc))

        try:
            result = await self._svc.add_intake(amount_ml)
        except LookupError:
            return ToolResult(
                ok=False,
                error=(
                    "perfil de agua nao configurado. Peca ao usuario o peso "
                    "e nivel de atividade, depois chame setup_water."
                ),
            )
        except ValueError as exc:
            return ToolResult(ok=False, error=str(exc))
        except Exception as exc:
            logger.exception("log_water: add_intake failed")
            return ToolResult(ok=False, error=str(exc))

        total = int(result.get("total_today") or 0)
        goal = int(result.get("goal") or 0)
        percent = int(result.get("percent") or 0)
        log = result.get("log") or {}

        card_html = _build_intake_card(amount_ml, total, goal, percent)
        text = (
            f"Registrado: {amount_ml} ml. Total hoje: {total} ml "
            f"de {goal} ml ({percent}%)."
        )

        return ToolResult(
            ok=True,
            output=text,
            metadata={
                "amount_ml": amount_ml,
                "total_today": total,
                "goal": goal,
                "percent": percent,
                "water_log": log,
                "html_card": card_html,
            },
        )


class SetupWaterTool(Tool):
    """Create or update the water profile (weight + activity)."""

    name = "setup_water"
    description = (
        "Configure the user's water profile -- weight and activity level. "
        "Computes a daily goal automatically (sedentary=30ml/kg, "
        "moderate=35ml/kg, active=40ml/kg, clamped 1500-5000ml). Use when "
        "the user says things like 'peso 72 kg', 'configurar agua', "
        "'quanto beber por dia', 'me ajuda a beber mais agua'."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "weight_kg": {
                "type": "number",
                "minimum": 20,
                "maximum": 300,
                "description": "Body weight in kilograms.",
            },
            "height_cm": {
                "type": "number",
                "minimum": 50,
                "maximum": 250,
                "description": "Optional height in centimeters.",
            },
            "activity_level": {
                "type": "string",
                "enum": ["sedentary", "moderate", "active"],
                "description": (
                    "sedentary = little/no exercise, moderate = 3-4x per "
                    "week, active = daily exercise or physical job."
                ),
            },
        },
        "required": ["weight_kg", "activity_level"],
    }
    requires_confirmation = False
    category = "other"

    def __init__(self, water_service: WaterService) -> None:
        self._svc = water_service

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        try:
            weight_kg = float(args.get("weight_kg"))
        except (TypeError, ValueError):
            return ToolResult(ok=False, error="weight_kg is required (number)")
        activity_level = str(args.get("activity_level") or "").strip()
        if not activity_level:
            return ToolResult(ok=False, error="activity_level is required")

        height_raw = args.get("height_cm")
        height_cm: float | None = None
        if height_raw is not None:
            try:
                height_cm = float(height_raw)
            except (TypeError, ValueError):
                return ToolResult(ok=False, error="height_cm must be a number")

        try:
            profile = await self._svc.set_profile(
                weight_kg=weight_kg,
                activity_level=activity_level,
                height_cm=height_cm,
            )
        except ValueError as exc:
            return ToolResult(ok=False, error=str(exc))
        except Exception as exc:
            logger.exception("setup_water: set_profile failed")
            return ToolResult(ok=False, error=str(exc))

        profile_dict = profile.to_dict()
        card_html = _build_setup_card(profile_dict)
        text = (
            f"Perfil de agua salvo. Meta diaria: {profile.daily_goal_ml} ml."
        )
        return ToolResult(
            ok=True,
            output=text,
            metadata={
                "water_profile": profile_dict,
                "html_card": card_html,
            },
        )
