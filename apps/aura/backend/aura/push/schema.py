"""Schema migrator for push_subscriptions table."""

from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS push_subscriptions (
          id          TEXT PRIMARY KEY,
          user_id     TEXT NOT NULL,
          endpoint    TEXT NOT NULL,
          p256dh      TEXT NOT NULL,
          auth        TEXT NOT NULL,
          user_agent  TEXT,
          created_at  TEXT NOT NULL,
          last_seen   TEXT NOT NULL,
          UNIQUE (user_id, endpoint),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_push_subs_user
          ON push_subscriptions(user_id);

        -- Tracks which (user, task) pairs we already pushed for, so the
        -- minute-tick loop doesn't fire the same reminder twice. Keyed
        -- by task because reminders ride on the tasks table.
        CREATE TABLE IF NOT EXISTS push_dispatches (
          task_id     TEXT NOT NULL,
          user_id     TEXT NOT NULL,
          dispatched_at TEXT NOT NULL,
          PRIMARY KEY (task_id, user_id)
        );
        """
    )
