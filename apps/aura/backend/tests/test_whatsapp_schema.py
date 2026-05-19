import sqlite3

import pytest

from aura.whatsapp.schema import migrate


def test_migrate_creates_three_tables():
    conn = sqlite3.connect(":memory:")
    migrate(conn)
    rows = conn.execute(
        "SELECT name FROM sqlite_master "
        "WHERE type='table' AND name LIKE 'aura_%whatsapp%'"
    ).fetchall()
    names = {r[0] for r in rows}
    assert names == {
        "aura_user_whatsapp",
        "aura_whatsapp_verification",
        "aura_whatsapp_dispatches",
    }


def test_migrate_is_idempotent():
    conn = sqlite3.connect(":memory:")
    migrate(conn)
    migrate(conn)  # must not raise


def test_user_whatsapp_phone_unique():
    conn = sqlite3.connect(":memory:")
    migrate(conn)
    conn.execute(
        "INSERT INTO aura_user_whatsapp"
        " (user_id, phone_e164, verified_at, created_at, updated_at)"
        " VALUES ('u1', '+5511999999999', 't', 't', 't')"
    )
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO aura_user_whatsapp"
            " (user_id, phone_e164, verified_at, created_at, updated_at)"
            " VALUES ('u2', '+5511999999999', 't', 't', 't')"
        )


def test_dispatch_composite_pk_rejects_duplicate():
    conn = sqlite3.connect(":memory:")
    migrate(conn)
    # Default offset_minutes = 0 lets the legacy 2-col INSERT keep working.
    conn.execute(
        "INSERT INTO aura_whatsapp_dispatches (task_id, user_id, sent_at)"
        " VALUES (1, 'u1', 't')"
    )
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO aura_whatsapp_dispatches (task_id, user_id, sent_at)"
            " VALUES (1, 'u1', 't2')"
        )
    conn.execute(
        "INSERT INTO aura_whatsapp_dispatches (task_id, user_id, sent_at)"
        " VALUES (1, 'u2', 't')"
    )


def test_dispatch_pk_allows_multiple_offsets_per_task():
    conn = sqlite3.connect(":memory:")
    migrate(conn)
    conn.execute(
        "INSERT INTO aura_whatsapp_dispatches"
        " (task_id, user_id, offset_minutes, sent_at)"
        " VALUES (1, 'u1', 0, 't')"
    )
    conn.execute(
        "INSERT INTO aura_whatsapp_dispatches"
        " (task_id, user_id, offset_minutes, sent_at)"
        " VALUES (1, 'u1', 15, 't')"
    )
    conn.execute(
        "INSERT INTO aura_whatsapp_dispatches"
        " (task_id, user_id, offset_minutes, sent_at)"
        " VALUES (1, 'u1', 60, 't')"
    )
    with pytest.raises(sqlite3.IntegrityError):
        # Same offset → PK collision.
        conn.execute(
            "INSERT INTO aura_whatsapp_dispatches"
            " (task_id, user_id, offset_minutes, sent_at)"
            " VALUES (1, 'u1', 15, 't2')"
        )


def test_legacy_dispatch_table_migrates_to_offset_pk():
    """A pre-existing two-column PK table must be rebuilt with offset
    column + 3-col PK, preserving rows as offset_minutes=0."""
    conn = sqlite3.connect(":memory:")
    # Simulate the old schema.
    conn.executescript(
        """
        CREATE TABLE aura_whatsapp_dispatches (
          task_id    INTEGER NOT NULL,
          user_id    TEXT NOT NULL,
          sent_at    TEXT NOT NULL,
          PRIMARY KEY (task_id, user_id)
        );
        INSERT INTO aura_whatsapp_dispatches (task_id, user_id, sent_at)
          VALUES (1, 'u1', '2026-05-01');
        INSERT INTO aura_whatsapp_dispatches (task_id, user_id, sent_at)
          VALUES (2, 'u1', '2026-05-02');
        """
    )
    migrate(conn)
    rows = conn.execute(
        "SELECT task_id, user_id, offset_minutes, sent_at"
        " FROM aura_whatsapp_dispatches ORDER BY task_id"
    ).fetchall()
    assert rows == [(1, "u1", 0, "2026-05-01"), (2, "u1", 0, "2026-05-02")]
    # Migrate again → idempotent.
    migrate(conn)
    rows2 = conn.execute(
        "SELECT COUNT(*) FROM aura_whatsapp_dispatches"
    ).fetchone()
    assert rows2 == (2,)
