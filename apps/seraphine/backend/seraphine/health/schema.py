"""Schema migrator for Apple Health snapshots (single-tenant)."""

from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS health_snapshots (
          date TEXT PRIMARY KEY,
          steps INTEGER NOT NULL DEFAULT 0,
          active_calories REAL NOT NULL DEFAULT 0,
          resting_heart_rate REAL,
          sleep_minutes REAL,
          sleep_quality TEXT,
          weight_kg REAL,
          workouts_json TEXT NOT NULL DEFAULT '[]',
          synced_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_health_snapshots_synced_at
          ON health_snapshots(synced_at);
        """
    )
