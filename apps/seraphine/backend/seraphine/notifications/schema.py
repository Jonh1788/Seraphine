"""Schema migrator for notification intelligence (single-tenant)."""

from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS notification_settings (
          id             INTEGER PRIMARY KEY CHECK(id = 1),
          settings_json  TEXT NOT NULL DEFAULT '{}'
        );

        CREATE TABLE IF NOT EXISTS notification_feedback (
          id                TEXT PRIMARY KEY,
          notification_type TEXT NOT NULL,
          action            TEXT NOT NULL
                              CHECK(action IN ('opened','dismissed','snoozed','ignored')),
          timestamp         TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_notification_feedback_type_ts
          ON notification_feedback(notification_type, timestamp DESC);

        CREATE TABLE IF NOT EXISTS notification_queue (
          id             TEXT PRIMARY KEY,
          type           TEXT NOT NULL,
          title          TEXT NOT NULL,
          body           TEXT NOT NULL,
          payload_json   TEXT,
          priority       INTEGER NOT NULL DEFAULT 0,
          queued_at      TEXT NOT NULL,
          delivered_at   TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_notification_queue_delivered
          ON notification_queue(delivered_at);
        """
    )
