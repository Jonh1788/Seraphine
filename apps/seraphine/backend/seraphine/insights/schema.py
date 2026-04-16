"""Schema migrator for insights (single-tenant, no user_id).

Two tables:
- ``insights``: stable-hash id so re-running analysis dedupes naturally.
- ``weekly_reports``: one row per ISO week (Mon..Sun in America/Sao_Paulo).
"""

from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS insights (
          id            TEXT PRIMARY KEY,
          type          TEXT NOT NULL
                          CHECK (type IN ('finance','tasks','habits','productivity')),
          severity      TEXT NOT NULL
                          CHECK (severity IN ('info','warning','positive')),
          title         TEXT NOT NULL,
          description   TEXT NOT NULL,
          data          TEXT NOT NULL DEFAULT '{}',  -- JSON blob
          created_at    TEXT NOT NULL,
          dismissed     INTEGER NOT NULL DEFAULT 0,
          dismissed_at  TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_insights_created
          ON insights(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_insights_active
          ON insights(dismissed, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_insights_type
          ON insights(type, dismissed);

        CREATE TABLE IF NOT EXISTS weekly_reports (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          week_start  TEXT NOT NULL UNIQUE,  -- Monday YYYY-MM-DD (SP tz)
          week_end    TEXT NOT NULL,         -- Sunday YYYY-MM-DD
          tasks       TEXT NOT NULL DEFAULT '{}',
          finance     TEXT NOT NULL DEFAULT '{}',
          habits      TEXT NOT NULL DEFAULT '{}',
          insights    TEXT NOT NULL DEFAULT '[]',
          suggestion  TEXT NOT NULL DEFAULT '',
          created_at  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_weekly_reports_start
          ON weekly_reports(week_start DESC);
        """
    )
