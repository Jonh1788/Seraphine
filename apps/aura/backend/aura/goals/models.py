"""Goal dataclass."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class Goal:
    id: str
    user_id: str
    title: str
    description: str | None
    kind: str  # general | financial | habit | project
    target_value: float | None
    current_value: float
    unit: str | None
    deadline: str | None
    status: str  # active | completed | expired | archived
    created_at: str
    updated_at: str
