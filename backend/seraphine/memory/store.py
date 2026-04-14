from __future__ import annotations

import asyncio
import json
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel


class Turn(BaseModel):
    id: str
    conversation_id: str
    role: str
    content: str
    created_at: str
    token_count: int | None = None


class ToolAudit(BaseModel):
    id: str
    request_id: str
    tool: str
    args_json: str
    approved: int | None
    ok: int | None
    output_excerpt: str | None
    error: str | None
    created_at: str


class Fact(BaseModel):
    id: str
    text: str
    source: Literal["explicit", "reflection", "user_taught"]
    confidence: float
    created_at: str
    superseded_by: str | None = None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row_to_task(row: tuple[Any, ...]) -> dict[str, Any]:
    """Convert a seraphine_tasks row into a dict, parsing payload JSON.

    The SELECT clause for tasks is stable:
      id, type, status, title, description, source, payload,
      created_at, updated_at, due_date
    """
    raw_payload = row[6]
    try:
        payload = json.loads(raw_payload) if raw_payload else {}
    except (json.JSONDecodeError, TypeError):
        payload = {}
    return {
        "id": row[0],
        "type": row[1],
        "status": row[2],
        "title": row[3],
        "description": row[4],
        "source": row[5],
        "payload": payload,
        "created_at": row[7],
        "updated_at": row[8],
        "due_date": row[9] if len(row) > 9 else None,
    }


def _row_to_event(row: tuple[Any, ...]) -> dict[str, Any]:
    """Convert an event_timeline row into a dict, parsing metadata JSON."""
    raw_meta = row[4]
    try:
        metadata = json.loads(raw_meta) if raw_meta else {}
    except (json.JSONDecodeError, TypeError):
        metadata = {}
    return {
        "id": row[0],
        "event_type": row[1],
        "summary": row[2],
        "source": row[3],
        "metadata": metadata,
        "created_at": row[5],
    }


