from __future__ import annotations

import asyncio
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from pydantic import BaseModel


class Turn(BaseModel):
    id: str
    conversation_id: str
    role: str
    content: str
    created_at: str
    token_count: int | None = None


class Fact(BaseModel):
    id: str
    text: str
    source: Literal["explicit", "reflection", "user_taught"]
    confidence: float
    created_at: str
    superseded_by: str | None = None


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
