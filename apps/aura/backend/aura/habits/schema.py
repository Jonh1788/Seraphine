"""Schema migrators for habits + habit_logs tables."""

from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS habits (
          id              TEXT PRIMARY KEY,
          user_id         TEXT NOT NULL,
          name            TEXT NOT NULL,
          color           TEXT NOT NULL DEFAULT 'emerald',
          target_per_week INTEGER NOT NULL DEFAULT 7,
          archived        INTEGER NOT NULL DEFAULT 0,
          created_at      TEXT NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_habits_user_archived
          ON habits(user_id, archived);

        CREATE TABLE IF NOT EXISTS habit_logs (
          habit_id   TEXT NOT NULL,
          user_id    TEXT NOT NULL,
          date       TEXT NOT NULL,
          done       INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          PRIMARY KEY (habit_id, date),
          FOREIGN KEY (habit_id) REFERENCES habits(id) ON DELETE CASCADE,
          FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_habit_logs_user_date
          ON habit_logs(user_id, date);
        """
    )
