"""Dataclasses for the recurring tasks module (single-tenant, no user_id)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class RecurringRule:
    id: str  # UUID
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

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
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
        }
