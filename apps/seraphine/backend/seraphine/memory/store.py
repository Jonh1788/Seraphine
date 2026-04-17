from __future__ import annotations

import asyncio
import json
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel

from core_db import Store


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


def _seraphine_core_migrator(conn: sqlite3.Connection) -> None:
    """Schema for Seraphine's domain tables.

    Until each module is extracted into its own package (Phases 5-9),
    every Seraphine-owned table lives here as a single migrator. Each
    extraction will move its CREATE TABLE block out and into
    ``packages/mod-<name>/schema.py`` registered via ``Store.register_migrator``.
    """
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
        CREATE TABLE IF NOT EXISTS push_subscriptions (
          endpoint   TEXT PRIMARY KEY,
          p256dh     TEXT NOT NULL,
          auth       TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS user_profile (
          id          INTEGER PRIMARY KEY CHECK (id = 1),
          data_json   TEXT NOT NULL,
          fact_count  INTEGER NOT NULL,
          updated_at  TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS open_loops (
          id             TEXT PRIMARY KEY,
          text           TEXT NOT NULL,
          owner          TEXT NOT NULL CHECK (owner IN ('user', 'assistant')),
          created_at     TEXT NOT NULL,
          resolved_at    TEXT,
          resolution     TEXT,
          injection_count INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS conversation_narratives (
          id              TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          text            TEXT NOT NULL,
          turn_count      INTEGER NOT NULL,
          started_at      TEXT NOT NULL,
          ended_at        TEXT NOT NULL,
          created_at      TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_narratives_created
          ON conversation_narratives(created_at DESC);
        CREATE TABLE IF NOT EXISTS decisions (
          id              TEXT PRIMARY KEY,
          subject         TEXT NOT NULL,
          choice          TEXT NOT NULL,
          alternatives    TEXT,
          created_at      TEXT NOT NULL,
          followed_up_at  TEXT,
          outcome         TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_decisions_followup
          ON decisions(followed_up_at, created_at DESC);
        CREATE TABLE IF NOT EXISTS people (
          id                TEXT PRIMARY KEY,
          name              TEXT UNIQUE NOT NULL,
          relation          TEXT,
          first_seen_at     TEXT NOT NULL,
          last_mentioned_at TEXT NOT NULL,
          mention_count     INTEGER NOT NULL DEFAULT 1,
          tags              TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_people_last
          ON people(last_mentioned_at DESC);
        CREATE TABLE IF NOT EXISTS person_mentions (
          id           TEXT PRIMARY KEY,
          person_id    TEXT NOT NULL REFERENCES people(id),
          turn_id      TEXT,
          context      TEXT NOT NULL,
          sentiment    TEXT,
          created_at   TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_mentions_person
          ON person_mentions(person_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_open_loops_status
          ON open_loops(resolved_at, created_at DESC);
        """
    )
    # `seraphine_tasks` schema (and its due_date / user_id ALTERs) has
    # moved to packages/mod-tasks/schema.py — registered separately by
    # the app at startup. push_subscriptions remains here until Phase 7
    # gives push its own module.


class MemoryStore(Store):
    def __init__(self, path: Path) -> None:
        super().__init__(path)
        # Register Seraphine's monolithic schema migrator. Future module
        # extractions will register their own and remove their CREATE
        # TABLE block from `_seraphine_core_migrator`.
        self.register_migrator("seraphine_core", _seraphine_core_migrator)

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

    # seraphine internal tasks moved to packages/mod-tasks (Phase 5).
    # The shared core-db Store is reused via the same connection — no
    # CRUD API is exposed from MemoryStore for tasks anymore.

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

    # ------------------------------------------------------------------
    # Push subscriptions
    # ------------------------------------------------------------------

    async def add_push_subscription(
        self, endpoint: str, p256dh: str, auth: str
    ) -> None:
        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "INSERT OR REPLACE INTO push_subscriptions"
                    " (endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?)",
                    (endpoint, p256dh, auth, _now()),
                )

        await asyncio.to_thread(_work)

    async def remove_push_subscription(self, endpoint: str) -> int:
        def _work() -> int:
            with self._connect() as conn:
                cur = conn.execute(
                    "DELETE FROM push_subscriptions WHERE endpoint = ?",
                    (endpoint,),
                )
                return cur.rowcount or 0

        return await asyncio.to_thread(_work)

    async def get_user_profile(self) -> dict[str, Any] | None:
        def _work() -> dict[str, Any] | None:
            with self._connect() as conn:
                row = conn.execute(
                    "SELECT data_json, fact_count, updated_at FROM user_profile WHERE id = 1"
                ).fetchone()
            if not row:
                return None
            try:
                data = json.loads(row[0])
            except (json.JSONDecodeError, TypeError):
                return None
            return {"data": data, "fact_count": row[1], "updated_at": row[2]}

        return await asyncio.to_thread(_work)

    async def set_user_profile(self, data: dict[str, Any], fact_count: int) -> None:
        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO user_profile (id, data_json, fact_count, updated_at)"
                    " VALUES (1, ?, ?, ?)"
                    " ON CONFLICT(id) DO UPDATE SET"
                    "   data_json = excluded.data_json,"
                    "   fact_count = excluded.fact_count,"
                    "   updated_at = excluded.updated_at",
                    (json.dumps(data, ensure_ascii=False), fact_count, _now()),
                )

        await asyncio.to_thread(_work)

    async def add_open_loop(self, text: str, owner: str = "user") -> str:
        loop_id = str(uuid.uuid4())

        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO open_loops"
                    " (id, text, owner, created_at, injection_count)"
                    " VALUES (?, ?, ?, ?, 0)",
                    (loop_id, text, owner, _now()),
                )

        await asyncio.to_thread(_work)
        return loop_id

    async def list_open_loops(self, *, only_open: bool = True, limit: int = 10) -> list[dict[str, Any]]:
        def _work() -> list[dict[str, Any]]:
            with self._connect() as conn:
                sql = (
                    "SELECT id, text, owner, created_at, resolved_at,"
                    " resolution, injection_count FROM open_loops"
                )
                if only_open:
                    sql += " WHERE resolved_at IS NULL"
                sql += " ORDER BY created_at DESC LIMIT ?"
                rows = conn.execute(sql, (limit,)).fetchall()
            return [
                {
                    "id": r[0], "text": r[1], "owner": r[2],
                    "created_at": r[3], "resolved_at": r[4],
                    "resolution": r[5], "injection_count": r[6],
                }
                for r in rows
            ]

        return await asyncio.to_thread(_work)

    async def resolve_open_loop(self, loop_id: str, resolution: str) -> None:
        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "UPDATE open_loops SET resolved_at = ?, resolution = ?"
                    " WHERE id = ?",
                    (_now(), resolution, loop_id),
                )

        await asyncio.to_thread(_work)

    async def bump_open_loop_injection(self, loop_id: str) -> int:
        """Increment the injection counter and return the new value."""
        def _work() -> int:
            with self._connect() as conn:
                conn.execute(
                    "UPDATE open_loops SET injection_count = injection_count + 1"
                    " WHERE id = ?",
                    (loop_id,),
                )
                row = conn.execute(
                    "SELECT injection_count FROM open_loops WHERE id = ?",
                    (loop_id,),
                ).fetchone()
                return int(row[0]) if row else 0

        return await asyncio.to_thread(_work)

    async def add_narrative(
        self, conversation_id: str, text: str, turn_count: int,
        started_at: str, ended_at: str,
    ) -> str:
        nid = str(uuid.uuid4())

        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO conversation_narratives"
                    " (id, conversation_id, text, turn_count, started_at, ended_at, created_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (nid, conversation_id, text, turn_count, started_at, ended_at, _now()),
                )

        await asyncio.to_thread(_work)
        return nid

    async def list_narratives(self, limit: int = 10) -> list[dict[str, Any]]:
        def _work() -> list[dict[str, Any]]:
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT id, conversation_id, text, turn_count, started_at,"
                    " ended_at, created_at"
                    " FROM conversation_narratives"
                    " ORDER BY created_at DESC LIMIT ?",
                    (limit,),
                ).fetchall()
            return [
                {
                    "id": r[0], "conversation_id": r[1], "text": r[2],
                    "turn_count": r[3], "started_at": r[4], "ended_at": r[5],
                    "created_at": r[6],
                }
                for r in rows
            ]

        return await asyncio.to_thread(_work)

    async def narrative_exists_for_conv(self, conversation_id: str) -> bool:
        def _work() -> bool:
            with self._connect() as conn:
                row = conn.execute(
                    "SELECT 1 FROM conversation_narratives"
                    " WHERE conversation_id = ? LIMIT 1",
                    (conversation_id,),
                ).fetchone()
            return row is not None

        return await asyncio.to_thread(_work)

    async def add_decision(
        self, subject: str, choice: str, alternatives: str | None = None,
    ) -> str:
        did = str(uuid.uuid4())

        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO decisions"
                    " (id, subject, choice, alternatives, created_at)"
                    " VALUES (?, ?, ?, ?, ?)",
                    (did, subject, choice, alternatives, _now()),
                )

        await asyncio.to_thread(_work)
        return did

    async def list_unfollowed_decisions(self, min_age_days: int = 3) -> list[dict[str, Any]]:
        def _work() -> list[dict[str, Any]]:
            cutoff = (datetime.now(timezone.utc) - timedelta(days=min_age_days)).isoformat()
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT id, subject, choice, alternatives, created_at"
                    " FROM decisions"
                    " WHERE followed_up_at IS NULL"
                    " AND created_at < ?"
                    " ORDER BY created_at DESC LIMIT 10",
                    (cutoff,),
                ).fetchall()
            return [
                {
                    "id": r[0], "subject": r[1], "choice": r[2],
                    "alternatives": r[3], "created_at": r[4],
                }
                for r in rows
            ]

        return await asyncio.to_thread(_work)

    async def mark_decision_followed(
        self, decision_id: str, outcome: str,
    ) -> None:
        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "UPDATE decisions SET followed_up_at = ?, outcome = ?"
                    " WHERE id = ?",
                    (_now(), outcome, decision_id),
                )

        await asyncio.to_thread(_work)

    async def upsert_person(
        self, name: str, *, relation: str | None = None,
    ) -> str:
        """Return the person's id (creates if absent, updates otherwise)."""
        pid = str(uuid.uuid4())
        now = _now()

        def _work() -> str:
            nonlocal pid
            with self._connect() as conn:
                row = conn.execute(
                    "SELECT id, relation FROM people WHERE lower(name) = lower(?)",
                    (name,),
                ).fetchone()
                if row:
                    pid = row[0]
                    if relation and not row[1]:
                        conn.execute(
                            "UPDATE people SET relation = ?, "
                            "last_mentioned_at = ?, "
                            "mention_count = mention_count + 1 WHERE id = ?",
                            (relation, now, pid),
                        )
                    else:
                        conn.execute(
                            "UPDATE people SET last_mentioned_at = ?, "
                            "mention_count = mention_count + 1 WHERE id = ?",
                            (now, pid),
                        )
                else:
                    conn.execute(
                        "INSERT INTO people (id, name, relation, "
                        "first_seen_at, last_mentioned_at, mention_count) "
                        "VALUES (?, ?, ?, ?, ?, 1)",
                        (pid, name, relation, now, now),
                    )
            return pid

        return await asyncio.to_thread(_work)

    async def add_person_mention(
        self, person_id: str, context: str, *, sentiment: str | None = None,
        turn_id: str | None = None,
    ) -> None:
        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO person_mentions "
                    "(id, person_id, turn_id, context, sentiment, created_at) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (str(uuid.uuid4()), person_id, turn_id, context,
                     sentiment, _now()),
                )

        await asyncio.to_thread(_work)

    async def list_people(self, limit: int = 30) -> list[dict[str, Any]]:
        def _work() -> list[dict[str, Any]]:
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT id, name, relation, first_seen_at, "
                    "last_mentioned_at, mention_count, tags "
                    "FROM people ORDER BY last_mentioned_at DESC LIMIT ?",
                    (limit,),
                ).fetchall()
            return [
                {"id": r[0], "name": r[1], "relation": r[2],
                 "first_seen_at": r[3], "last_mentioned_at": r[4],
                 "mention_count": r[5],
                 "tags": json.loads(r[6]) if r[6] else []}
                for r in rows
            ]

        return await asyncio.to_thread(_work)

    async def get_person_by_name(self, name: str) -> dict[str, Any] | None:
        def _work() -> dict[str, Any] | None:
            with self._connect() as conn:
                row = conn.execute(
                    "SELECT id, name, relation, last_mentioned_at, mention_count"
                    " FROM people WHERE lower(name) = lower(?)",
                    (name,),
                ).fetchone()
            if not row:
                return None
            return {"id": row[0], "name": row[1], "relation": row[2],
                    "last_mentioned_at": row[3], "mention_count": row[4]}

        return await asyncio.to_thread(_work)

    async def list_person_mentions(
        self, person_id: str, limit: int = 5,
    ) -> list[dict[str, Any]]:
        def _work() -> list[dict[str, Any]]:
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT context, sentiment, created_at FROM person_mentions"
                    " WHERE person_id = ? ORDER BY created_at DESC LIMIT ?",
                    (person_id, limit),
                ).fetchall()
            return [
                {"context": r[0], "sentiment": r[1], "created_at": r[2]}
                for r in rows
            ]

        return await asyncio.to_thread(_work)

    async def list_push_subscriptions(self) -> list[dict[str, str]]:
        def _work() -> list[dict[str, str]]:
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT endpoint, p256dh, auth FROM push_subscriptions"
                ).fetchall()
            return [
                {"endpoint": r[0], "p256dh": r[1], "auth": r[2]} for r in rows
            ]

        return await asyncio.to_thread(_work)
