"""Chat transcripts persisted in SQLite (``agent_chat_transcripts``) so a
``chat`` run can be resumed after a backend restart."""

from __future__ import annotations

import asyncio
import json
from collections import OrderedDict
from datetime import datetime, timezone
from typing import Any

MAX_TRANSCRIPTS = 500


class MemoryTranscripts:
    """In-memory fallback (tests / no database)."""

    def __init__(self) -> None:
        self._data: OrderedDict[str, list[dict[str, str]]] = OrderedDict()

    async def load(self, session_ref: str) -> list[dict[str, str]] | None:
        return self._data.get(session_ref)

    async def save(self, session_ref: str, provider: str, messages: list[dict[str, str]]) -> None:
        self._data[session_ref] = list(messages)
        self._data.move_to_end(session_ref)
        while len(self._data) > MAX_TRANSCRIPTS:
            self._data.popitem(last=False)


class SqliteTranscripts:
    def __init__(self, store: Any) -> None:
        self.store = store

    async def _db(self, fn: Any) -> Any:
        def _work() -> Any:
            with self.store._connect() as conn:
                return fn(conn)

        return await asyncio.to_thread(_work)

    async def load(self, session_ref: str) -> list[dict[str, str]] | None:
        row = await self._db(lambda c: c.execute(
            "SELECT messages FROM agent_chat_transcripts WHERE session_ref = ?",
            (session_ref,)).fetchone())
        if row is None:
            return None
        try:
            data = json.loads(row[0])
        except ValueError:
            return None
        return data if isinstance(data, list) else None

    async def save(self, session_ref: str, provider: str, messages: list[dict[str, str]]) -> None:
        body = json.dumps(messages, ensure_ascii=False)
        now = datetime.now(timezone.utc).isoformat(timespec="microseconds")

        def _w(conn: Any) -> None:
            conn.execute(
                "INSERT INTO agent_chat_transcripts (session_ref, provider, messages, updated_at)"
                " VALUES (?, ?, ?, ?) ON CONFLICT(session_ref) DO UPDATE SET"
                " provider = excluded.provider, messages = excluded.messages,"
                " updated_at = excluded.updated_at",
                (session_ref, provider, body, now))
            conn.execute(
                "DELETE FROM agent_chat_transcripts WHERE session_ref IN ("
                " SELECT session_ref FROM agent_chat_transcripts"
                " ORDER BY updated_at DESC LIMIT -1 OFFSET ?)", (MAX_TRANSCRIPTS,))

        await self._db(_w)
