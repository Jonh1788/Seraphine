"""Schema migrator for focus analytics (single-tenant, no user_id)."""

from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS focus_sessions (
          id             TEXT PRIMARY KEY,
          started_at     TEXT NOT NULL,
          ended_at       TEXT NOT NULL,
          duration_sec   INTEGER NOT NULL,
          type           TEXT NOT NULL
                           CHECK (type IN ('work','short_break','long_break')),
          completed      INTEGER NOT NULL DEFAULT 1,
          interruptions  INTEGER NOT NULL DEFAULT 0,
          notes          TEXT
        );
        CREATE TABLE IF NOT EXISTS focus_app_logs (
          id             TEXT PRIMARY KEY,
          session_id     TEXT NOT NULL
                           REFERENCES focus_sessions(id) ON DELETE CASCADE,
          app_name       TEXT NOT NULL,
          started_at     TEXT NOT NULL,
          duration_sec   INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_focus_sessions_started
          ON focus_sessions(started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_focus_app_logs_session
          ON focus_app_logs(session_id);
        """
    )

    # ------------------------------------------------------------------
    # Idempotent ALTER: older DBs may not have the ``category`` column.
    # Sessions are tagged with a life/work category ('Foco' by default) so
    # insights can answer "onde foi seu tempo" (time-by-category). Existing
    # rows are backfilled to 'Foco' via the DEFAULT.
    # ------------------------------------------------------------------
    try:
        cols = {
            row[1]
            for row in conn.execute("PRAGMA table_info(focus_sessions)").fetchall()
        }
        if "category" not in cols:
            conn.execute(
                "ALTER TABLE focus_sessions ADD COLUMN category"
                " TEXT NOT NULL DEFAULT 'Foco'",
            )
            # Backfill any pre-existing rows explicitly (defensive; the column
            # DEFAULT already covers them, but make the intent unambiguous).
            conn.execute(
                "UPDATE focus_sessions SET category = 'Foco'"
                " WHERE category IS NULL OR category = ''",
            )
    except sqlite3.DatabaseError:
        # Table doesn't exist yet (first boot) -- handled by CREATE TABLE.
        pass
