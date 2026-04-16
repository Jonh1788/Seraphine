"""Dataclasses for the health module (single-tenant, no user_id)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class WorkoutEntry:
    type: str            # 'running', 'walking', 'cycling', 'strength', ...
    start: str           # ISO
    end: str             # ISO
    duration_min: float
    calories: float | None = None
    distance_km: float | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "type": self.type,
            "start": self.start,
            "end": self.end,
            "duration_min": round(float(self.duration_min), 1),
            "calories": (
                round(float(self.calories), 1)
                if self.calories is not None
                else None
            ),
            "distance_km": (
                round(float(self.distance_km), 2)
                if self.distance_km is not None
                else None
            ),
        }


@dataclass
class HealthSnapshot:
    """One day of aggregated HealthKit data (America/Sao_Paulo)."""

    date: str                        # YYYY-MM-DD
    steps: int = 0
    active_calories: float = 0.0
    resting_heart_rate: float | None = None
    sleep_minutes: float | None = None
    sleep_quality: str | None = None  # 'boa' | 'regular' | 'ruim'
    weight_kg: float | None = None
    workouts: list[WorkoutEntry] = field(default_factory=list)
    synced_at: str = ""              # ISO — when the frontend pushed it

    def to_dict(self) -> dict[str, Any]:
        return {
            "date": self.date,
            "steps": int(self.steps),
            "active_calories": round(float(self.active_calories), 1),
            "resting_heart_rate": (
                round(float(self.resting_heart_rate), 1)
                if self.resting_heart_rate is not None
                else None
            ),
            "sleep_minutes": (
                round(float(self.sleep_minutes), 1)
                if self.sleep_minutes is not None
                else None
            ),
            "sleep_quality": self.sleep_quality,
            "weight_kg": (
                round(float(self.weight_kg), 2)
                if self.weight_kg is not None
                else None
            ),
            "workouts": [w.to_dict() for w in self.workouts],
            "synced_at": self.synced_at,
        }

    @property
    def workout_minutes(self) -> float:
        return sum((w.duration_min for w in self.workouts), 0.0)


@dataclass
class HealthTrendPoint:
    """One datapoint in a metric trend (used by `health_trend` tool)."""

    date: str
    value: float

    def to_dict(self) -> dict[str, Any]:
        return {"date": self.date, "value": round(float(self.value), 2)}
