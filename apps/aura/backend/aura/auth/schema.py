"""Schema migrator for the users table — registered against core-db Store."""

from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
          id            TEXT PRIMARY KEY,
          email         TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          name          TEXT,
          created_at    TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
        """
    )
    # Idempotently add `name` for users created before the column existed.
    # SQLite ADD COLUMN errors if the column already exists, so we probe
    # via PRAGMA first instead of swallowing the error blindly.
    cols = {r[1] for r in conn.execute("PRAGMA table_info(users)").fetchall()}
    if "name" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN name TEXT")
