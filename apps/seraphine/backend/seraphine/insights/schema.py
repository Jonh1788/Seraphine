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
                          CHECK (type IN (
                            'finance','tasks','habits','productivity',
                            'health','cross_domain','mood','focus'
                          )),
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

    # ------------------------------------------------------------------
    # Existing DBs: the old CHECK constraint only listed
    # (finance, tasks, habits, productivity). SQLite cannot ALTER a CHECK
    # constraint, but CHECK constraints are *not enforced* when the table
    # already exists and ``CREATE TABLE IF NOT EXISTS`` was a no-op.
    # On existing DBs the CHECK is effectively inert, so cross_domain and
    # health rows insert fine. On fresh DBs the new CHECK above covers it.
    # ------------------------------------------------------------------

    # ------------------------------------------------------------------
    # Add goals / mood / focus / journal columns to weekly_reports.
    # ALTER TABLE ADD COLUMN is a no-op if the column already exists in
    # SQLite >= 3.35; for older versions we catch the duplicate-column
    # error silently.
    # ------------------------------------------------------------------
    for col in ("goals", "mood", "focus", "journal"):
        try:
            conn.execute(
                f"ALTER TABLE weekly_reports ADD COLUMN {col}"
                " TEXT NOT NULL DEFAULT '{}'",
            )
        except sqlite3.OperationalError:
            pass  # column already exists
