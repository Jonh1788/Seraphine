"""KnowledgeService — CRUD notebooks + notes + simple LIKE search.

Search uses SQLite LIKE on title + content_md. Fine until we hit ~10k
notes per user, at which point we switch to FTS5. Until then the cost
of the index isn't worth the complexity.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timezone
from typing import Any

from core_db import Store

from aura.knowledge.models import Note, Notebook


_NOTEBOOK_COLS = "id, user_id, name, color, created_at, updated_at"
_NOTE_COLS = (
    "id, notebook_id, user_id, title, content_md, created_at, updated_at"
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row_to_notebook(row: tuple[Any, ...], note_count: int = 0) -> Notebook:
    return Notebook(
        id=row[0],
        user_id=row[1],
        name=row[2],
        color=row[3],
        created_at=row[4],
        updated_at=row[5],
        note_count=note_count,
    )


def _row_to_note(row: tuple[Any, ...]) -> Note:
    return Note(
        id=row[0],
        notebook_id=row[1],
        user_id=row[2],
        title=row[3],
        content_md=row[4] or "",
        created_at=row[5],
        updated_at=row[6],
    )


class KnowledgeService:
    def __init__(self, store: Store) -> None:
        self._store = store

    async def aclose(self) -> None:  # pragma: no cover
        pass

    # ---- Notebooks ----------------------------------------------------

    async def list_notebooks(self, user_id: str) -> list[Notebook]:
        def _work() -> list[Notebook]:
            with self._store._connect() as conn:
                rows = conn.execute(
                    f"SELECT n.id, n.user_id, n.name, n.color, n.created_at,"
                    f" n.updated_at, COUNT(notes.id) FROM notebooks n"
                    " LEFT JOIN notes ON notes.notebook_id = n.id"
                    " WHERE n.user_id = ?"
                    " GROUP BY n.id"
                    " ORDER BY n.updated_at DESC",
                    (user_id,),
                ).fetchall()
            return [_row_to_notebook(r[:6], note_count=int(r[6] or 0)) for r in rows]

        return await asyncio.to_thread(_work)

    async def create_notebook(
        self, *, user_id: str, name: str, color: str = "chat",
    ) -> Notebook:
        nb = Notebook(
            id=str(uuid.uuid4()),
            user_id=user_id,
            name=name.strip(),
            color=color,
            created_at=_now_iso(),
            updated_at=_now_iso(),
        )

        def _work() -> None:
            with self._store._connect() as conn:
                conn.execute(
                    f"INSERT INTO notebooks ({_NOTEBOOK_COLS})"
                    " VALUES (?, ?, ?, ?, ?, ?)",
                    (nb.id, nb.user_id, nb.name, nb.color, nb.created_at, nb.updated_at),
                )

        await asyncio.to_thread(_work)
        return nb

    async def delete_notebook(self, notebook_id: str, user_id: str) -> int:
        def _work() -> int:
            with self._store._connect() as conn:
                cur = conn.execute(
                    "DELETE FROM notebooks WHERE id = ? AND user_id = ?",
                    (notebook_id, user_id),
                )
            return cur.rowcount

        return await asyncio.to_thread(_work)

    async def rename_notebook(
        self, notebook_id: str, user_id: str, *, name: str,
    ) -> Notebook | None:
        ts = _now_iso()

        def _work() -> Notebook | None:
            with self._store._connect() as conn:
                cur = conn.execute(
                    "UPDATE notebooks SET name = ?, updated_at = ?"
                    " WHERE id = ? AND user_id = ?",
                    (name.strip(), ts, notebook_id, user_id),
                )
                if cur.rowcount == 0:
                    return None
                row = conn.execute(
                    f"SELECT {_NOTEBOOK_COLS} FROM notebooks WHERE id = ?",
                    (notebook_id,),
                ).fetchone()
            return _row_to_notebook(row) if row else None

        return await asyncio.to_thread(_work)

    # ---- Notes --------------------------------------------------------

    async def list_notes(
        self, notebook_id: str, user_id: str, *, limit: int = 200,
    ) -> list[Note]:
        def _work() -> list[Note]:
            with self._store._connect() as conn:
                rows = conn.execute(
                    f"SELECT {_NOTE_COLS} FROM notes"
                    " WHERE notebook_id = ? AND user_id = ?"
                    " ORDER BY updated_at DESC LIMIT ?",
                    (notebook_id, user_id, limit),
                ).fetchall()
            return [_row_to_note(r) for r in rows]

        return await asyncio.to_thread(_work)

    async def get_note(self, note_id: str, user_id: str) -> Note | None:
        def _work() -> Note | None:
            with self._store._connect() as conn:
                row = conn.execute(
                    f"SELECT {_NOTE_COLS} FROM notes"
                    " WHERE id = ? AND user_id = ?",
                    (note_id, user_id),
                ).fetchone()
            return _row_to_note(row) if row else None

        return await asyncio.to_thread(_work)

    async def create_note(
        self,
        *,
        notebook_id: str,
        user_id: str,
        title: str | None = None,
        content_md: str = "",
    ) -> Note | None:
        ts = _now_iso()
        note = Note(
            id=str(uuid.uuid4()),
            notebook_id=notebook_id,
            user_id=user_id,
            title=title.strip() if title else None,
            content_md=content_md,
            created_at=ts,
            updated_at=ts,
        )

        def _work() -> Note | None:
            with self._store._connect() as conn:
                # Confirm the notebook belongs to this user.
                exists = conn.execute(
                    "SELECT 1 FROM notebooks WHERE id = ? AND user_id = ?",
                    (notebook_id, user_id),
                ).fetchone()
                if not exists:
                    return None
                conn.execute(
                    f"INSERT INTO notes ({_NOTE_COLS})"
                    " VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (
                        note.id, note.notebook_id, note.user_id,
                        note.title, note.content_md, note.created_at,
                        note.updated_at,
                    ),
                )
                conn.execute(
                    "UPDATE notebooks SET updated_at = ? WHERE id = ?",
                    (ts, notebook_id),
                )
            return note

        return await asyncio.to_thread(_work)

    async def update_note(
        self,
        note_id: str,
        user_id: str,
        *,
        title: str | None = None,
        content_md: str | None = None,
    ) -> Note | None:
        sets: list[str] = []
        params: list[object] = []
        if title is not None:
            sets.append("title = ?")
            params.append(title.strip() or None)
        if content_md is not None:
            sets.append("content_md = ?")
            params.append(content_md)
        if not sets:
            return await self.get_note(note_id, user_id)
        ts = _now_iso()
        sets.append("updated_at = ?")
        params.append(ts)

        def _work() -> Note | None:
            with self._store._connect() as conn:
                row = conn.execute(
                    "SELECT notebook_id FROM notes WHERE id = ? AND user_id = ?",
                    (note_id, user_id),
                ).fetchone()
                if row is None:
                    return None
                notebook_id = row[0]
                conn.execute(
                    f"UPDATE notes SET {', '.join(sets)}"
                    " WHERE id = ? AND user_id = ?",
                    (*params, note_id, user_id),
                )
                conn.execute(
                    "UPDATE notebooks SET updated_at = ? WHERE id = ?",
                    (ts, notebook_id),
                )
                row = conn.execute(
                    f"SELECT {_NOTE_COLS} FROM notes WHERE id = ?",
                    (note_id,),
                ).fetchone()
            return _row_to_note(row) if row else None

        return await asyncio.to_thread(_work)

    async def delete_note(self, note_id: str, user_id: str) -> int:
        def _work() -> int:
            with self._store._connect() as conn:
                cur = conn.execute(
                    "DELETE FROM notes WHERE id = ? AND user_id = ?",
                    (note_id, user_id),
                )
            return cur.rowcount

        return await asyncio.to_thread(_work)

    # ---- Search -------------------------------------------------------

    async def search(
        self, user_id: str, query: str, *, limit: int = 20,
    ) -> list[Note]:
        q = query.strip()
        if not q:
            return []
        like = f"%{q}%"

        def _work() -> list[Note]:
            with self._store._connect() as conn:
                rows = conn.execute(
                    f"SELECT {_NOTE_COLS} FROM notes"
                    " WHERE user_id = ? AND ("
                    "  (title IS NOT NULL AND title LIKE ?)"
                    "  OR content_md LIKE ?"
                    " )"
                    " ORDER BY updated_at DESC LIMIT ?",
                    (user_id, like, like, limit),
                ).fetchall()
            return [_row_to_note(r) for r in rows]

        return await asyncio.to_thread(_work)
