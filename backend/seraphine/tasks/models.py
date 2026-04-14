from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

TASK_TYPES = ["finance_import", "calendar_add", "whatsapp_reply", "generic"]
TASK_STATUSES = ["pending", "approved", "rejected", "completed", "failed"]


@dataclass
class SeraphineTask:
    id: int | None
    type: str  # finance_import, calendar_add, whatsapp_reply, generic
    status: str  # pending, approved, rejected, completed, failed
    title: str
    description: str
    source: str  # email, whatsapp, system, chat
    payload: dict[str, Any] = field(default_factory=dict)  # JSON-serializable dict
    created_at: str | None = None
    updated_at: str | None = None
    due_date: str | None = None  # YYYY-MM-DD (optional user-facing deadline)
