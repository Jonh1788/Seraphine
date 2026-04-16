"""NoteService -- CRUD + search for Markdown notes.

Single-tenant: no user_id scoping. ``tags`` is stored as a JSON array
string in the ``notes.tags`` column. Search is a case-insensitive
``LIKE`` across title/content/tags.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Iterable

from core_db import Store

from seraphine.notes.models import Note

logger = logging.getLogger(__name__)


_NOTE_COLS = "id, title, content, tags, created_at, updated_at"

_VALID_ORDERS = {"updated_at", "created_at", "title"}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalize_tags(tags: Iterable[Any] | None) -> list[str]:
    if not tags:
        return []
    out: list[str] = []
    seen: set[str] = set()
    for t in tags:
        if t is None:
            continue
        s = str(t).strip()
        if not s:
            continue
        if s in seen:
            continue
        seen.add(s)
        out.append(s)
    return out


def _serialize_tags(tags: Iterable[Any] | None) -> str:
    return json.dumps(_normalize_tags(tags), ensure_ascii=False)


class NoteService:
    def __init__(self, store: Store) -> None:
        self._store = store

    # ------------------------------------------------------------------
    # CRUD
    # ------------------------------------------------------------------

    async def create(
        self,
        *,
        title: str,
        content: str = "",
        tags: Iterable[Any] | None = None,
    ) -> Note:
        title = (title or "").strip()
        if not title:
            raise ValueError("title is required")

        nid = str(uuid.uuid4())
        ts = _now_iso()
        body = content if content is not None else ""
        tags_json = _serialize_tags(tags)

        def _work() -> Note:
            with self._store._connect() as conn:
                conn.execute(
                    "INSERT INTO notes"
                    " (id, title, content, tags, created_at, updated_at)"
                    " VALUES (?, ?, ?, ?, ?, ?)",
                    (nid, title, body, tags_json, ts, ts),
                )
                row = conn.execute(
                    f"SELECT {_NOTE_COLS} FROM notes WHERE id = ?",
                    (nid,),
                ).fetchone()
            return Note.from_row(row)

        return await asyncio.to_thread(_work)

    async def get(self, note_id: str) -> Note | None:
        def _work() -> Note | None:
            with self._store._connect() as conn:
                row = conn.execute(
                    f"SELECT {_NOTE_COLS} FROM notes WHERE id = ?",
                    (note_id,),
                ).fetchone()
            return Note.from_row(row) if row else None

        return await asyncio.to_thread(_work)

    async def update(
        self,
        note_id: str,
        *,
        title: str | None = None,
        content: str | None = None,
        tags: Iterable[Any] | None = None,
    ) -> Note | None:
        """Patch-style update. Any provided field is set; ``updated_at``
        is bumped whenever at least one field changes."""
        sets: list[str] = []
        params: list[Any] = []

        if title is not None:
            clean = str(title).strip()
            if not clean:
                raise ValueError("title cannot be empty")
            sets.append("title = ?")
            params.append(clean)

        if content is not None:
            sets.append("content = ?")
            params.append(str(content))

        if tags is not None:
            sets.append("tags = ?")
            params.append(_serialize_tags(tags))

        if not sets:
            return await self.get(note_id)

        sets.append("updated_at = ?")
        params.append(_now_iso())
        params.append(note_id)

        def _work() -> Note | None:
            with self._store._connect() as conn:
                cur = conn.execute(
                    f"UPDATE notes SET {', '.join(sets)} WHERE id = ?",
                    params,
                )
                if (cur.rowcount or 0) == 0:
                    return None
                row = conn.execute(
                    f"SELECT {_NOTE_COLS} FROM notes WHERE id = ?",
                    (note_id,),
                ).fetchone()
            return Note.from_row(row) if row else None

        return await asyncio.to_thread(_work)

    async def delete(self, note_id: str) -> bool:
        def _work() -> int:
            with self._store._connect() as conn:
                cur = conn.execute(
                    "DELETE FROM notes WHERE id = ?",
                    (note_id,),
                )
                return cur.rowcount or 0

        affected = await asyncio.to_thread(_work)
        return affected > 0

    async def list(
        self,
        *,
        limit: int = 50,
        offset: int = 0,
        order: str = "updated_at",
    ) -> list[Note]:
        if order not in _VALID_ORDERS:
            order = "updated_at"
        lim = max(1, min(int(limit), 500))
        off = max(0, int(offset))

        def _work() -> list[Note]:
            with self._store._connect() as conn:
                rows = conn.execute(
                    f"SELECT {_NOTE_COLS} FROM notes"
                    f" ORDER BY {order} DESC"
                    " LIMIT ? OFFSET ?",
                    (lim, off),
                ).fetchall()
            return [Note.from_row(r) for r in rows]

        return await asyncio.to_thread(_work)

    async def search(
        self, query: str, *, limit: int = 50,
    ) -> list[Note]:
        q = (query or "").strip()
        if not q:
            return await self.list(limit=limit)
        lim = max(1, min(int(limit), 500))
        like = f"%{q}%"

        def _work() -> list[Note]:
            with self._store._connect() as conn:
                rows = conn.execute(
                    f"SELECT {_NOTE_COLS} FROM notes"
                    " WHERE LOWER(title) LIKE LOWER(?)"
                    " OR LOWER(content) LIKE LOWER(?)"
                    " OR LOWER(tags) LIKE LOWER(?)"
                    " ORDER BY updated_at DESC"
                    " LIMIT ?",
                    (like, like, like, lim),
                ).fetchall()
            return [Note.from_row(r) for r in rows]

        return await asyncio.to_thread(_work)
