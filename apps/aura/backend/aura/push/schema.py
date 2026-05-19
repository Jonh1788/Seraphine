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

        -- Tracks which (user, task, offset) tuples we already pushed for,
        -- so the minute-tick loop doesn't fire the same reminder twice.
        -- Keyed by task+offset because a single task can have multiple
        -- reminder offsets (e.g. [0, 15, 60]).
        CREATE TABLE IF NOT EXISTS push_dispatches (
          task_id        TEXT NOT NULL,
          user_id        TEXT NOT NULL,
          offset_minutes INTEGER NOT NULL DEFAULT 0,
          dispatched_at  TEXT NOT NULL,
          PRIMARY KEY (task_id, user_id, offset_minutes)
        );
        """
    )
    # SQLite can't ALTER a PK in place — rebuild idempotently. Detect the
    # legacy shape by checking the column list; only rewrite if needed.
    cols = {
        r[1] for r in conn.execute("PRAGMA table_info(push_dispatches)").fetchall()
    }
    if "offset_minutes" not in cols:
        conn.executescript(
            """
            ALTER TABLE push_dispatches RENAME TO push_dispatches_legacy;
            CREATE TABLE push_dispatches (
              task_id        TEXT NOT NULL,
              user_id        TEXT NOT NULL,
              offset_minutes INTEGER NOT NULL DEFAULT 0,
              dispatched_at  TEXT NOT NULL,
              PRIMARY KEY (task_id, user_id, offset_minutes)
            );
            INSERT INTO push_dispatches (task_id, user_id, offset_minutes, dispatched_at)
              SELECT task_id, user_id, 0, dispatched_at FROM push_dispatches_legacy;
            DROP TABLE push_dispatches_legacy;
            """
        )
