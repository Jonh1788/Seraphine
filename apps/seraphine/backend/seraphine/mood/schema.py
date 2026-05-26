"""Schema migrator for mood tracking (single-tenant, no user_id)."""

from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS mood_logs (
          id         TEXT PRIMARY KEY,
          timestamp  TEXT NOT NULL,
          label      TEXT NOT NULL,
          valence    REAL NOT NULL,
          arousal    REAL NOT NULL,
          source     TEXT NOT NULL DEFAULT 'conversation',
          turn_id    TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_mood_logs_timestamp
          ON mood_logs(timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_mood_logs_source
          ON mood_logs(source);
        """
    )
