"""Schema migrator for journal entries (single-tenant, no user_id)."""

from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS journal_entries (
          id            TEXT PRIMARY KEY,
          date          TEXT NOT NULL,
          type          TEXT NOT NULL,
          title         TEXT NOT NULL,
          content       TEXT NOT NULL DEFAULT '',
          mood_label    TEXT,
          mood_valence  REAL,
          source        TEXT NOT NULL DEFAULT 'user',
          tags          TEXT NOT NULL DEFAULT '[]',
          source_id     TEXT,
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_journal_entries_date
          ON journal_entries(date DESC);
        CREATE INDEX IF NOT EXISTS idx_journal_entries_type
          ON journal_entries(type);
        CREATE INDEX IF NOT EXISTS idx_journal_entries_source
          ON journal_entries(source);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_journal_entries_date_type_source
          ON journal_entries(date, type, source_id)
          WHERE source != 'user';
        """
    )

    # ------------------------------------------------------------------
    # Non-destructive migrations for pre-existing DBs.
    # ALTER TABLE ADD COLUMN is a no-op if the column already exists in
    # SQLite >= 3.35; older versions raise a duplicate-column error which
    # we swallow.  Every column carries a default so existing rows backfill
    # automatically (mood stays NULL until snapshotted; reflection NULL).
    # ------------------------------------------------------------------
    for ddl in (
        "ALTER TABLE journal_entries ADD COLUMN mood_label TEXT",
        "ALTER TABLE journal_entries ADD COLUMN mood_valence REAL",
        "ALTER TABLE journal_entries ADD COLUMN reflection TEXT",
    ):
        try:
            conn.execute(ddl)
        except sqlite3.OperationalError:
            pass  # column already exists
