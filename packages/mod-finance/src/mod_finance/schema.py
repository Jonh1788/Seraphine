"""Schema migrator for mod-finance.

Owns ``financial_entries`` and ``recurring_rules`` tables. Idempotent:
new DBs get the full schema in CREATE TABLE; legacy DBs (Seraphine
pre-Phase-6) get user_id added via ALTER. Indexes are created last so
they can reference newly-added columns.
"""

from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    # Step 1: create tables if missing — full schema for fresh DBs.
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS recurring_rules (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          type          TEXT NOT NULL CHECK (type IN ('income', 'expense')),
          amount        REAL NOT NULL,
          category      TEXT NOT NULL,
          description   TEXT NOT NULL,
          day_of_month  INTEGER,
          frequency     TEXT NOT NULL CHECK (frequency IN ('monthly', 'weekly', 'custom')),
          start_date    TEXT NOT NULL,
          end_date      TEXT,
          active        INTEGER NOT NULL DEFAULT 1,
          created_at    TEXT NOT NULL,
          user_id       TEXT
        );

        CREATE TABLE IF NOT EXISTS financial_entries (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          type          TEXT NOT NULL CHECK (type IN ('income', 'expense')),
          amount        REAL NOT NULL,
          currency      TEXT NOT NULL DEFAULT 'BRL',
          category      TEXT NOT NULL,
          description   TEXT NOT NULL,
          date          TEXT NOT NULL,
          source        TEXT NOT NULL,
          recurring_id  INTEGER REFERENCES recurring_rules(id),
          status        TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'pending_review')),
          created_at    TEXT NOT NULL,
          user_id       TEXT
        );
        """
    )
    # Step 2: idempotent ADD COLUMN for legacy DBs.
    for ddl in (
        "ALTER TABLE financial_entries ADD COLUMN user_id TEXT",
        "ALTER TABLE recurring_rules ADD COLUMN user_id TEXT",
    ):
        try:
            conn.execute(ddl)
        except sqlite3.OperationalError as exc:
            if "duplicate column name" not in str(exc).lower():
                raise
    # Step 3: indexes — safe now.
    conn.executescript(
        """
        CREATE INDEX IF NOT EXISTS idx_entries_date
          ON financial_entries(date);
        CREATE INDEX IF NOT EXISTS idx_entries_category
          ON financial_entries(category);
        CREATE INDEX IF NOT EXISTS idx_entries_type
          ON financial_entries(type);
        CREATE INDEX IF NOT EXISTS idx_entries_user
          ON financial_entries(user_id);
        CREATE INDEX IF NOT EXISTS idx_recurring_user
          ON recurring_rules(user_id);
        """
    )
