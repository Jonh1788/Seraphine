from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

TASK_TYPES = ["finance_import", "calendar_add", "whatsapp_reply", "generic"]
TASK_STATUSES = ["pending", "approved", "rejected", "completed", "failed"]
TASK_PRIORITIES = ["low", "med", "high"]


@dataclass
class SeraphineTask:
    id: int | None
    type: str
    status: str
    title: str
    description: str
    source: str
    payload: dict[str, Any] = field(default_factory=dict)
    created_at: str | None = None
    updated_at: str | None = None
    due_date: str | None = None
    due_time: str | None = None
    user_id: str | None = None
    priority: str | None = None
    tags: list[str] = field(default_factory=list)
    remind: str | None = None
    completed_by: str | None = None                  # stored: user_id
    participants: list[str] = field(default_factory=list)  # computed: emails
    is_owner: bool = False                           # computed for caller
    completed_by_email: str | None = None            # computed
