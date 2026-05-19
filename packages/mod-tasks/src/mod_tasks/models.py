from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

TASK_TYPES = ["finance_import", "calendar_add", "whatsapp_reply", "generic"]
TASK_STATUSES = ["pending", "approved", "rejected", "completed", "failed"]
TASK_PRIORITIES = ["low", "med", "high"]


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
    due_time: str | None = None  # HH:MM 24h (optional, pairs with due_date)
    user_id: str | None = None  # NULL for single-tenant (Seraphine), set for Aura
    priority: str | None = None  # low / med / high (optional)
    tags: list[str] = field(default_factory=list)  # free-form short labels
    remind: str | None = None  # at_time / 1h_before / 1d_before (legacy single-choice)
    completed_by: str | None = None                  # stored: user_id
    participants: list[str] = field(default_factory=list)  # computed: emails
    is_owner: bool = False                           # computed for caller
    completed_by_email: str | None = None            # computed
    # Computed: minutes-before-due offsets, sorted ascending. 0 = at due
    # time. Loaded by list_tasks / get_task; not stored on the task row
    # itself — see task_reminder_offsets.
    reminder_offsets: list[int] = field(default_factory=list)
