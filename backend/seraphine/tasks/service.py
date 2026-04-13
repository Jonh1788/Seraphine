from __future__ import annotations

import asyncio
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from .models import SeraphineTask


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class TaskService:
    def __init__(self, db_path: str | Path) -> None:
        self.path = Path(db_path)
        self._conn: sqlite3.Connection | None = None

    def _connect(self) -> sqlite3.Connection:
        if self._conn is not None:
            return self._conn
        conn = sqlite3.connect(self.path, check_same_thread=False)
        conn.execute("PRAGMA foreign_keys = ON")
        self._conn = conn
        return conn

    async def aclose(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    # ------------------------------------------------------------------
    # Schema
    # ------------------------------------------------------------------

    async def ensure_tables(self) -> None:
        def _work() -> None:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self._connect() as conn:
                conn.executescript(
                    """
                    CREATE TABLE IF NOT EXISTS seraphine_tasks (
                      id          INTEGER PRIMARY KEY AUTOINCREMENT,
                      type        TEXT NOT NULL,
                      status      TEXT NOT NULL DEFAULT 'pending',
                      title       TEXT NOT NULL,
                      description TEXT NOT NULL DEFAULT '',
                      source      TEXT NOT NULL DEFAULT 'system',
                      payload     TEXT NOT NULL DEFAULT '{}',
                      created_at  TEXT NOT NULL,
                      updated_at  TEXT NOT NULL
                    );

                    CREATE INDEX IF NOT EXISTS idx_tasks_status
                      ON seraphine_tasks(status);
                    CREATE INDEX IF NOT EXISTS idx_tasks_type
                      ON seraphine_tasks(type);
                    """
                )

        await asyncio.to_thread(_work)

    # ------------------------------------------------------------------
    # CRUD
    # ------------------------------------------------------------------

    async def create_task(self, task: SeraphineTask) -> int:
        ts = _now()

        def _work() -> int:
            with self._connect() as conn:
                cur = conn.execute(
                    "INSERT INTO seraphine_tasks"
                    "(type, status, title, description, source, payload,"
                    " created_at, updated_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        task.type,
                        task.status,
                        task.title,
                        task.description,
                        task.source,
                        task.payload,
                        ts,
                        ts,
                    ),
                )
                return cur.lastrowid  # type: ignore[return-value]

        return await asyncio.to_thread(_work)

    async def list_tasks(
        self,
        *,
        status: str | None = None,
        type: str | None = None,
        limit: int = 50,
    ) -> list[SeraphineTask]:
        def _work() -> list[SeraphineTask]:
            clauses: list[str] = []
            params: list[object] = []

            if status is not None:
                clauses.append("status = ?")
                params.append(status)
            if type is not None:
                clauses.append("type = ?")
                params.append(type)

            where = ""
            if clauses:
                where = " WHERE " + " AND ".join(clauses)

            params.append(limit)

            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT id, type, status, title, description,"
                    " source, payload, created_at, updated_at"
                    f" FROM seraphine_tasks{where}"
                    " ORDER BY created_at DESC LIMIT ?",
                    params,
                ).fetchall()

            return [
                SeraphineTask(
                    id=r[0],
                    type=r[1],
                    status=r[2],
                    title=r[3],
                    description=r[4],
                    source=r[5],
                    payload=r[6],
                    created_at=r[7],
                    updated_at=r[8],
                )
                for r in rows
            ]

        return await asyncio.to_thread(_work)

    async def get_task(self, task_id: int) -> SeraphineTask | None:
        def _work() -> SeraphineTask | None:
            with self._connect() as conn:
                row = conn.execute(
                    "SELECT id, type, status, title, description,"
                    " source, payload, created_at, updated_at"
                    " FROM seraphine_tasks WHERE id = ?",
                    (task_id,),
                ).fetchone()
            if row is None:
                return None
            return SeraphineTask(
                id=row[0],
                type=row[1],
                status=row[2],
                title=row[3],
                description=row[4],
                source=row[5],
                payload=row[6],
                created_at=row[7],
                updated_at=row[8],
            )

        return await asyncio.to_thread(_work)

    async def update_status(self, task_id: int, status: str) -> None:
        ts = _now()

        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "UPDATE seraphine_tasks SET status = ?, updated_at = ? WHERE id = ?",
                    (status, ts, task_id),
                )

        await asyncio.to_thread(_work)

    async def delete_task(self, task_id: int) -> None:
        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "DELETE FROM seraphine_tasks WHERE id = ?",
                    (task_id,),
                )

        await asyncio.to_thread(_work)
