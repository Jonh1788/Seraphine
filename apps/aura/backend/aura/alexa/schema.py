"""Schema migrator for the Alexa Custom Skill tables.

Three tables back the integration:
- ``aura_user_alexa`` — one row per Aura↔Amazon-account link.
- ``aura_alexa_auth_codes`` — short-lived OAuth codes (10 min TTL, single-use).
- ``aura_alexa_tokens`` — issued access/refresh tokens; refresh rotates on use.

All ``*_at`` columns store ISO-8601 UTC strings so the service layer can
compare them lexicographically without parsing.
"""

from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS aura_user_alexa (
          user_id        TEXT PRIMARY KEY,
          amazon_user_id TEXT NOT NULL UNIQUE,
          linked_at      TEXT NOT NULL,
          created_at     TEXT NOT NULL,
          updated_at     TEXT NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS aura_alexa_auth_codes (
          code           TEXT PRIMARY KEY,
          user_id        TEXT NOT NULL,
          client_id      TEXT NOT NULL,
          redirect_uri   TEXT NOT NULL,
          expires_at     TEXT NOT NULL,
          created_at     TEXT NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS aura_alexa_tokens (
          refresh_token     TEXT PRIMARY KEY,
          access_token      TEXT NOT NULL UNIQUE,
          user_id           TEXT NOT NULL,
          access_expires_at TEXT NOT NULL,
          created_at        TEXT NOT NULL,
          revoked_at        TEXT,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_alexa_tokens_user
          ON aura_alexa_tokens(user_id) WHERE revoked_at IS NULL;
        """
    )
