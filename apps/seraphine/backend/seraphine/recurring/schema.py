"""Schema migrator for recurring task rules (single-tenant, no user_id)."""

from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS recurring_tasks (
          id                     TEXT PRIMARY KEY,
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
          updated_at             TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_recurring_active
          ON recurring_tasks(active);
        CREATE INDEX IF NOT EXISTS idx_recurring_active_materialized
          ON recurring_tasks(active, last_materialized_date);
        """
    )
