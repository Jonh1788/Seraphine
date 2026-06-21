"""Schema for the email urgency scanner's dedup table.

One row per Gmail ``message_id`` the scanner has already classified, so
each email is classified once and pushed at most once. ``alerted`` records
whether a WhatsApp push was actually sent (1) or not (0).
"""

from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS email_urgency_seen (
            message_id TEXT PRIMARY KEY,
            urgency    TEXT NOT NULL,
            reason     TEXT NOT NULL DEFAULT '',
            alerted    INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        )
        """
    )
