"""Dataclasses for the goals module (single-tenant, no user_id)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class Goal:
    id: str  # UUID
    title: str
    area: str  # saude | carreira | financas | pessoal | aprendizado | relacionamentos
    timeframe: str  # quarterly | yearly | open_ended
    description: str | None = None
    start_date: str | None = None  # YYYY-MM-DD
    end_date: str | None = None  # YYYY-MM-DD
    status: str = "active"  # active | paused | completed | abandoned
    created_at: str = ""
    updated_at: str = ""
    # Enriched fields (not persisted directly)
    key_results: list[KeyResult] = field(default_factory=list)
    links: list[GoalLink] = field(default_factory=list)
    progress: float = 0.0  # 0..100

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "id": self.id,
            "title": self.title,
            "description": self.description or "",
            "area": self.area,
            "timeframe": self.timeframe,
            "start_date": self.start_date,
            "end_date": self.end_date,
            "status": self.status,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "progress": self.progress,
        }
        if self.key_results:
            d["key_results"] = [kr.to_dict() for kr in self.key_results]
        if self.links:
            d["links"] = [lk.to_dict() for lk in self.links]
        return d


@dataclass
class KeyResult:
    id: str  # UUID
    goal_id: str
    title: str
    metric_type: str  # numeric | boolean | percentage
    target_value: float
    current_value: float = 0.0
    unit: str | None = None
    auto_source: str | None = None  # e.g. "health.steps", "habits.{id}", "tasks.completed"
    created_at: str = ""
    updated_at: str = ""

    @property
    def progress(self) -> float:
        """Return 0..100 progress percentage."""
        if self.metric_type == "boolean":
            return 100.0 if self.current_value >= 1.0 else 0.0
        if self.target_value <= 0:
            return 0.0
        return min(100.0, (self.current_value / self.target_value) * 100.0)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "goal_id": self.goal_id,
            "title": self.title,
            "metric_type": self.metric_type,
            "target_value": self.target_value,
            "current_value": self.current_value,
            "unit": self.unit,
            "auto_source": self.auto_source,
            "progress": self.progress,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


@dataclass
class GoalLink:
    id: str  # UUID
    goal_id: str
    linked_type: str  # task | habit | project
    linked_id: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "goal_id": self.goal_id,
            "linked_type": self.linked_type,
            "linked_id": self.linked_id,
        }


@dataclass
class GoalSummary:
    goals_at_risk: int = 0
    goals_on_track: int = 0
    goals_completed: int = 0
    total_active: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "goals_at_risk": self.goals_at_risk,
            "goals_on_track": self.goals_on_track,
            "goals_completed": self.goals_completed,
            "total_active": self.total_active,
        }
