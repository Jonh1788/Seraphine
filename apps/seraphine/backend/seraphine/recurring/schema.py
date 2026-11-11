"""Schema migrator for recurring task rules + user routines (single-tenant)."""

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
          -- Inclusive last day the rule fires (YYYY-MM-DD). NULL = forever.
          end_date               TEXT,
          -- at_time | 1h_before. NULL = regra sem lembrete. (Sem 1d_before:
          -- a ocorrência nasce no dia em que vence.)
          remind                 TEXT,
          active                 INTEGER NOT NULL DEFAULT 1,
          last_materialized_date TEXT,
          created_at             TEXT NOT NULL,
          updated_at             TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_recurring_active
          ON recurring_tasks(active);
        CREATE INDEX IF NOT EXISTS idx_recurring_active_materialized
          ON recurring_tasks(active, last_materialized_date);

        -- Routines: curated + user-authored prompt launchers. Distinct from
        -- recurring_tasks (which materialize into mod_tasks). A routine just
        -- carries a prompt/action launched into the chat composer, plus an
        -- enabled toggle and an optional human-readable trigger label.
        CREATE TABLE IF NOT EXISTS routines (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          detail      TEXT NOT NULL DEFAULT '',
          kind        TEXT NOT NULL DEFAULT 'manual'
                        CHECK (kind IN ('scheduled','manual')),
          trigger     TEXT,
          enabled     INTEGER NOT NULL DEFAULT 1,
          prompt      TEXT NOT NULL DEFAULT '',
          icon        TEXT,
          icon_bg     TEXT,
          icon_color  TEXT,
          job_name    TEXT,
          builtin     INTEGER NOT NULL DEFAULT 0,
          sort_order  INTEGER NOT NULL DEFAULT 0,
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_routines_kind
          ON routines(kind);
        CREATE INDEX IF NOT EXISTS idx_routines_enabled
          ON routines(enabled);
        """
    )

    # ------------------------------------------------------------------
    # Idempotent ALTERs: older DBs (created before the routines table or
    # before a given column existed) get the missing columns added with a
    # default, never dropping/rewriting existing data.
    # ------------------------------------------------------------------
    try:
        rec_cols = {
            row[1]
            for row in conn.execute("PRAGMA table_info(recurring_tasks)").fetchall()
        }
        for col in ("end_date", "remind"):
            if col not in rec_cols:
                conn.execute(f"ALTER TABLE recurring_tasks ADD COLUMN {col} TEXT")
    except sqlite3.DatabaseError:
        pass

    try:
        cols = {
            row[1] for row in conn.execute("PRAGMA table_info(routines)").fetchall()
        }
        # Map of column name -> ALTER fragment for any column that might be
        # missing on a pre-existing routines table.
        additions: dict[str, str] = {
            "detail": "ALTER TABLE routines ADD COLUMN detail TEXT NOT NULL DEFAULT ''",
            "trigger": "ALTER TABLE routines ADD COLUMN trigger TEXT",
            "icon": "ALTER TABLE routines ADD COLUMN icon TEXT",
            "icon_bg": "ALTER TABLE routines ADD COLUMN icon_bg TEXT",
            "icon_color": "ALTER TABLE routines ADD COLUMN icon_color TEXT",
            "job_name": "ALTER TABLE routines ADD COLUMN job_name TEXT",
            "builtin": "ALTER TABLE routines ADD COLUMN builtin INTEGER NOT NULL DEFAULT 0",
            "sort_order": "ALTER TABLE routines ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0",
        }
        for col, ddl in additions.items():
            if col not in cols:
                conn.execute(ddl)
    except sqlite3.DatabaseError:
        # Table doesn't exist yet (first boot) -- CREATE TABLE above covers it.
        pass