class MemoryStore:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._conn: sqlite3.Connection | None = None

    def _connect(self) -> sqlite3.Connection:
        if self._conn is not None:
            return self._conn
        conn = sqlite3.connect(self.path, check_same_thread=False)
        conn.execute("PRAGMA foreign_keys = ON")
        self._conn = conn
        return conn

    async def aclose(self) -> None:
        """Close the persistent connection."""
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    async def ensure_schema(self) -> None:
        def _work() -> None:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self._connect() as conn:
                conn.executescript(
                    """
                    CREATE TABLE IF NOT EXISTS conversations (
                      id          TEXT PRIMARY KEY,
                      created_at  TEXT NOT NULL
                    );
                    CREATE TABLE IF NOT EXISTS turns (
                      id              TEXT PRIMARY KEY,
                      conversation_id TEXT NOT NULL REFERENCES conversations(id),
                      role            TEXT NOT NULL CHECK (role IN ('user','assistant')),
                      content         TEXT NOT NULL,
                      created_at      TEXT NOT NULL,
                      token_count     INTEGER
                    );
                    CREATE INDEX IF NOT EXISTS idx_turns_conv
                      ON turns(conversation_id, created_at);
                    CREATE TABLE IF NOT EXISTS facts (
                      id            TEXT PRIMARY KEY,
                      text          TEXT NOT NULL,
                      source        TEXT NOT NULL,
                      confidence    REAL NOT NULL,
                      created_at    TEXT NOT NULL,
                      superseded_by TEXT REFERENCES facts(id)
                    );
                    CREATE INDEX IF NOT EXISTS idx_facts_created
                      ON facts(created_at DESC);
                    CREATE TABLE IF NOT EXISTS conversation_summaries (
                      id              TEXT PRIMARY KEY,
                      conversation_id TEXT NOT NULL REFERENCES conversations(id),
                      summary         TEXT NOT NULL,
                      up_to_turn_id   TEXT NOT NULL,
                      created_at      TEXT NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_summaries_conv
                      ON conversation_summaries(conversation_id, created_at DESC);
                    CREATE TABLE IF NOT EXISTS notifications (
                      id         TEXT PRIMARY KEY,
                      event      TEXT NOT NULL,
                      task_id    TEXT,
                      title      TEXT,
                      summary    TEXT,
                      payload    TEXT NOT NULL,
                      read       INTEGER NOT NULL DEFAULT 0,
                      created_at TEXT NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_notif_unread
                      ON notifications(read, created_at DESC);
                    CREATE TABLE IF NOT EXISTS tool_audit (
                      id             TEXT PRIMARY KEY,
                      request_id     TEXT NOT NULL,
                      tool           TEXT NOT NULL,
                      args_json      TEXT NOT NULL,
                      approved       INTEGER,
                      ok             INTEGER,
                      output_excerpt TEXT,
                      error          TEXT,
                      created_at     TEXT NOT NULL
                    );
                    CREATE TABLE IF NOT EXISTS event_timeline (
                      id          INTEGER PRIMARY KEY AUTOINCREMENT,
                      event_type  TEXT NOT NULL,
                      summary     TEXT NOT NULL,
                      source      TEXT NOT NULL,
                      metadata    TEXT NOT NULL DEFAULT '{}',
                      created_at  TEXT NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_event_timeline_created
                      ON event_timeline(created_at DESC);
                    CREATE INDEX IF NOT EXISTS idx_event_timeline_source
                      ON event_timeline(source, created_at DESC);
                    CREATE TABLE IF NOT EXISTS seraphine_tasks (
                      id            INTEGER PRIMARY KEY AUTOINCREMENT,
                      type          TEXT NOT NULL,
                      status        TEXT NOT NULL DEFAULT 'pending',
                      title         TEXT NOT NULL,
                      description   TEXT NOT NULL,
                      source        TEXT NOT NULL,
                      payload       TEXT NOT NULL,
                      created_at    TEXT NOT NULL,
                      updated_at    TEXT NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_seraphine_tasks_status
                      ON seraphine_tasks(status);
                    CREATE INDEX IF NOT EXISTS idx_seraphine_tasks_type
                      ON seraphine_tasks(type);
                    """
                )
                # Lightweight migration: add due_date column on old DBs.
                # SQLite has no IF NOT EXISTS for ADD COLUMN, so we swallow
                # the "duplicate column name" OperationalError idempotently.
                try:
                    conn.execute(
                        "ALTER TABLE seraphine_tasks ADD COLUMN due_date TEXT"
                    )
                except sqlite3.OperationalError as exc:
                    if "duplicate column name" not in str(exc).lower():
                        raise
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_seraphine_tasks_due_date"
                    " ON seraphine_tasks(due_date)"
                )

        await asyncio.to_thread(_work)

    async def create_conversation(self) -> str:
        conv_id = str(uuid.uuid4())

        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO conversations(id, created_at) VALUES (?, ?)",
                    (conv_id, _now()),
                )

        await asyncio.to_thread(_work)
        return conv_id

    async def ensure_conversation(self, conv_id: str) -> None:
        """Create conversation if it doesn't exist (INSERT OR IGNORE)."""
        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "INSERT OR IGNORE INTO conversations(id, created_at) VALUES (?, ?)",
                    (conv_id, _now()),
                )
        await asyncio.to_thread(_work)

    async def add_turn(
        self,
        conversation_id: str,
        role: str,
        content: str,
        token_count: int | None = None,
    ) -> Turn:
        turn = Turn(
            id=str(uuid.uuid4()),
            conversation_id=conversation_id,
            role=role,
            content=content,
            created_at=_now(),
            token_count=token_count,
        )

        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO turns(id, conversation_id, role, content, created_at, token_count)"
                    " VALUES (?, ?, ?, ?, ?, ?)",
                    (
                        turn.id,
                        turn.conversation_id,
                        turn.role,
                        turn.content,
                        turn.created_at,
                        turn.token_count,
                    ),
                )

        await asyncio.to_thread(_work)
        return turn

    async def get_recent_turns(self, *, limit: int = 100) -> list[Turn]:
        """Most recent turns across ALL conversations, oldest first."""

        def _work() -> list[Turn]:
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT id, conversation_id, role, content, created_at, token_count"
                    " FROM turns ORDER BY created_at DESC LIMIT ?",
                    (limit,),
                ).fetchall()
            return list(
                reversed(
                    [
                        Turn(
                            id=r[0],
                            conversation_id=r[1],
                            role=r[2],
                            content=r[3],
                            created_at=r[4],
                            token_count=r[5],
                        )
                        for r in rows
                    ]
                )
            )

        return await asyncio.to_thread(_work)

    async def get_turns(self, conversation_id: str, *, limit: int = 500) -> list[Turn]:
        def _work() -> list[Turn]:
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT id, conversation_id, role, content, created_at, token_count"
                    " FROM turns WHERE conversation_id = ? ORDER BY created_at ASC"
                    " LIMIT ?",
                    (conversation_id, limit),
                ).fetchall()
            return [
                Turn(
                    id=r[0],
                    conversation_id=r[1],
                    role=r[2],
                    content=r[3],
                    created_at=r[4],
                    token_count=r[5],
                )
                for r in rows
            ]

        return await asyncio.to_thread(_work)

    # ---------- conversation summaries ----------

    async def get_summary(self, conversation_id: str) -> tuple[str, str] | None:
        """Return (summary, up_to_turn_id) for the latest summary, or None."""

        def _work() -> tuple[str, str] | None:
            with self._connect() as conn:
                row = conn.execute(
                    "SELECT summary, up_to_turn_id FROM conversation_summaries"
                    " WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1",
                    (conversation_id,),
                ).fetchone()
            if row is None:
                return None
            return (row[0], row[1])

        return await asyncio.to_thread(_work)

    async def save_summary(
        self, conversation_id: str, summary: str, up_to_turn_id: str
    ) -> None:
        sid = str(uuid.uuid4())

        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO conversation_summaries"
                    "(id, conversation_id, summary, up_to_turn_id, created_at)"
                    " VALUES (?, ?, ?, ?, ?)",
                    (sid, conversation_id, summary, up_to_turn_id, _now()),
                )

        await asyncio.to_thread(_work)

    # ---------- notifications ----------

    async def add_notification(
        self, event: str, task_id: str, title: str, summary: str, payload: str,
    ) -> str:
        nid = str(uuid.uuid4())

        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO notifications(id, event, task_id, title, summary, payload, read, created_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
                    (nid, event, task_id, title, summary, payload, _now()),
                )

        await asyncio.to_thread(_work)
        return nid

    async def get_unread_notifications(self, limit: int = 50) -> list[dict[str, Any]]:
        def _work() -> list[dict[str, Any]]:
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT id, event, task_id, title, summary, payload, created_at"
                    " FROM notifications WHERE read = 0"
                    " ORDER BY created_at DESC LIMIT ?",
                    (limit,),
                ).fetchall()
            return [
                {"id": r[0], "event": r[1], "task_id": r[2], "title": r[3],
                 "summary": r[4], "payload": r[5], "created_at": r[6]}
                for r in rows
            ]

        return await asyncio.to_thread(_work)

    async def mark_notifications_read(self, ids: list[str]) -> None:
        if not ids:
            return

        def _work() -> None:
            with self._connect() as conn:
                placeholders = ",".join("?" for _ in ids)
                conn.execute(
                    f"UPDATE notifications SET read = 1 WHERE id IN ({placeholders})",
                    ids,
                )

        await asyncio.to_thread(_work)

    # ---------- recent conversations ----------

    async def get_recent_conversations(self, limit: int = 20) -> list[dict[str, Any]]:
        """Return recent conversations with their first user message as preview."""

        def _work() -> list[dict[str, Any]]:
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT c.id, c.created_at,"
                    " (SELECT content FROM turns WHERE conversation_id = c.id"
                    "  AND role = 'user' ORDER BY created_at ASC LIMIT 1) AS preview"
                    " FROM conversations c ORDER BY c.created_at DESC LIMIT ?",
                    (limit,),
                ).fetchall()
            results = []
            for r in rows:
                preview = r[2] or ""
                if len(preview) > 100:
                    preview = preview[:100] + "..."
                results.append({"id": r[0], "created_at": r[1], "preview": preview})
            return results

        return await asyncio.to_thread(_work)

    # ---------- facts ----------

    async def add_fact(self, text: str, source: str, confidence: float) -> Fact:
        fact = Fact(
            id=str(uuid.uuid4()),
            text=text,
            source=source,  # type: ignore[arg-type]
            confidence=confidence,
            created_at=_now(),
        )

        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO facts(id, text, source, confidence, created_at, superseded_by)"
                    " VALUES (?, ?, ?, ?, ?, NULL)",
                    (fact.id, fact.text, fact.source, fact.confidence, fact.created_at),
                )

        await asyncio.to_thread(_work)
        return fact

    async def list_facts(
        self, *, limit: int = 50, include_superseded: bool = False
    ) -> list[Fact]:
        def _work() -> list[Fact]:
            with self._connect() as conn:
                if include_superseded:
                    rows = conn.execute(
                        "SELECT id, text, source, confidence, created_at, superseded_by"
                        " FROM facts ORDER BY created_at DESC LIMIT ?",
                        (limit,),
                    ).fetchall()
                else:
                    rows = conn.execute(
                        "SELECT id, text, source, confidence, created_at, superseded_by"
                        " FROM facts WHERE superseded_by IS NULL"
                        " ORDER BY created_at DESC LIMIT ?",
                        (limit,),
                    ).fetchall()
            return [
                Fact(
                    id=r[0],
                    text=r[1],
                    source=r[2],
                    confidence=r[3],
                    created_at=r[4],
                    superseded_by=r[5],
                )
                for r in rows
            ]

        return await asyncio.to_thread(_work)

    async def supersede_fact(self, old_id: str, new_id: str | None = None) -> None:
        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "UPDATE facts SET superseded_by = ? WHERE id = ?",
                    (new_id, old_id),
                )

        await asyncio.to_thread(_work)

    async def update_fact(self, fact_id: str, text: str | None = None, confidence: float | None = None) -> Fact | None:
        def _work() -> Fact | None:
            with self._connect() as conn:
                parts: list[str] = []
                vals: list[Any] = []
                if text is not None:
                    parts.append("text = ?")
                    vals.append(text)
                if confidence is not None:
                    parts.append("confidence = ?")
                    vals.append(confidence)
                if not parts:
                    return None
                vals.append(fact_id)
                conn.execute(
                    f"UPDATE facts SET {', '.join(parts)} WHERE id = ?",
                    vals,
                )
                row = conn.execute(
                    "SELECT id, text, source, confidence, created_at, superseded_by"
                    " FROM facts WHERE id = ?",
                    (fact_id,),
                ).fetchone()
            if row is None:
                return None
            return Fact(
                id=row[0], text=row[1], source=row[2],
                confidence=row[3], created_at=row[4], superseded_by=row[5],
            )

        return await asyncio.to_thread(_work)

    async def delete_fact(self, fact_id: str) -> bool:
        def _work() -> bool:
            with self._connect() as conn:
                cur = conn.execute("DELETE FROM facts WHERE id = ?", (fact_id,))
                return cur.rowcount > 0

        return await asyncio.to_thread(_work)

    # ---------- tool audit ----------

    async def add_tool_audit(
        self,
        *,
        request_id: str,
        tool: str,
        args_json: str,
        approved: int | None,
        ok: int | None,
        output_excerpt: str | None,
        error: str | None,
    ) -> ToolAudit:
        audit = ToolAudit(
            id=str(uuid.uuid4()),
            request_id=request_id,
            tool=tool,
            args_json=args_json,
            approved=approved,
            ok=ok,
            output_excerpt=output_excerpt,
            error=error,
            created_at=_now(),
        )

        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO tool_audit(id, request_id, tool, args_json, approved,"
                    " ok, output_excerpt, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        audit.id,
                        audit.request_id,
                        audit.tool,
                        audit.args_json,
                        audit.approved,
                        audit.ok,
                        audit.output_excerpt,
                        audit.error,
                        audit.created_at,
                    ),
                )

        await asyncio.to_thread(_work)
        return audit

    async def list_tool_audit(self, limit: int = 50) -> list[ToolAudit]:
        def _work() -> list[ToolAudit]:
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT id, request_id, tool, args_json, approved, ok,"
                    " output_excerpt, error, created_at FROM tool_audit"
                    " ORDER BY created_at DESC LIMIT ?",
                    (limit,),
                ).fetchall()
            return [
                ToolAudit(
                    id=r[0],
                    request_id=r[1],
                    tool=r[2],
                    args_json=r[3],
                    approved=r[4],
                    ok=r[5],
                    output_excerpt=r[6],
                    error=r[7],
                    created_at=r[8],
                )
                for r in rows
            ]

        return await asyncio.to_thread(_work)

    # ---------- event timeline ----------

    async def add_event(
        self,
        event_type: str,
        summary: str,
        source: str,
        metadata: dict[str, Any] | None = None,
    ) -> int:
        """Append a lightweight event to the timeline. Returns the row id."""
        meta_json = json.dumps(metadata or {}, ensure_ascii=False)
        created_at = _now()

        def _work() -> int:
            with self._connect() as conn:
                cur = conn.execute(
                    "INSERT INTO event_timeline(event_type, summary, source, metadata, created_at)"
                    " VALUES (?, ?, ?, ?, ?)",
                    (event_type, summary, source, meta_json, created_at),
                )
                return int(cur.lastrowid or 0)

        return await asyncio.to_thread(_work)

    async def get_recent_events(
        self, limit: int = 20, source: str | None = None,
    ) -> list[dict[str, Any]]:
        """Return recent events ordered from newest to oldest.

        If ``source`` is provided, filters to that source only.
        """

        def _work() -> list[dict[str, Any]]:
            with self._connect() as conn:
                if source is None:
                    rows = conn.execute(
                        "SELECT id, event_type, summary, source, metadata, created_at"
                        " FROM event_timeline ORDER BY created_at DESC, id DESC LIMIT ?",
                        (limit,),
                    ).fetchall()
                else:
                    rows = conn.execute(
                        "SELECT id, event_type, summary, source, metadata, created_at"
                        " FROM event_timeline WHERE source = ?"
                        " ORDER BY created_at DESC, id DESC LIMIT ?",
                        (source, limit),
                    ).fetchall()
            return [_row_to_event(r) for r in rows]

        return await asyncio.to_thread(_work)

    async def get_events_since(self, since: str) -> list[dict[str, Any]]:
        """Return events with created_at >= ``since`` (ISO datetime string)."""

        def _work() -> list[dict[str, Any]]:
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT id, event_type, summary, source, metadata, created_at"
                    " FROM event_timeline WHERE created_at >= ?"
                    " ORDER BY created_at DESC, id DESC",
                    (since,),
                ).fetchall()
            return [_row_to_event(r) for r in rows]

        return await asyncio.to_thread(_work)

    # ---------- seraphine internal tasks ----------

    async def add_task(
        self,
        *,
        type: str,
        status: str,
        title: str,
        description: str,
        source: str,
        payload: dict[str, Any],
        due_date: str | None = None,
    ) -> int:
        """Insert a new internal task and return its autoincrement id."""
        ts = _now()
        payload_json = json.dumps(payload or {}, ensure_ascii=False)

        def _work() -> int:
            with self._connect() as conn:
                cur = conn.execute(
                    "INSERT INTO seraphine_tasks"
                    "(type, status, title, description, source, payload,"
                    " created_at, updated_at, due_date)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (type, status, title, description, source,
                     payload_json, ts, ts, due_date),
                )
                return int(cur.lastrowid or 0)

        return await asyncio.to_thread(_work)

    async def get_tasks(
        self,
        *,
        status: str | None = None,
        type: str | None = None,
        limit: int = 100,
        due_from: str | None = None,
        due_to: str | None = None,
    ) -> list[dict[str, Any]]:
        """Return tasks ordered newest-first, with optional filters.

        ``due_from`` / ``due_to`` restrict the result to tasks whose
        ``due_date`` (YYYY-MM-DD) falls inside the inclusive range. Tasks
        without a due_date are excluded when either bound is supplied.
        """
        def _work() -> list[dict[str, Any]]:
            clauses: list[str] = []
            params: list[Any] = []
            if status is not None:
                clauses.append("status = ?")
                params.append(status)
            if type is not None:
                clauses.append("type = ?")
                params.append(type)
            if due_from is not None:
                clauses.append("due_date IS NOT NULL AND due_date >= ?")
                params.append(due_from)
            if due_to is not None:
                clauses.append("due_date IS NOT NULL AND due_date <= ?")
                params.append(due_to)
            where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
            params.append(limit)

            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT id, type, status, title, description, source,"
                    " payload, created_at, updated_at, due_date"
                    f" FROM seraphine_tasks{where}"
                    " ORDER BY created_at DESC, id DESC LIMIT ?",
                    params,
                ).fetchall()

            return [_row_to_task(r) for r in rows]

        return await asyncio.to_thread(_work)

    async def get_task(self, task_id: int) -> dict[str, Any] | None:
        def _work() -> dict[str, Any] | None:
            with self._connect() as conn:
                row = conn.execute(
                    "SELECT id, type, status, title, description, source,"
                    " payload, created_at, updated_at, due_date"
                    " FROM seraphine_tasks WHERE id = ?",
                    (task_id,),
                ).fetchone()
            if row is None:
                return None
            return _row_to_task(row)

        return await asyncio.to_thread(_work)

    async def update_task_status(self, task_id: int, status: str) -> int:
        """Update a task's status; returns number of rows affected (0 or 1)."""
        ts = _now()

        def _work() -> int:
            with self._connect() as conn:
                cur = conn.execute(
                    "UPDATE seraphine_tasks SET status = ?, updated_at = ?"
                    " WHERE id = ?",
                    (status, ts, task_id),
                )
                return cur.rowcount or 0

        return await asyncio.to_thread(_work)

    async def delete_task(self, task_id: int) -> int:
        """Delete a task by id; returns number of rows affected (0 or 1)."""
        def _work() -> int:
            with self._connect() as conn:
                cur = conn.execute(
                    "DELETE FROM seraphine_tasks WHERE id = ?",
                    (task_id,),
                )
                return cur.rowcount or 0

        return await asyncio.to_thread(_work)

    async def get_fact(self, fact_id: str) -> Fact | None:
        def _work() -> Fact | None:
            with self._connect() as conn:
                row = conn.execute(
                    "SELECT id, text, source, confidence, created_at, superseded_by"
                    " FROM facts WHERE id = ?",
                    (fact_id,),
                ).fetchone()
            if row is None:
                return None
            return Fact(
                id=row[0],
                text=row[1],
                source=row[2],
                confidence=row[3],
                created_at=row[4],
                superseded_by=row[5],
            )

        return await asyncio.to_thread(_work)
