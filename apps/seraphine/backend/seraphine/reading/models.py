"""Dataclass for the reading list module (single-tenant, no user_id)."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any


@dataclass
class ReadingItem:
    id: str  # UUID4
    url: str
    title: str = ""
    domain: str = ""
    summary: str = ""
    content_text: str | None = None
    tags: list[str] = field(default_factory=list)
    status: str = "processing"  # processing | unread | reading | read | archived | error
    saved_at: str = ""
    read_at: str | None = None
    archived_at: str | None = None
    error_msg: str | None = None
    author: str = ""  # parsed from page metadata (meta/OG/JSON-LD); may be ""
    progress: int = 0  # percent read, 0-100 (0 == not started)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "url": self.url,
            "title": self.title,
            "domain": self.domain,
            "summary": self.summary,
            "content_text": self.content_text,
            "tags": list(self.tags or []),
            "status": self.status,
            "saved_at": self.saved_at,
            "read_at": self.read_at,
            "archived_at": self.archived_at,
            "error_msg": self.error_msg,
            "author": self.author,
            "progress": self.progress,
        }

    @classmethod
    def from_row(cls, row: tuple[Any, ...]) -> "ReadingItem":
        """Map a row of (id, url, title, domain, summary, content_text,
        tags_json, status, saved_at, read_at, archived_at, error_msg,
        author, progress)."""
        tags: list[str] = []
        raw_tags = row[6]
        if raw_tags:
            try:
                val = json.loads(raw_tags)
                if isinstance(val, list):
                    tags = [str(t) for t in val if isinstance(t, (str, int, float))]
            except (json.JSONDecodeError, TypeError):
                tags = []
        return cls(
            id=str(row[0]),
            url=str(row[1] or ""),
            title=str(row[2] or ""),
            domain=str(row[3] or ""),
            summary=str(row[4] or ""),
            content_text=row[5] if row[5] is not None else None,
            tags=tags,
            status=str(row[7] or "processing"),
            saved_at=str(row[8] or ""),
            read_at=str(row[9]) if row[9] else None,
            archived_at=str(row[10]) if row[10] else None,
            error_msg=str(row[11]) if row[11] else None,
            author=str(row[12]) if len(row) > 12 and row[12] else "",
            progress=int(row[13]) if len(row) > 13 and row[13] is not None else 0,
        )
