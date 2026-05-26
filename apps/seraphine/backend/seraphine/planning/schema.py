"""Schema migrator for daily_plans (SDD 093)."""

from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS daily_plans (
          id            TEXT PRIMARY KEY,
          date          TEXT NOT NULL UNIQUE,
          plan_json     TEXT NOT NULL,
          accepted      INTEGER NOT NULL DEFAULT 0,
          feedback_json TEXT,
          created_at    TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_daily_plans_date ON daily_plans(date);
        """
    )
