"""Schema migrator for the goals table."""

from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS goals (
          id            TEXT PRIMARY KEY,
          user_id       TEXT NOT NULL,
          title         TEXT NOT NULL,
          description   TEXT,
          kind          TEXT NOT NULL DEFAULT 'general'
                            CHECK (kind IN ('general','financial','habit','project')),
          target_value  REAL,
          current_value REAL NOT NULL DEFAULT 0,
          unit          TEXT,
          deadline      TEXT,
          status        TEXT NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active','completed','expired','archived')),
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_goals_user_status
          ON goals(user_id, status);
        """
    )
