"""Schema migrator for Deep Research (deepsearch) — single-tenant.

Two tables:
  - ``deepsearch_runs``   — one row per research run (history + resume).
  - ``deepsearch_config`` — single-row per-role model config (id=1),
    seeded with the cliproxy defaults.
"""

from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS deepsearch_runs (
          id           TEXT PRIMARY KEY,
          query        TEXT NOT NULL,
          mode         TEXT NOT NULL,
          status       TEXT NOT NULL,
          report       TEXT,
          sources      TEXT NOT NULL DEFAULT '[]',
          progress     TEXT,
          fanout_model TEXT,
          synth_model  TEXT,
          created_at   TEXT NOT NULL,
          finished_at  TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_deepsearch_created
          ON deepsearch_runs(created_at DESC);
        CREATE TABLE IF NOT EXISTS deepsearch_config (
          id            INTEGER PRIMARY KEY CHECK (id = 1),
          fanout_model  TEXT NOT NULL DEFAULT 'cliproxy:claude-haiku-4-5-20251001',
          synth_model   TEXT NOT NULL DEFAULT 'cliproxy:claude-opus-4-8',
          openrouter_key TEXT NOT NULL DEFAULT ''
        );
        INSERT OR IGNORE INTO deepsearch_config (id) VALUES (1);
        """
    )
