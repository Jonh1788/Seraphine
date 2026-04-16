"""Dataclasses for the habits module (single-tenant, no user_id)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class Habit:
    id: str  # UUID
    title: str
    frequency: str  # 'daily' | 'weekdays' | 'custom'
    icon: str = "check"
    color: str = "#22d3ee"
    target_days: list[int] | None = None  # 0=Mon..6=Sun, required for custom
    description: str | None = None
    active: bool = True
    created_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "icon": self.icon,
            "color": self.color,
            "frequency": self.frequency,
            "target_days": list(self.target_days) if self.target_days else None,
            "description": self.description or "",
            "active": self.active,
            "created_at": self.created_at,
        }


@dataclass
class HabitLog:
    id: int
    habit_id: str
    date: str  # YYYY-MM-DD
    completed: bool
    created_at: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "habit_id": self.habit_id,
            "date": self.date,
            "completed": self.completed,
            "created_at": self.created_at,
        }
