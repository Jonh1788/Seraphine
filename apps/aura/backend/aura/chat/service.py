"""ConversationService — CRUD for conversations + messages.

Every method takes user_id and scopes by it, so even with a known
conversation_id a user can never read or mutate someone else's
conversation. Mirrors the pattern in mod_tasks / mod_finance.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from core_db import Store


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class ConversationRow:
    id: str
    title: str | None
    created_at: str
    updated_at: str
    message_count: int = 0
    last_snippet: str | None = None


@dataclass
class MessageRow:
    id: str
    role: str
    content: str
    created_at: str
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class ConversationDetail:
    id: str
    title: str | None
    created_at: str
    updated_at: str
    messages: list[MessageRow]


class ConversationService:
    def __init__(self, store: Store) -> None:
        self._store = store

    # ------------------------------------------------------------------
    # CRUD
    # ------------------------------------------------------------------

    async def create_conversation(
        self, user_id: str, title: str | None = None,
    ) -> str:
        cid = str(uuid.uuid4())
        ts = _now()

        def _work() -> str:
            with self._store._connect() as conn:
                conn.execute(
                    "INSERT INTO conversations (id, user_id, title, created_at, updated_at)"
                    " VALUES (?, ?, ?, ?, ?)",
                    (cid, user_id, title, ts, ts),
                )
            return cid

        return await asyncio.to_thread(_work)

    async def list_conversations(
        self, user_id: str, *, limit: int = 50,
    ) -> list[ConversationRow]:
        def _work() -> list[ConversationRow]:
            with self._store._connect() as conn:
                # Left-join with messages to get count + latest snippet
                # in a single round-trip.
                rows = conn.execute(
                    """
                    SELECT
                      c.id,
                      c.title,
                      c.created_at,
                      c.updated_at,
                      (SELECT COUNT(*) FROM chat_messages m WHERE m.conversation_id = c.id) AS msg_count,
                      (SELECT m.content FROM chat_messages m
                         WHERE m.conversation_id = c.id
                         ORDER BY m.created_at DESC LIMIT 1) AS last_snippet
                    FROM conversations c
                    WHERE c.user_id = ?
                    ORDER BY c.updated_at DESC
                    LIMIT ?
                    """,
                    (user_id, limit),
                ).fetchall()
            out: list[ConversationRow] = []
            for r in rows:
                snippet = r[5]
                if snippet and len(snippet) > 100:
                    snippet = snippet[:100] + "…"
                out.append(
                    ConversationRow(
                        id=r[0], title=r[1], created_at=r[2], updated_at=r[3],
                        message_count=int(r[4] or 0), last_snippet=snippet,
                    )
                )
            return out

        return await asyncio.to_thread(_work)

    async def get_conversation(
        self, conversation_id: str, user_id: str,
    ) -> ConversationDetail | None:
        def _work() -> ConversationDetail | None:
            with self._store._connect() as conn:
                row = conn.execute(
                    "SELECT id, title, created_at, updated_at FROM conversations"
                    " WHERE id = ? AND user_id = ?",
                    (conversation_id, user_id),
                ).fetchone()
                if row is None:
                    return None
                msg_rows = conn.execute(
                    "SELECT id, role, content, created_at, metadata FROM chat_messages"
                    " WHERE conversation_id = ?"
                    " ORDER BY created_at ASC, id ASC",
                    (conversation_id,),
                ).fetchall()
            messages: list[MessageRow] = []
            for m in msg_rows:
                meta: dict[str, Any] = {}
                raw_meta = m[4]
                if raw_meta:
                    try:
                        parsed = json.loads(raw_meta)
                        if isinstance(parsed, dict):
                            meta = parsed
                    except json.JSONDecodeError:
                        meta = {}
                messages.append(
                    MessageRow(
                        id=m[0], role=m[1], content=m[2],
                        created_at=m[3], metadata=meta,
                    )
                )
            return ConversationDetail(
                id=row[0], title=row[1], created_at=row[2], updated_at=row[3],
                messages=messages,
            )

        return await asyncio.to_thread(_work)

    async def delete_conversation(
        self, conversation_id: str, user_id: str,
    ) -> int:
        def _work() -> int:
            with self._store._connect() as conn:
                cur = conn.execute(
                    "DELETE FROM conversations WHERE id = ? AND user_id = ?",
                    (conversation_id, user_id),
                )
                # chat_messages are removed via FK cascade.
                return cur.rowcount or 0

        return await asyncio.to_thread(_work)

    async def update_title(
        self, conversation_id: str, user_id: str, title: str,
    ) -> int:
        ts = _now()

        def _work() -> int:
            with self._store._connect() as conn:
                cur = conn.execute(
                    "UPDATE conversations SET title = ?, updated_at = ?"
                    " WHERE id = ? AND user_id = ?",
                    (title.strip()[:200], ts, conversation_id, user_id),
                )
                return cur.rowcount or 0

        return await asyncio.to_thread(_work)

    # ------------------------------------------------------------------
    # Messages
    # ------------------------------------------------------------------

    async def add_message(
        self,
        conversation_id: str,
        user_id: str,
        role: str,
        content: str,
        *,
        metadata: dict[str, Any] | None = None,
    ) -> str | None:
        """Insert a message + bump conversation.updated_at. Returns new
        message id, or None if the conversation isn't owned by this user."""
        if role not in ("user", "assistant"):
            raise ValueError(f"invalid role: {role}")
        msg_id = str(uuid.uuid4())
        ts = _now()
        meta_json = (
            json.dumps(metadata, ensure_ascii=False) if metadata else None
        )

        def _work() -> str | None:
            with self._store._connect() as conn:
                cur = conn.execute(
                    "UPDATE conversations SET updated_at = ?"
                    " WHERE id = ? AND user_id = ?",
                    (ts, conversation_id, user_id),
                )
                if (cur.rowcount or 0) == 0:
                    return None
                conn.execute(
                    "INSERT INTO chat_messages"
                    " (id, conversation_id, role, content, metadata, created_at)"
                    " VALUES (?, ?, ?, ?, ?, ?)",
                    (msg_id, conversation_id, role, content, meta_json, ts),
                )
            return msg_id

        return await asyncio.to_thread(_work)

    async def get_messages_for_llm(
        self, conversation_id: str, user_id: str, *, limit: int = 50,
    ) -> list[dict[str, Any]] | None:
        """Return the last ``limit`` messages in chronological order as
        ``{role, content}`` dicts ready to feed an LLM. None if the
        conversation isn't owned by this user."""
        def _work() -> list[dict[str, Any]] | None:
            with self._store._connect() as conn:
                owns = conn.execute(
                    "SELECT 1 FROM conversations WHERE id = ? AND user_id = ?",
                    (conversation_id, user_id),
                ).fetchone()
                if owns is None:
                    return None
                rows = conn.execute(
                    "SELECT role, content FROM chat_messages"
                    " WHERE conversation_id = ?"
                    " ORDER BY created_at ASC, id ASC"
                    " LIMIT ?",
                    (conversation_id, limit),
                ).fetchall()
            return [{"role": r[0], "content": r[1]} for r in rows]

        return await asyncio.to_thread(_work)
