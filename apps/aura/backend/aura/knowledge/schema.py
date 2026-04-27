"""Schema migrators for notebooks + notes tables."""

from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS notebooks (
          id         TEXT PRIMARY KEY,
          user_id    TEXT NOT NULL,
          name       TEXT NOT NULL,
          color      TEXT NOT NULL DEFAULT 'chat',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_notebooks_user
          ON notebooks(user_id, updated_at DESC);

        CREATE TABLE IF NOT EXISTS notes (
          id          TEXT PRIMARY KEY,
          notebook_id TEXT NOT NULL,
          user_id     TEXT NOT NULL,
          title       TEXT,
          content_md  TEXT NOT NULL DEFAULT '',
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL,
          FOREIGN KEY (notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_notes_notebook
          ON notes(notebook_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_notes_user_updated
          ON notes(user_id, updated_at DESC);
        """
    )
