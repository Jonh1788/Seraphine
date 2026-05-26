"""Schema migrator for notes (single-tenant, no user_id)."""

from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS notes (
          id          TEXT PRIMARY KEY,
          title       TEXT NOT NULL,
          content     TEXT NOT NULL DEFAULT '',
          tags        TEXT NOT NULL DEFAULT '[]',  -- JSON array
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_notes_updated_at
          ON notes(updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_notes_title
          ON notes(title);

        -- Bidirectional backlinks between notes (SDD-084).
        CREATE TABLE IF NOT EXISTS note_links (
          id          TEXT PRIMARY KEY,
          source_id   TEXT NOT NULL,
          target_id   TEXT NOT NULL,
          created_at  TEXT NOT NULL,
          UNIQUE(source_id, target_id)
        );
        CREATE INDEX IF NOT EXISTS idx_note_links_source
          ON note_links(source_id);
        CREATE INDEX IF NOT EXISTS idx_note_links_target
          ON note_links(target_id);
        """
    )
