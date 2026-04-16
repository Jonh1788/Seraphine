"""Dataclass for the notes module (single-tenant, no user_id)."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any


@dataclass
class Note:
    id: str  # UUID4
    title: str
    content: str = ""
    tags: list[str] = field(default_factory=list)
    created_at: str = ""
    updated_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "content": self.content,
            "tags": list(self.tags or []),
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_row(cls, row: tuple[Any, ...]) -> "Note":
        """Map a row of (id, title, content, tags_json, created_at, updated_at)."""
        tags: list[str] = []
        raw_tags = row[3]
        if raw_tags:
            try:
                val = json.loads(raw_tags)
                if isinstance(val, list):
                    tags = [str(t) for t in val if isinstance(t, (str, int, float))]
            except (json.JSONDecodeError, TypeError):
                tags = []
        return cls(
            id=str(row[0]),
            title=str(row[1] or ""),
            content=str(row[2] or ""),
            tags=tags,
            created_at=str(row[4] or ""),
            updated_at=str(row[5] or ""),
        )
