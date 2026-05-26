"""Notification Intelligence — data types."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class NotificationSettings:
    """User-configurable notification preferences (single-tenant, id=1)."""

    quiet_hours_start: str = "23:00"  # HH:MM
    quiet_hours_end: str = "07:00"    # HH:MM
    dnd_apps: list[str] = field(default_factory=lambda: [
        "zoom.us", "us.zoom.xos", "com.google.android.apps.meetings",
        "FaceTime", "Microsoft Teams",
    ])
    batching_enabled: bool = True
    per_type_enabled: dict[str, bool] = field(default_factory=lambda: {
        "water": True,
        "reminder_timed": True,
        "opener": True,
        "insight": True,
        "day_review": True,
        "weekly_reflection": True,
        "task_deadline": True,
        "whatsapp_mention": True,
        "stalled_task": True,
    })

    def to_dict(self) -> dict[str, Any]:
        return {
            "quiet_hours_start": self.quiet_hours_start,
            "quiet_hours_end": self.quiet_hours_end,
            "dnd_apps": self.dnd_apps,
            "batching_enabled": self.batching_enabled,
            "per_type_enabled": self.per_type_enabled,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> NotificationSettings:
        return cls(
            quiet_hours_start=d.get("quiet_hours_start", "23:00"),
            quiet_hours_end=d.get("quiet_hours_end", "07:00"),
            dnd_apps=d.get("dnd_apps", cls().dnd_apps),
            batching_enabled=d.get("batching_enabled", True),
            per_type_enabled=d.get("per_type_enabled", cls().per_type_enabled),
        )


# Base priority scores by notification type.
BASE_PRIORITY: dict[str, int] = {
    "reminder_timed": 90,
    "task_deadline": 85,
    "whatsapp_mention": 80,
    "water": 30,
    "insight": 20,
    "opener": 10,
    "day_review": 15,
    "weekly_reflection": 15,
    "stalled_task": 25,
}

# Threshold below which notifications get batched instead of delivered
# immediately.
IMMEDIATE_THRESHOLD: int = 40
