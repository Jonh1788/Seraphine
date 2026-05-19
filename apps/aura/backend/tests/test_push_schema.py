"""Push schema migration: idempotent rebuild of push_dispatches PK to
include offset_minutes, with backfill for the legacy 2-col shape."""
from __future__ import annotations

import sqlite3

import pytest

from aura.push.schema import migrate


def test_migrate_fresh_db_creates_offset_column():
    conn = sqlite3.connect(":memory:")
    migrate(conn)
    cols = {r[1] for r in conn.execute("PRAGMA table_info(push_dispatches)").fetchall()}
    assert "offset_minutes" in cols


def test_migrate_is_idempotent():
    conn = sqlite3.connect(":memory:")
    migrate(conn)
    migrate(conn)  # must not raise
    migrate(conn)


def test_pk_allows_multiple_offsets_per_task():
    conn = sqlite3.connect(":memory:")
    migrate(conn)
    conn.execute(
        "INSERT INTO push_dispatches (task_id, user_id, offset_minutes, dispatched_at)"
        " VALUES ('t1', 'u1', 0, 'd')"
    )
    conn.execute(
        "INSERT INTO push_dispatches (task_id, user_id, offset_minutes, dispatched_at)"
        " VALUES ('t1', 'u1', 15, 'd')"
    )
    conn.execute(
        "INSERT INTO push_dispatches (task_id, user_id, offset_minutes, dispatched_at)"
        " VALUES ('t1', 'u1', 60, 'd')"
    )
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO push_dispatches"
            " (task_id, user_id, offset_minutes, dispatched_at)"
            " VALUES ('t1', 'u1', 15, 'd2')"
        )


def test_legacy_table_is_rebuilt_with_offset_zero_backfill():
    """Simulate a pre-migration DB with the old 2-col PK shape."""
    conn = sqlite3.connect(":memory:")
    conn.executescript(
        """
        CREATE TABLE push_dispatches (
          task_id     TEXT NOT NULL,
          user_id     TEXT NOT NULL,
          dispatched_at TEXT NOT NULL,
          PRIMARY KEY (task_id, user_id)
        );
        INSERT INTO push_dispatches (task_id, user_id, dispatched_at)
          VALUES ('t1', 'u1', '2026-05-01');
        INSERT INTO push_dispatches (task_id, user_id, dispatched_at)
          VALUES ('t2', 'u1', '2026-05-02');
        """
    )
    migrate(conn)
    rows = conn.execute(
        "SELECT task_id, user_id, offset_minutes, dispatched_at"
        " FROM push_dispatches ORDER BY task_id"
    ).fetchall()
    assert rows == [
        ("t1", "u1", 0, "2026-05-01"),
        ("t2", "u1", 0, "2026-05-02"),
    ]
    # Idempotent second pass.
    migrate(conn)
    rows2 = conn.execute("SELECT COUNT(*) FROM push_dispatches").fetchone()
    assert rows2 == (2,)
