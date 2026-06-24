"""Tests for idempotent learning-loop schema migration."""

from __future__ import annotations

import sqlite3

from seraphine.learning import schema


def test_migrate_creates_tables_idempotently():
    conn = sqlite3.connect(":memory:")
    try:
        schema.migrate(conn)
        schema.migrate(conn)  # second call must be a no-op
        rows = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
        names = {r[0] for r in rows}
        assert {
            "learning_trace",
            "learning_eval_case",
            "learning_candidate",
            "learning_policy",
        } <= names
    finally:
        conn.close()
