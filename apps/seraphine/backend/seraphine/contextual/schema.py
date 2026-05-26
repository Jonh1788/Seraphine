"""095 — Schema migrator for contextual_action_usage (single-tenant)."""

from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS contextual_action_usage (
          id         TEXT PRIMARY KEY,
          app_name   TEXT NOT NULL,
          action_id  TEXT NOT NULL,
          used_at    TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_contextual_usage_app
          ON contextual_action_usage(app_name);
        CREATE INDEX IF NOT EXISTS idx_contextual_usage_action
          ON contextual_action_usage(action_id);
        """
    )
