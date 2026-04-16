"""Schema migrator for habits (single-tenant, no user_id)."""

from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS habits (
          id           TEXT PRIMARY KEY,
          title        TEXT NOT NULL,
          icon         TEXT DEFAULT 'check',
          color        TEXT DEFAULT '#22d3ee',
          frequency    TEXT NOT NULL
                         CHECK (frequency IN ('daily','weekdays','custom')),
          target_days  TEXT,  -- JSON array of ints [0..6]
          description  TEXT,
          active       INTEGER NOT NULL DEFAULT 1,
          created_at   TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS habit_logs (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          habit_id   TEXT NOT NULL
                       REFERENCES habits(id) ON DELETE CASCADE,
          date       TEXT NOT NULL,
          completed  INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          UNIQUE(habit_id, date)
        );
        CREATE INDEX IF NOT EXISTS idx_habits_active ON habits(active);
        CREATE INDEX IF NOT EXISTS idx_habit_logs_habit_date
          ON habit_logs(habit_id, date DESC);
        """
    )
