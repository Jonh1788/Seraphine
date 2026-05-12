import sqlite3

import pytest

from aura.alexa.schema import migrate


def test_migrate_creates_three_tables():
    conn = sqlite3.connect(":memory:")
    migrate(conn)
    rows = conn.execute(
        "SELECT name FROM sqlite_master "
        "WHERE type='table' AND name LIKE 'aura_%alexa%'"
    ).fetchall()
    names = {r[0] for r in rows}
    assert names == {
        "aura_user_alexa",
        "aura_alexa_auth_codes",
        "aura_alexa_tokens",
    }


def test_migrate_is_idempotent():
    conn = sqlite3.connect(":memory:")
    migrate(conn)
    migrate(conn)  # must not raise


def test_user_alexa_amazon_id_unique():
    conn = sqlite3.connect(":memory:")
    migrate(conn)
    conn.execute(
        "INSERT INTO aura_user_alexa"
        " (user_id, amazon_user_id, linked_at, created_at, updated_at)"
        " VALUES ('u1', 'amzn1.account.A', 't', 't', 't')"
    )
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO aura_user_alexa"
            " (user_id, amazon_user_id, linked_at, created_at, updated_at)"
            " VALUES ('u2', 'amzn1.account.A', 't', 't', 't')"
        )


def test_tokens_access_token_unique():
    conn = sqlite3.connect(":memory:")
    migrate(conn)
    conn.execute(
        "INSERT INTO aura_alexa_tokens"
        " (refresh_token, access_token, user_id, access_expires_at, created_at)"
        " VALUES ('r1', 'a1', 'u1', 't', 't')"
    )
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO aura_alexa_tokens"
            " (refresh_token, access_token, user_id, access_expires_at, created_at)"
            " VALUES ('r2', 'a1', 'u1', 't', 't')"
        )
