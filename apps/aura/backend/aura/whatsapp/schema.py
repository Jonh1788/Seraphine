"""Schema migrator for the WhatsApp integration tables.

Defines the three tables that back the WhatsApp pairing/dispatch flow:
``aura_user_whatsapp`` (verified phone per user), ``aura_whatsapp_verification``
(pending OTP codes), and ``aura_whatsapp_dispatches`` (per-task delivery log).

All ``*_at`` and ``expires_at`` columns store ISO-8601 UTC strings, so future
service code (T4) can compare them lexicographically without parsing.
"""

from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS aura_user_whatsapp (
          user_id     TEXT PRIMARY KEY,
          phone_e164  TEXT NOT NULL UNIQUE,
          verified_at TEXT NOT NULL,
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS aura_whatsapp_verification (
          user_id     TEXT PRIMARY KEY,
          phone_e164  TEXT NOT NULL,
          code        TEXT NOT NULL,
          expires_at  TEXT NOT NULL,
          attempts    INTEGER NOT NULL DEFAULT 0,
          created_at  TEXT NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS aura_whatsapp_dispatches (
          task_id    INTEGER NOT NULL,
          user_id    TEXT NOT NULL,
          sent_at    TEXT NOT NULL,
          PRIMARY KEY (task_id, user_id),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        """
    )
