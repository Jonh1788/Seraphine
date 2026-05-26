"""Data types for the daily planning engine."""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any


@dataclass
class TimeBlock:
    id: str
    start: str  # HH:MM
    end: str  # HH:MM
    type: str  # focus | meeting | break | exercise | admin | free
    title: str
    linked_id: str | None = None
    reason: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class PlanContext:
    sleep_hours: float | None = None
    energy_estimate: str = "medium"  # high | medium | low
    meetings_count: int = 0
    free_slots_min: int = 0
    mood_valence: float | None = None
    mood_reason: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class DailyPlan:
    time_blocks: list[TimeBlock] = field(default_factory=list)
    priorities: list[dict[str, Any]] = field(default_factory=list)
    at_risk: dict[str, list[dict[str, Any]]] = field(
        default_factory=lambda: {"habits": [], "goals": []}
    )
    context: PlanContext = field(default_factory=PlanContext)

    def to_dict(self) -> dict[str, Any]:
        return {
            "time_blocks": [b.to_dict() for b in self.time_blocks],
            "priorities": self.priorities,
            "at_risk": self.at_risk,
            "context": self.context.to_dict(),
        }


@dataclass
class PlanFeedback:
    date: str
    blocks_planned: int = 0
    blocks_executed: int = 0
    tasks_planned: int = 0
    tasks_done: int = 0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
