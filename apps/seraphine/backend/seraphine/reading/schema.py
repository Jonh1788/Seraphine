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
