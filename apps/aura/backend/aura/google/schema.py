"""Migrator for Aura's per-user Google OAuth token table.

One row per user. ``encrypted_bundle`` is Fernet-encrypted JSON
produced by :class:`~google_integration.db_token_store.DBTokenStore`.
``email`` is cached so ``/google/status`` doesn't have to call Google
every time the chip polls.
"""

from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS google_tokens (
          user_id          TEXT PRIMARY KEY,
          encrypted_bundle BLOB NOT NULL,
          email            TEXT,
          created_at       TEXT,
          updated_at       TEXT
        );
        """
    )
