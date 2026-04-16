"""Schema migrator for water tracking (single-tenant, no user_id)."""

from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS water_profile (
          id INTEGER PRIMARY KEY CHECK(id=1),
          weight_kg REAL NOT NULL,
          height_cm REAL,
          activity_level TEXT NOT NULL
            CHECK(activity_level IN ('sedentary','moderate','active')),
          daily_goal_ml INTEGER NOT NULL,
          reminder_enabled INTEGER NOT NULL DEFAULT 1,
          reminder_start TEXT NOT NULL DEFAULT '08:00',
          reminder_end TEXT NOT NULL DEFAULT '22:00',
          reminder_interval_hours INTEGER NOT NULL DEFAULT 2,
          updated_at TEXT NOT NULL,
          last_reminder_fired_at TEXT
        );
        CREATE TABLE IF NOT EXISTS water_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          amount_ml INTEGER NOT NULL,
          date TEXT NOT NULL,
          logged_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_water_logs_date
          ON water_logs(date);
        """
    )

    # ------------------------------------------------------------------
    # Idempotent ALTER: older DBs may not have last_reminder_fired_at
    # ------------------------------------------------------------------
    try:
        cols = {
            row[1]
            for row in conn.execute("PRAGMA table_info(water_profile)").fetchall()
        }
        if "last_reminder_fired_at" not in cols:
            conn.execute(
                "ALTER TABLE water_profile ADD COLUMN last_reminder_fired_at TEXT"
            )
    except sqlite3.DatabaseError:
        # Table doesn't exist yet (first boot) -- CREATE TABLE above covers it.
        pass
