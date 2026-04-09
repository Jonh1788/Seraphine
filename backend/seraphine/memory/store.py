from __future__ import annotations

import asyncio
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path

from pydantic import BaseModel


class Turn(BaseModel):
    id: str
    conversation_id: str
    role: str
    content: str
    created_at: str
    token_count: int | None = None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class MemoryStore:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path)
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

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
                    """
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

    async def get_turns(self, conversation_id: str) -> list[Turn]:
        def _work() -> list[Turn]:
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT id, conversation_id, role, content, created_at, token_count"
                    " FROM turns WHERE conversation_id = ? ORDER BY created_at ASC",
                    (conversation_id,),
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
