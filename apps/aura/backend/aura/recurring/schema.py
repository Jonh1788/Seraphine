"""Schema migrator for recurring task rules."""

from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS recurring_tasks (
          id                     TEXT PRIMARY KEY,
          user_id                TEXT NOT NULL,
          title                  TEXT NOT NULL,
          description            TEXT,
          frequency              TEXT NOT NULL
                                   CHECK (frequency IN ('daily','weekly','monthly')),
          weekday                INTEGER,
          day_of_month           INTEGER,
          time                   TEXT,
          active                 INTEGER NOT NULL DEFAULT 1,
          last_materialized_date TEXT,
          created_at             TEXT NOT NULL,
          updated_at             TEXT NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_recurring_user_active
          ON recurring_tasks(user_id, active);
        CREATE INDEX IF NOT EXISTS idx_recurring_active_materialized
          ON recurring_tasks(active, last_materialized_date);
        """
    )
