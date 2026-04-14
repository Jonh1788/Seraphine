"""Schema migrator for chat persistence — conversations + messages."""

from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS conversations (
          id          TEXT PRIMARY KEY,
          user_id     TEXT NOT NULL,
          title       TEXT,
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_conversations_user
          ON conversations(user_id, updated_at DESC);

        CREATE TABLE IF NOT EXISTS chat_messages (
          id              TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          role            TEXT NOT NULL CHECK (role IN ('user','assistant')),
          content         TEXT NOT NULL,
          metadata        TEXT,
          created_at      TEXT NOT NULL,
          FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_chat_messages_conv
          ON chat_messages(conversation_id, created_at);
        """
    )
    # Idempotent ADD COLUMN for legacy rows that pre-date metadata.
    try:
        conn.execute("ALTER TABLE chat_messages ADD COLUMN metadata TEXT")
    except sqlite3.OperationalError as exc:
        if "duplicate column name" not in str(exc).lower():
            raise
