"""Project dataclass returned by service methods."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class Project:
    id: str
    user_id: str
    name: str
    description: str | None
    color: str
    status: str  # active | at_risk | completed | archived
    target_date: str | None
    progress: int
    created_at: str
    updated_at: str
