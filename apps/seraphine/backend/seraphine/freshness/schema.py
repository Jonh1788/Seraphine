"""SQLite schema additions for the freshness module.

ALTER TABLE facts ADD COLUMN archived_at is wrapped in try/except —
SQLite has no IF NOT EXISTS for ADD COLUMN, and this migrator runs on
each boot via the MemoryStore registry. On re-runs it must be a no-op.
"""

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    with conn:
        conn.executescript(
            "CREATE INDEX IF NOT EXISTS idx_tasks_status_due "
            "ON seraphine_tasks(status, due_date);"
        )
        try:
            conn.execute("ALTER TABLE facts ADD COLUMN archived_at TEXT;")
        except sqlite3.OperationalError as e:
            if "duplicate column" not in str(e).lower():
                raise
