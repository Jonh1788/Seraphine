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
          task_id        INTEGER NOT NULL,
          user_id        TEXT NOT NULL,
          offset_minutes INTEGER NOT NULL DEFAULT 0,
          sent_at        TEXT NOT NULL,
          PRIMARY KEY (task_id, user_id, offset_minutes),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        """
    )
    # Idempotent migration: rebuild the PK to include offset_minutes
    # when an older deployment is missing the column. The CREATE TABLE
    # IF NOT EXISTS above takes care of new DBs; this branch lifts a
    # legacy two-column DB onto the new shape.
    cols = {
        r[1] for r in conn.execute(
            "PRAGMA table_info(aura_whatsapp_dispatches)"
        ).fetchall()
    }
    if "offset_minutes" not in cols:
        conn.executescript(
            """
            ALTER TABLE aura_whatsapp_dispatches RENAME TO aura_whatsapp_dispatches_legacy;
            CREATE TABLE aura_whatsapp_dispatches (
              task_id        INTEGER NOT NULL,
              user_id        TEXT NOT NULL,
              offset_minutes INTEGER NOT NULL DEFAULT 0,
              sent_at        TEXT NOT NULL,
              PRIMARY KEY (task_id, user_id, offset_minutes),
              FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            INSERT INTO aura_whatsapp_dispatches (task_id, user_id, offset_minutes, sent_at)
              SELECT task_id, user_id, 0, sent_at FROM aura_whatsapp_dispatches_legacy;
            DROP TABLE aura_whatsapp_dispatches_legacy;
            """
        )
