"""Dataclasses for the recurring tasks module (single-tenant, no user_id)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class RecurringRule:
    id: str  # UUID
    title: str
    description: str | None
    frequency: str  # 'daily' | 'weekly' | 'monthly'
    weekday: int | None  # 0=Mon..6=Sun, weekly only
    day_of_month: int | None  # 1..31, monthly only
    time: str | None  # HH:MM
    end_date: str | None  # YYYY-MM-DD, inclusive; None = runs forever
    remind: str | None  # at_time | 1h_before; None = sem lembrete
    active: bool
    last_materialized_date: str | None  # YYYY-MM-DD
    created_at: str
    updated_at: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "description": self.description or "",
            "frequency": self.frequency,
            "weekday": self.weekday,
            "day_of_month": self.day_of_month,
            "time": self.time,
            "end_date": self.end_date,
            "remind": self.remind,
            "active": self.active,
            "last_materialized_date": self.last_materialized_date,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


@dataclass
class Routine:
    """A curated or user-authored prompt launcher.

    Distinct from RecurringRule: a routine is not materialized into a task;
    it carries a prompt/action that is launched into the chat composer when
    the user runs it. ``kind`` drives the AGENDADAS vs MANUAIS split in the UI.
    """

    id: str  # UUID (or stable slug for builtin catalog entries)
    name: str
    detail: str
    kind: str  # 'scheduled' | 'manual'
    trigger: str | None  # human-readable schedule label, scheduled only
    enabled: bool
    prompt: str
    icon: str | None  # icon key (e.g. 'coffee'), resolved on the frontend
    icon_bg: str | None
    icon_color: str | None
    job_name: str | None  # backing proactive scheduler job, when any
    builtin: bool  # True for the code-owned catalog (not user-deletable)
    sort_order: int
    created_at: str
    updated_at: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "detail": self.detail,
            "kind": self.kind,
            "trigger": self.trigger,
            "enabled": self.enabled,
            "prompt": self.prompt,
            "icon": self.icon,
            "icon_bg": self.icon_bg,
            "icon_color": self.icon_color,
            "job_name": self.job_name,
            "builtin": self.builtin,
            "sort_order": self.sort_order,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }
