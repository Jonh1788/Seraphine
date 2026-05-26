"""Dataclasses for the insights module (single-tenant, no user_id)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class Insight:
    id: str  # stable hash of (type, kind-key, period) so re-runs dedupe
    type: str  # 'finance' | 'tasks' | 'habits' | 'productivity'
    severity: str  # 'info' | 'warning' | 'positive'
    title: str
    description: str
    data: dict[str, Any] = field(default_factory=dict)  # support data (values, pcts)
    created_at: str = ""
    dismissed: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "type": self.type,
            "severity": self.severity,
            "title": self.title,
            "description": self.description,
            "data": dict(self.data or {}),
            "created_at": self.created_at,
            "dismissed": self.dismissed,
        }


@dataclass
class WeeklyReport:
    id: int | None
    week_start: str  # ISO YYYY-MM-DD (Monday, America/Sao_Paulo)
    week_end: str  # ISO YYYY-MM-DD (Sunday)
    tasks: dict[str, Any] = field(default_factory=dict)
    finance: dict[str, Any] = field(default_factory=dict)
    habits: dict[str, Any] = field(default_factory=dict)
    goals: dict[str, Any] = field(default_factory=dict)
    mood: dict[str, Any] = field(default_factory=dict)
    focus: dict[str, Any] = field(default_factory=dict)
    journal: dict[str, Any] = field(default_factory=dict)
    insights: list[dict[str, Any]] = field(default_factory=list)
    suggestion: str = ""
    created_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "week_start": self.week_start,
            "week_end": self.week_end,
            "tasks": dict(self.tasks or {}),
            "finance": dict(self.finance or {}),
            "habits": dict(self.habits or {}),
            "goals": dict(self.goals or {}),
            "mood": dict(self.mood or {}),
            "focus": dict(self.focus or {}),
            "journal": dict(self.journal or {}),
            "insights": list(self.insights or []),
            "suggestion": self.suggestion,
            "created_at": self.created_at,
        }
