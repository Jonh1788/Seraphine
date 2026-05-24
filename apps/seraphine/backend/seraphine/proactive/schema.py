from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    with conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS seraphine_proactive_job_prefs (
              job_id     TEXT PRIMARY KEY,
              paused     INTEGER NOT NULL DEFAULT 0,
              updated_at TEXT NOT NULL
            );
            """
        )
