"""Dataclasses for the recurring tasks module."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class RecurringRule:
    id: str
    user_id: str
    title: str
    description: str | None
    frequency: str  # 'daily' | 'weekly' | 'monthly'
    weekday: int | None  # 0=Mon..6=Sun, weekly only
    day_of_month: int | None  # 1..31, monthly only
    time: str | None  # HH:MM
    active: bool
    last_materialized_date: str | None  # YYYY-MM-DD
    created_at: str
    updated_at: str
    # None = no per-rule override (fall back to user defaults at materialize
    # time); [] = explicit "no extras" (still fires at the time).
    reminder_offsets: list[int] | None = field(default=None)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "user_id": self.user_id,
            "title": self.title,
            "description": self.description or "",
            "frequency": self.frequency,
            "weekday": self.weekday,
            "day_of_month": self.day_of_month,
            "time": self.time,
            "active": self.active,
            "last_materialized_date": self.last_materialized_date,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "reminder_offsets": self.reminder_offsets,
        }
