"""Dataclasses for the water tracking module (single-tenant, no user_id)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class WaterProfile:
    weight_kg: float
    height_cm: float | None
    activity_level: str  # 'sedentary' | 'moderate' | 'active'
    daily_goal_ml: int
    reminder_enabled: bool
    reminder_start: str  # HH:MM
    reminder_end: str  # HH:MM
    reminder_interval_hours: int
    updated_at: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "weight_kg": self.weight_kg,
            "height_cm": self.height_cm,
            "activity_level": self.activity_level,
            "daily_goal_ml": self.daily_goal_ml,
            "reminder_enabled": self.reminder_enabled,
            "reminder_start": self.reminder_start,
            "reminder_end": self.reminder_end,
            "reminder_interval_hours": self.reminder_interval_hours,
            "updated_at": self.updated_at,
        }


@dataclass
class WaterLog:
    id: int
    amount_ml: int
    date: str  # YYYY-MM-DD
    logged_at: str  # ISO timestamp

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "amount_ml": self.amount_ml,
            "date": self.date,
            "logged_at": self.logged_at,
        }
