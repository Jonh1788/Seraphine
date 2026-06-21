"""Dataclasses for the journal module."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any


@dataclass
class JournalEntry:
    id: str
    date: str  # YYYY-MM-DD (America/Sao_Paulo)
    type: str  # day_review | weekly_reflection | manual | voice_memo
    title: str
    content: str
    mood_label: str | None = None
    mood_valence: float | None = None
    source: str = "user"  # proactive | user | voice
    tags: list[str] = field(default_factory=list)
    source_id: str | None = None
    created_at: str = ""  # ISO-8601 UTC
    updated_at: str = ""  # ISO-8601 UTC
    reflection: str | None = None  # short PT-BR Seraphine reflection on the entry

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "date": self.date,
            "type": self.type,
            "title": self.title,
            "content": self.content,
            "mood_label": self.mood_label,
            "mood_valence": self.mood_valence,
            "tags": self.tags,
            "source": self.source,
            "source_id": self.source_id,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "reflection": self.reflection,
        }

    @staticmethod
    def from_row(row: tuple[Any, ...]) -> JournalEntry:
        """Build from a SELECT with ENTRY_COLS column order:

        id, date, type, title, content, mood_label, mood_valence,
        source, tags, source_id, created_at, updated_at, reflection
        """
        tags_raw = row[8]
        if isinstance(tags_raw, str):
            try:
                tags = json.loads(tags_raw)
            except (json.JSONDecodeError, TypeError):
                tags = []
        else:
            tags = tags_raw if tags_raw else []

        return JournalEntry(
            id=str(row[0]),
            date=str(row[1]),
            type=str(row[2]),
            title=str(row[3]),
            content=str(row[4]),
            mood_label=str(row[5]) if row[5] is not None else None,
            mood_valence=float(row[6]) if row[6] is not None else None,
            source=str(row[7]),
            tags=tags,
            source_id=str(row[9]) if row[9] is not None else None,
            created_at=str(row[10]),
            updated_at=str(row[11]),
            reflection=(
                str(row[12])
                if len(row) > 12 and row[12] is not None
                else None
            ),
        )
