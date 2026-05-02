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
