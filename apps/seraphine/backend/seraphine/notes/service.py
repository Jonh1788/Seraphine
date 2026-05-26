"""NoteService -- CRUD + search for Markdown notes.

Single-tenant: no user_id scoping. ``tags`` is stored as a JSON array
string in the ``notes.tags`` column. Search is a case-insensitive
``LIKE`` across title/content/tags.

SDD-084 additions:
- Bidirectional [[wiki]] backlinks (note_links table).
- Inline task sync (``- [ ] text`` / ``- [x] text`` -> TaskService).
- Tag aggregation endpoint helper.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Iterable

from core_db import Store

from seraphine.notes.models import Note, NoteRef, TaskSummary

logger = logging.getLogger(__name__)


_NOTE_COLS = "id, title, content, tags, created_at, updated_at"

_VALID_ORDERS = {"updated_at", "created_at", "title"}

# Matches [[note title]] — non-greedy, no nested brackets.
_LINK_RE = re.compile(r"\[\[([^\[\]]+?)\]\]")

# Matches markdown checkboxes:  ``- [ ] text`` and ``- [x] text`` (case-insensitive x).
_TASK_RE = re.compile(r"^[ \t]*-\s+\[([ xX])\]\s+(.+)$", re.MULTILINE)


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


def _extract_links(content: str) -> list[str]:
    """Return deduplicated list of titles referenced via ``[[title]]``."""
    seen: set[str] = set()
    out: list[str] = []
    for m in _LINK_RE.finditer(content or ""):
        title = m.group(1).strip()
        key = title.lower()
        if key and key not in seen:
            seen.add(key)
            out.append(title)
    return out


def _extract_tasks(content: str) -> list[tuple[bool, str]]:
    """Return list of (checked, text) for each checkbox line."""
    out: list[tuple[bool, str]] = []
    for m in _TASK_RE.finditer(content or ""):
        checked = m.group(1).lower() == "x"
        text = m.group(2).strip()
        if text:
            out.append((checked, text))
    return out


class NoteService:
    def __init__(
        self,
        store: Store,
        *,
        task_service: Any | None = None,
    ) -> None:
        self._store = store
        self._task_service = task_service

    # ------------------------------------------------------------------
    # Backlinks helpers (synchronous — run inside asyncio.to_thread)
    # ------------------------------------------------------------------

    def _sync_links_sync(
        self, conn: Any, note_id: str, content: str,
    ) -> None:
        """Extract [[...]] from *content* and upsert note_links rows.

        Missing target notes are created as empty drafts so the link
        resolves immediately.
        """
        titles = _extract_links(content)
        ts = _now_iso()

        # Resolve titles to IDs, creating drafts as needed.
        target_ids: list[str] = []
        for title in titles:
            row = conn.execute(
                "SELECT id FROM notes WHERE LOWER(title) = LOWER(?)",
                (title,),
            ).fetchone()
            if row:
                tid = str(row[0])
            else:
                tid = str(uuid.uuid4())
                conn.execute(
                    "INSERT INTO notes"
                    " (id, title, content, tags, created_at, updated_at)"
                    " VALUES (?, ?, '', '[]', ?, ?)",
                    (tid, title, ts, ts),
                )
            target_ids.append(tid)

        # Delete existing outgoing links and re-insert.
        conn.execute(
            "DELETE FROM note_links WHERE source_id = ?",
            (note_id,),
        )
        for tid in target_ids:
            if tid == note_id:
                continue  # no self-links
            link_id = str(uuid.uuid4())
            conn.execute(
                "INSERT OR IGNORE INTO note_links"
                " (id, source_id, target_id, created_at)"
                " VALUES (?, ?, ?, ?)",
                (link_id, note_id, tid, ts),
            )

    def _get_backlinks_sync(
        self, conn: Any, note_id: str,
    ) -> list[NoteRef]:
        """Return notes that link TO the given note_id."""
        rows = conn.execute(
            "SELECT n.id, n.title FROM note_links l"
            " JOIN notes n ON n.id = l.source_id"
            " WHERE l.target_id = ?",
            (note_id,),
        ).fetchall()
        return [NoteRef(id=str(r[0]), title=str(r[1])) for r in rows]

    # ------------------------------------------------------------------
    # Inline task sync
    # ------------------------------------------------------------------

    def _get_note_tasks_sync(
        self, conn: Any, note_id: str,
    ) -> list[dict[str, Any]]:
        """Return tasks created from this note (source='note',
        payload contains note_id). Uses a direct SQL query so we
        don't depend on TaskService.list_tasks having a source filter."""
        rows = conn.execute(
            "SELECT id, title, status, payload FROM seraphine_tasks"
            " WHERE source = 'note'"
            " AND json_extract(payload, '$.note_id') = ?",
            (note_id,),
        ).fetchall()
        result: list[dict[str, Any]] = []
        for r in rows:
            result.append({
                "id": r[0],
                "title": str(r[1] or ""),
                "status": str(r[2] or ""),
            })
        return result

    async def _sync_inline_tasks(
        self, note_id: str, content: str,
    ) -> None:
        """Sync markdown checkboxes with TaskService.

        For each ``- [ ] text`` / ``- [x] text``:
        - If a task with source='note', payload.note_id=note_id, and
          matching title already exists, update its status if the
          checkbox state changed.
        - Otherwise create a new task.
        """
        if self._task_service is None:
            return

        checkboxes = _extract_tasks(content)
        if not checkboxes:
            return

        # Load existing note-linked tasks via direct SQL.
        def _load_existing() -> list[dict[str, Any]]:
            with self._store._connect() as conn:
                return self._get_note_tasks_sync(conn, note_id)

        existing_rows = await asyncio.to_thread(_load_existing)
        note_tasks: dict[str, dict[str, Any]] = {}
        for t in existing_rows:
            note_tasks[t["title"].strip().lower()] = t

        for checked, text in checkboxes:
            key = text.strip().lower()
            desired_status = "completed" if checked else "pending"
            if key in note_tasks:
                task = note_tasks[key]
                if task["status"] != desired_status:
                    await self._task_service.update_status(
                        task["id"], desired_status,
                    )
            else:
                await self._task_service.create_task(
                    type="generic",
                    title=text,
                    source="note",
                    status=desired_status,
                    payload={"note_id": note_id},
                )

    async def _get_linked_tasks(self, note_id: str) -> list[TaskSummary]:
        """Return tasks created from this note's inline checkboxes."""
        if self._task_service is None:
            return []

        def _work() -> list[TaskSummary]:
            with self._store._connect() as conn:
                rows = self._get_note_tasks_sync(conn, note_id)
            return [
                TaskSummary(id=r["id"], title=r["title"], status=r["status"])
                for r in rows
            ]

        try:
            return await asyncio.to_thread(_work)
        except Exception:
            logger.exception("failed to list note-linked tasks for %s", note_id)
            return []

    # ------------------------------------------------------------------
    # Tag aggregation
    # ------------------------------------------------------------------

    async def get_all_tags(self) -> list[dict[str, Any]]:
        """Return ``[{name, count}, ...]`` aggregated across all notes."""

        def _work() -> list[dict[str, Any]]:
            with self._store._connect() as conn:
                rows = conn.execute(
                    "SELECT tags FROM notes WHERE tags != '[]'",
                ).fetchall()
            counts: dict[str, int] = {}
            for (raw,) in rows:
                try:
                    tags = json.loads(raw)
                except (json.JSONDecodeError, TypeError):
                    continue
                if not isinstance(tags, list):
                    continue
                for t in tags:
                    s = str(t).strip()
                    if s:
                        counts[s] = counts.get(s, 0) + 1
            return sorted(
                [{"name": k, "count": v} for k, v in counts.items()],
                key=lambda x: (-x["count"], x["name"]),
            )

        return await asyncio.to_thread(_work)

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
                # Sync backlinks inside the same connection.
                self._sync_links_sync(conn, nid, body)
                row = conn.execute(
                    f"SELECT {_NOTE_COLS} FROM notes WHERE id = ?",
                    (nid,),
                ).fetchone()
            return Note.from_row(row)

        note = await asyncio.to_thread(_work)

        # Sync inline tasks (async — uses task_service).
        await self._sync_inline_tasks(nid, body)

        return note

    async def get(self, note_id: str) -> Note | None:
        def _work() -> tuple[Note | None, list[NoteRef]]:
            with self._store._connect() as conn:
                row = conn.execute(
                    f"SELECT {_NOTE_COLS} FROM notes WHERE id = ?",
                    (note_id,),
                ).fetchone()
                if not row:
                    return None, []
                note = Note.from_row(row)
                backlinks = self._get_backlinks_sync(conn, note_id)
            return note, backlinks

        note, backlinks = await asyncio.to_thread(_work)
        if note is None:
            return None
        note.backlinks = backlinks
        note.linked_tasks = await self._get_linked_tasks(note_id)
        return note

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
                # Re-sync backlinks if content changed.
                if content is not None:
                    self._sync_links_sync(conn, note_id, content)
                row = conn.execute(
                    f"SELECT {_NOTE_COLS} FROM notes WHERE id = ?",
                    (note_id,),
                ).fetchone()
            return Note.from_row(row) if row else None

        note = await asyncio.to_thread(_work)
        if note is None:
            return None

        # Sync inline tasks when content changed.
        if content is not None:
            await self._sync_inline_tasks(note_id, content)

        # Enrich with backlinks + linked tasks.
        def _load_backlinks() -> list[NoteRef]:
            with self._store._connect() as conn:
                return self._get_backlinks_sync(conn, note_id)

        note.backlinks = await asyncio.to_thread(_load_backlinks)
        note.linked_tasks = await self._get_linked_tasks(note_id)
        return note

    async def delete(self, note_id: str) -> bool:
        def _work() -> int:
            with self._store._connect() as conn:
                cur = conn.execute(
                    "DELETE FROM notes WHERE id = ?",
                    (note_id,),
                )
                # Clean up link references.
                conn.execute(
                    "DELETE FROM note_links WHERE source_id = ? OR target_id = ?",
                    (note_id, note_id),
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
        tag: str | None = None,
    ) -> list[Note]:
        if order not in _VALID_ORDERS:
            order = "updated_at"
        lim = max(1, min(int(limit), 500))
        off = max(0, int(offset))

        def _work() -> list[Note]:
            with self._store._connect() as conn:
                if tag:
                    # Filter notes whose JSON tags array contains the tag.
                    # SQLite JSON: use LIKE on the raw JSON string for simplicity.
                    like_pattern = f'%"{tag}"%'
                    rows = conn.execute(
                        f"SELECT {_NOTE_COLS} FROM notes"
                        " WHERE tags LIKE ?"
                        f" ORDER BY {order} DESC"
                        " LIMIT ? OFFSET ?",
                        (like_pattern, lim, off),
                    ).fetchall()
                else:
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
