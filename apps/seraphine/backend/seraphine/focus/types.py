"""Dataclasses for focus analytics (single-tenant, no user_id)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class FocusSession:
    id: str  # UUID
    started_at: str  # ISO-8601 UTC
    ended_at: str  # ISO-8601 UTC
    duration_sec: int
    type: str  # 'work' | 'short_break' | 'long_break'
    completed: bool
    interruptions: int = 0
    notes: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "started_at": self.started_at,
            "ended_at": self.ended_at,
            "duration_sec": self.duration_sec,
            "type": self.type,
            "completed": self.completed,
            "interruptions": self.interruptions,
            "notes": self.notes,
        }


@dataclass
class FocusAppLog:
    id: str  # UUID
    session_id: str
    app_name: str
    started_at: str  # ISO-8601 UTC
    duration_sec: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "session_id": self.session_id,
            "app_name": self.app_name,
            "started_at": self.started_at,
            "duration_sec": self.duration_sec,
        }


@dataclass
class FocusDayStat:
    date: str  # YYYY-MM-DD
    focus_min: int
    completed: int
    cancelled: int
    interruptions: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "date": self.date,
            "focus_min": self.focus_min,
            "completed": self.completed,
            "cancelled": self.cancelled,
            "interruptions": self.interruptions,
        }


@dataclass
class FocusStats:
    total_focus_min: int
    completed_sessions: int
    cancelled_sessions: int
    avg_session_min: float
    streak_days: int
    interruption_rate: float  # interruptions / total_sessions (0.0 .. 1.0)
    by_day: list[FocusDayStat] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "total_focus_min": self.total_focus_min,
            "completed_sessions": self.completed_sessions,
            "cancelled_sessions": self.cancelled_sessions,
            "avg_session_min": round(self.avg_session_min, 1),
            "streak_days": self.streak_days,
            "interruption_rate": round(self.interruption_rate, 3),
            "by_day": [d.to_dict() for d in self.by_day],
        }
