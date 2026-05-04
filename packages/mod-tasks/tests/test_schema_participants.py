"""Migration adds completed_by column + task_participants table; backfill
populates owner row for every task with user_id != NULL."""

from __future__ import annotations

from pathlib import Path

import pytest

from core_db import Store
from mod_tasks import schema as tasks_schema


@pytest.fixture
async def store(tmp_path: Path) -> Store:
    s = Store(tmp_path / "share.sqlite")
    s.register_migrator("mod_tasks", tasks_schema.migrate)
    await s.ensure_schema()
    return s


async def test_completed_by_column_exists(store: Store) -> None:
    with store._connect() as conn:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(seraphine_tasks)")}
    assert "completed_by" in cols


async def test_task_participants_table_exists(store: Store) -> None:
    with store._connect() as conn:
        rows = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='task_participants'"
        ).fetchall()
    assert rows, "task_participants table missing"


async def test_backfill_inserts_owner_for_existing_aura_tasks(tmp_path: Path) -> None:
    # Seed a DB with the OLD schema (no task_participants table).
    db_path = tmp_path / "legacy.sqlite"
    import sqlite3
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            """CREATE TABLE seraphine_tasks (
              id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL,
              status TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
              source TEXT NOT NULL, payload TEXT NOT NULL,
              created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
              due_date TEXT, due_time TEXT, user_id TEXT, priority TEXT,
              tags TEXT, remind TEXT
            )"""
        )
        conn.execute(
            "INSERT INTO seraphine_tasks (type, status, title, description, source,"
            " payload, created_at, updated_at, user_id) VALUES"
            " ('generic','pending','t1','','chat','{}','t','t','user-x')"
        )
        conn.execute(
            "INSERT INTO seraphine_tasks (type, status, title, description, source,"
            " payload, created_at, updated_at, user_id) VALUES"
            " ('generic','pending','t2','','chat','{}','t','t',NULL)"
        )

    s = Store(db_path)
    s.register_migrator("mod_tasks", tasks_schema.migrate)
    await s.ensure_schema()

    with s._connect() as conn:
        rows = conn.execute(
            "SELECT task_id, user_id, role FROM task_participants ORDER BY task_id"
        ).fetchall()
    assert rows == [(1, "user-x", "owner")]
