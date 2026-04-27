"""Schema migrator for the projects table."""

from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS projects (
          id           TEXT PRIMARY KEY,
          user_id      TEXT NOT NULL,
          name         TEXT NOT NULL,
          description  TEXT,
          color        TEXT NOT NULL DEFAULT 'blue',
          status       TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','at_risk','completed','archived')),
          target_date  TEXT,
          progress     INTEGER NOT NULL DEFAULT 0,
          created_at   TEXT NOT NULL,
          updated_at   TEXT NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_projects_user_status
          ON projects(user_id, status);
        CREATE INDEX IF NOT EXISTS idx_projects_user_updated
          ON projects(user_id, updated_at DESC);
        """
    )
