from __future__ import annotations

from dataclasses import dataclass

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
    payload: str  # JSON string with execution data
    created_at: str | None = None
    updated_at: str | None = None
