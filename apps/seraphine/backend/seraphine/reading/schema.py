"""Schema migrator for reading_items (single-tenant, no user_id)."""

from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS reading_items (
          id            TEXT PRIMARY KEY,
          url           TEXT NOT NULL,
          title         TEXT NOT NULL DEFAULT '',
          domain        TEXT NOT NULL DEFAULT '',
          summary       TEXT NOT NULL DEFAULT '',
          content_text  TEXT,
          tags          TEXT NOT NULL DEFAULT '[]',   -- JSON array
          status        TEXT NOT NULL DEFAULT 'processing',
          saved_at      TEXT NOT NULL,
          read_at       TEXT,
          archived_at   TEXT,
          error_msg     TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_reading_items_status
          ON reading_items(status);
        CREATE INDEX IF NOT EXISTS idx_reading_items_saved_at
          ON reading_items(saved_at DESC);
        CREATE INDEX IF NOT EXISTS idx_reading_items_url
          ON reading_items(url);
        """
    )

    # ------------------------------------------------------------------
    # Add author / progress columns to reading_items.
    # SQLite has no IF NOT EXISTS for ADD COLUMN, so guard each ALTER with
    # try/except on OperationalError ("duplicate column name") so re-running
    # this migrator on an existing DB is a no-op. Non-destructive: both
    # columns get a default, so existing rows backfill to '' / 0.
    #   - author:   TEXT, parsed from page metadata when available.
    #   - progress: INTEGER 0-100, percent read (0 means "not started").
    # ------------------------------------------------------------------
    for ddl in (
        "ALTER TABLE reading_items ADD COLUMN author TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE reading_items ADD COLUMN progress INTEGER NOT NULL DEFAULT 0",
    ):
        try:
            conn.execute(ddl)
        except sqlite3.OperationalError:
            pass  # column already exists
