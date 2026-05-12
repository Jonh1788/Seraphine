import sqlite3
from datetime import UTC, datetime, timedelta

import pytest

from aura.alexa.oauth import (
    AlexaOAuth,
    InvalidGrantError,
    InvalidClientError,
    InvalidRedirectError,
)
from aura.alexa.schema import migrate


@pytest.fixture
def conn():
    c = sqlite3.connect(":memory:")
    c.executescript(
        "CREATE TABLE users (id TEXT PRIMARY KEY);"
        "INSERT INTO users (id) VALUES ('u1');"
    )
    migrate(c)
    return c


@pytest.fixture
def oauth(conn):
    return AlexaOAuth(
        conn=conn,
        client_id="cid",
        client_secret="csecret",
        allowed_redirects=("https://layla.amazon.com/api/skill/link/v",),
        access_ttl_seconds=3600,
        code_ttl_seconds=600,
    )


def test_issue_code_persists_row(oauth, conn):
    code = oauth.issue_code(
        user_id="u1",
        client_id="cid",
        redirect_uri="https://layla.amazon.com/api/skill/link/v",
    )
    row = conn.execute(
        "SELECT user_id, client_id, redirect_uri FROM aura_alexa_auth_codes WHERE code=?",
        (code,),
    ).fetchone()
    assert row == ("u1", "cid", "https://layla.amazon.com/api/skill/link/v")


def test_issue_code_rejects_unknown_client(oauth):
    with pytest.raises(InvalidClientError):
        oauth.issue_code("u1", client_id="other", redirect_uri="https://layla.amazon.com/api/skill/link/v")


def test_issue_code_rejects_disallowed_redirect(oauth):
    with pytest.raises(InvalidRedirectError):
        oauth.issue_code("u1", client_id="cid", redirect_uri="https://evil.com/cb")


def test_exchange_code_returns_tokens(oauth):
    code = oauth.issue_code("u1", client_id="cid", redirect_uri="https://layla.amazon.com/api/skill/link/v")
    tokens = oauth.exchange_code(
        code=code,
        client_id="cid",
        client_secret="csecret",
        redirect_uri="https://layla.amazon.com/api/skill/link/v",
    )
    assert tokens["token_type"] == "Bearer"
    assert tokens["expires_in"] == 3600
    assert tokens["access_token"]
    assert tokens["refresh_token"]


def test_exchange_code_single_use(oauth):
    code = oauth.issue_code("u1", client_id="cid", redirect_uri="https://layla.amazon.com/api/skill/link/v")
    oauth.exchange_code(code=code, client_id="cid", client_secret="csecret",
                       redirect_uri="https://layla.amazon.com/api/skill/link/v")
    with pytest.raises(InvalidGrantError):
        oauth.exchange_code(code=code, client_id="cid", client_secret="csecret",
                            redirect_uri="https://layla.amazon.com/api/skill/link/v")


def test_exchange_code_wrong_secret(oauth):
    code = oauth.issue_code("u1", client_id="cid", redirect_uri="https://layla.amazon.com/api/skill/link/v")
    with pytest.raises(InvalidClientError):
        oauth.exchange_code(code=code, client_id="cid", client_secret="WRONG",
                            redirect_uri="https://layla.amazon.com/api/skill/link/v")


def test_exchange_code_expired(oauth, conn):
    code = oauth.issue_code("u1", client_id="cid", redirect_uri="https://layla.amazon.com/api/skill/link/v")
    past = (datetime.now(UTC) - timedelta(seconds=10)).isoformat()
    conn.execute("UPDATE aura_alexa_auth_codes SET expires_at=? WHERE code=?", (past, code))
    with pytest.raises(InvalidGrantError):
        oauth.exchange_code(code=code, client_id="cid", client_secret="csecret",
                            redirect_uri="https://layla.amazon.com/api/skill/link/v")


def test_refresh_rotates(oauth):
    code = oauth.issue_code("u1", client_id="cid", redirect_uri="https://layla.amazon.com/api/skill/link/v")
    first = oauth.exchange_code(code=code, client_id="cid", client_secret="csecret",
                                redirect_uri="https://layla.amazon.com/api/skill/link/v")
    second = oauth.refresh(refresh_token=first["refresh_token"], client_id="cid", client_secret="csecret")
    assert second["access_token"] != first["access_token"]
    assert second["refresh_token"] != first["refresh_token"]
    # Old refresh now revoked.
    with pytest.raises(InvalidGrantError):
        oauth.refresh(refresh_token=first["refresh_token"], client_id="cid", client_secret="csecret")


def test_user_id_from_access_token(oauth):
    code = oauth.issue_code("u1", client_id="cid", redirect_uri="https://layla.amazon.com/api/skill/link/v")
    t = oauth.exchange_code(code=code, client_id="cid", client_secret="csecret",
                            redirect_uri="https://layla.amazon.com/api/skill/link/v")
    assert oauth.user_id_from_access_token(t["access_token"]) == "u1"


def test_user_id_from_access_token_expired(oauth, conn):
    code = oauth.issue_code("u1", client_id="cid", redirect_uri="https://layla.amazon.com/api/skill/link/v")
    t = oauth.exchange_code(code=code, client_id="cid", client_secret="csecret",
                            redirect_uri="https://layla.amazon.com/api/skill/link/v")
    past = (datetime.now(UTC) - timedelta(seconds=10)).isoformat()
    conn.execute("UPDATE aura_alexa_tokens SET access_expires_at=? WHERE access_token=?",
                 (past, t["access_token"]))
    assert oauth.user_id_from_access_token(t["access_token"]) is None
