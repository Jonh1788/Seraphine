"""Schema migrator for goals (single-tenant, no user_id)."""

from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS goals (
          id          TEXT PRIMARY KEY,
          title       TEXT NOT NULL,
          description TEXT,
          area        TEXT NOT NULL
                        CHECK (area IN (
                          'saude','carreira','financas',
                          'pessoal','aprendizado','relacionamentos'
                        )),
          timeframe   TEXT NOT NULL
                        CHECK (timeframe IN ('quarterly','yearly','open_ended')),
          start_date  TEXT,
          end_date    TEXT,
          status      TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','paused','completed','abandoned')),
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS key_results (
          id            TEXT PRIMARY KEY,
          goal_id       TEXT NOT NULL
                          REFERENCES goals(id) ON DELETE CASCADE,
          title         TEXT NOT NULL,
          metric_type   TEXT NOT NULL
                          CHECK (metric_type IN ('numeric','boolean','percentage')),
          target_value  REAL NOT NULL,
          current_value REAL NOT NULL DEFAULT 0,
          unit          TEXT,
          auto_source   TEXT,
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS goal_links (
          id          TEXT PRIMARY KEY,
          goal_id     TEXT NOT NULL
                        REFERENCES goals(id) ON DELETE CASCADE,
          linked_type TEXT NOT NULL
                        CHECK (linked_type IN ('task','habit','project')),
          linked_id   TEXT NOT NULL,
          UNIQUE(goal_id, linked_type, linked_id)
        );

        CREATE INDEX IF NOT EXISTS idx_goals_status
          ON goals(status);
        CREATE INDEX IF NOT EXISTS idx_goals_area
          ON goals(area);
        CREATE INDEX IF NOT EXISTS idx_key_results_goal_id
          ON key_results(goal_id);
        CREATE INDEX IF NOT EXISTS idx_goal_links_goal_id
          ON goal_links(goal_id);
        """
    )
