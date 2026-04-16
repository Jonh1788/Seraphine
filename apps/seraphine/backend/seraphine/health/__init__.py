"""Apple Health (HealthKit) integration -- snapshots pushed from Tauri.

The Swift/HealthKit bridge lives in the Tauri frontend; the backend just
receives daily snapshots, persists them, and exposes them to the LLM,
dashboard, habits auto-complete, and insights.
"""

from seraphine.health.models import (
    HealthSnapshot,
    HealthTrendPoint,
    WorkoutEntry,
)
from seraphine.health.service import HealthService

__all__ = [
    "HealthService",
    "HealthSnapshot",
    "HealthTrendPoint",
    "WorkoutEntry",
]
