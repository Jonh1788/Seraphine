"""Dataclasses for the work projects module."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any


def _json_list(raw: Any) -> list[Any]:
    if not raw:
        return []
    try:
        value = json.loads(str(raw))
    except (TypeError, json.JSONDecodeError):
        return []
    return value if isinstance(value, list) else []


def _json_dict(raw: Any) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        value = json.loads(str(raw))
    except (TypeError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


@dataclass
class WorkProject:
    id: str
    name: str
    description: str = ""
    area: str = ""
    status: str = "active"
    priority: str = "medium"
    tags: list[str] = field(default_factory=list)
    links: list[dict[str, Any]] = field(default_factory=list)
    due_date: str | None = None
    created_at: str = ""
    updated_at: str = ""

    @classmethod
    def from_row(cls, row: Any) -> "WorkProject":
        return cls(
            id=str(row[0]),
            name=str(row[1] or ""),
            description=str(row[2] or ""),
            area=str(row[3] or ""),
            status=str(row[4] or "active"),
            priority=str(row[5] or "medium"),
            tags=[str(x) for x in _json_list(row[6])],
            links=[x for x in _json_list(row[7]) if isinstance(x, dict)],
            due_date=str(row[8]) if row[8] else None,
            created_at=str(row[9] or ""),
            updated_at=str(row[10] or ""),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "area": self.area,
            "status": self.status,
            "priority": self.priority,
            "tags": list(self.tags),
            "links": list(self.links),
            "due_date": self.due_date,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


@dataclass
class WorkProjectLink:
    id: str
    project_id: str
    target_type: str
    target_id: str
    title: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)
    created_at: str = ""

    @classmethod
    def from_row(cls, row: Any) -> "WorkProjectLink":
        return cls(
            id=str(row[0]),
            project_id=str(row[1]),
            target_type=str(row[2]),
            target_id=str(row[3]),
            title=str(row[4] or ""),
            metadata=_json_dict(row[5]),
            created_at=str(row[6] or ""),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "project_id": self.project_id,
            "target_type": self.target_type,
            "target_id": self.target_id,
            "title": self.title,
            "metadata": dict(self.metadata),
            "created_at": self.created_at,
        }
