"""Schema migrator for mod-tasks.

Registers ``seraphine_tasks`` table + indexes on the shared core-db
Store. Idempotent — safe to call repeatedly.

Multi-tenancy column ``user_id`` is added in two ways for safety:
- New DBs: created directly in the CREATE TABLE.
- Existing DBs (Seraphine): ALTER TABLE adds the column with NULL
  default, preserving every existing row as single-tenant.
"""

from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    # Step 1: create the table if it doesn't exist. New DBs get the full
    # schema in one shot. Existing DBs (legacy) keep whatever shape they
    # had — Step 2 brings them up to date.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS seraphine_tasks (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          type          TEXT NOT NULL,
          status        TEXT NOT NULL DEFAULT 'pending',
          title         TEXT NOT NULL,
          description   TEXT NOT NULL,
          source        TEXT NOT NULL,
          payload       TEXT NOT NULL,
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL,
          due_date      TEXT,
          due_time      TEXT,
          user_id       TEXT
        )
        """
    )
    # Step 2: idempotent ADD COLUMN for legacy DBs that pre-date
    # user_id / due_date. SQLite has no IF NOT EXISTS for ALTER, so we
    # swallow the duplicate-column error. MUST run before CREATE INDEX
    # on those columns or the index DDL fails on the legacy table.
    for ddl in (
        "ALTER TABLE seraphine_tasks ADD COLUMN due_date TEXT",
        "ALTER TABLE seraphine_tasks ADD COLUMN due_time TEXT",
        "ALTER TABLE seraphine_tasks ADD COLUMN user_id TEXT",
    ):
        try:
            conn.execute(ddl)
        except sqlite3.OperationalError as exc:
            if "duplicate column name" not in str(exc).lower():
                raise
    # Step 3: indexes — safe now that all columns exist.
    conn.executescript(
        """
        CREATE INDEX IF NOT EXISTS idx_seraphine_tasks_status
          ON seraphine_tasks(status);
        CREATE INDEX IF NOT EXISTS idx_seraphine_tasks_type
          ON seraphine_tasks(type);
        CREATE INDEX IF NOT EXISTS idx_seraphine_tasks_due_date
          ON seraphine_tasks(due_date);
        CREATE INDEX IF NOT EXISTS idx_seraphine_tasks_user
          ON seraphine_tasks(user_id);
        """
    )
