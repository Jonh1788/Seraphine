"""OAuth2 Authorization Code provider for the Alexa skill.

Aura is its own OAuth2 server here. The Alexa app calls
``/alexa/oauth/authorize``; the user authenticates with the regular Aura
session and authorizes the link; we hand back a short-lived code; Amazon
calls ``/alexa/oauth/token`` (Basic Auth with client_id/client_secret) and
trades it for an access_token + refresh_token. Refresh rotates on use.
"""

from __future__ import annotations

import hmac
import logging
import secrets
import sqlite3
from datetime import UTC, datetime, timedelta
from typing import Iterable

logger = logging.getLogger(__name__)


class OAuthError(Exception):
    """Base for OAuth errors."""


class InvalidClientError(OAuthError):
    """Bad client_id or client_secret."""


class InvalidGrantError(OAuthError):
    """Code/refresh missing, expired, consumed, or revoked."""


class InvalidRedirectError(OAuthError):
    """redirect_uri not in the whitelist."""


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _iso(dt: datetime) -> str:
    return dt.isoformat()


class AlexaOAuth:
    def __init__(
        self,
        *,
        conn: sqlite3.Connection,
        client_id: str,
        client_secret: str,
        allowed_redirects: Iterable[str],
        access_ttl_seconds: int = 3600,
        code_ttl_seconds: int = 600,
    ) -> None:
        """Construct an OAuth provider bound to a SQLite connection.

        The connection must permit cross-thread access (``check_same_thread=False``
        or wrapped in a per-request factory) because FastAPI dispatches sync
        handlers across a threadpool. Caller is responsible for that setup;
        this class does not own connection lifecycle.
        """
        self._conn = conn
        self._client_id = client_id
        self._client_secret = client_secret
        self._allowed_redirects = frozenset(allowed_redirects)
        self._access_ttl = access_ttl_seconds
        self._code_ttl = code_ttl_seconds

    # ----- authorization endpoint helpers --------------------------------

    def is_allowed_redirect(self, redirect_uri: str) -> bool:
        return redirect_uri in self._allowed_redirects

    def issue_code(self, user_id: str, *, client_id: str, redirect_uri: str) -> str:
        if not hmac.compare_digest(client_id, self._client_id):
            raise InvalidClientError("unknown client_id")
        if not self.is_allowed_redirect(redirect_uri):
            raise InvalidRedirectError(f"redirect not allowed: {redirect_uri!r}")
        code = secrets.token_urlsafe(32)
        expires = _iso(datetime.now(UTC) + timedelta(seconds=self._code_ttl))
        now = _now_iso()
        self._conn.execute(
            "INSERT INTO aura_alexa_auth_codes"
            " (code, user_id, client_id, redirect_uri, expires_at, created_at)"
            " VALUES (?,?,?,?,?,?)",
            (code, user_id, client_id, redirect_uri, expires, now),
        )
        self._conn.commit()
        return code

    # ----- token endpoint ------------------------------------------------

    def exchange_code(
        self,
        *,
        code: str,
        client_id: str,
        client_secret: str,
        redirect_uri: str,
    ) -> dict[str, object]:
        self._check_client(client_id, client_secret)
        row = self._conn.execute(
            "SELECT user_id, redirect_uri, expires_at FROM aura_alexa_auth_codes"
            " WHERE code=?",
            (code,),
        ).fetchone()
        if row is None:
            raise InvalidGrantError("code unknown or already consumed")
        user_id, stored_redirect, expires_at = row
        # Always consume on lookup (single-use), even if the rest fails.
        # Commit immediately so a downstream validation failure cannot
        # leave the code re-usable.
        self._conn.execute("DELETE FROM aura_alexa_auth_codes WHERE code=?", (code,))
        self._conn.commit()
        if expires_at < _now_iso():
            raise InvalidGrantError("code expired")
        if not hmac.compare_digest(stored_redirect, redirect_uri):
            raise InvalidGrantError("redirect_uri mismatch")
        # Mint tokens atomically (single transaction: INSERT + commit).
        with self._conn:
            return self._mint_tokens(user_id)

    def refresh(
        self,
        *,
        refresh_token: str,
        client_id: str,
        client_secret: str,
    ) -> dict[str, object]:
        self._check_client(client_id, client_secret)
        row = self._conn.execute(
            "SELECT user_id, revoked_at FROM aura_alexa_tokens WHERE refresh_token=?",
            (refresh_token,),
        ).fetchone()
        if row is None:
            raise InvalidGrantError("refresh unknown")
        user_id, revoked_at = row
        if revoked_at is not None:
            raise InvalidGrantError("refresh revoked")
        # Rotate atomically: revoke old + mint new in a single transaction so
        # a crash mid-flight cannot leave the user with no usable tokens.
        with self._conn:
            self._conn.execute(
                "UPDATE aura_alexa_tokens SET revoked_at=? WHERE refresh_token=?",
                (_now_iso(), refresh_token),
            )
            return self._mint_tokens(user_id)

    # ----- introspection -------------------------------------------------

    def user_id_from_access_token(self, access_token: str) -> str | None:
        row = self._conn.execute(
            "SELECT user_id, access_expires_at, revoked_at FROM aura_alexa_tokens"
            " WHERE access_token=?",
            (access_token,),
        ).fetchone()
        if row is None:
            return None
        user_id, expires_at, revoked_at = row
        if revoked_at is not None:
            return None
        if expires_at < _now_iso():
            return None
        return user_id

    def revoke_all_for_user(self, user_id: str) -> int:
        cur = self._conn.execute(
            "UPDATE aura_alexa_tokens SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL",
            (_now_iso(), user_id),
        )
        self._conn.commit()
        return cur.rowcount

    # ----- internals -----------------------------------------------------

    def _check_client(self, client_id: str, client_secret: str) -> None:
        # Why: a single generic message prevents an attacker from probing
        # valid client_ids by diffing the response between a wrong id and
        # a wrong secret. ``hmac.compare_digest`` keeps both comparisons
        # constant-time; we AND them together so neither short-circuits.
        if not (
            hmac.compare_digest(client_id, self._client_id)
            and hmac.compare_digest(client_secret, self._client_secret)
        ):
            raise InvalidClientError("invalid client credentials")

    def _mint_tokens(self, user_id: str) -> dict[str, object]:
        """Insert a fresh access/refresh pair.

        Caller MUST wrap the call in ``with self._conn:`` so the INSERT
        commits (or rolls back) atomically with any surrounding statements
        in the same transaction.
        """
        access = secrets.token_urlsafe(32)
        refresh = secrets.token_urlsafe(48)
        expires = _iso(datetime.now(UTC) + timedelta(seconds=self._access_ttl))
        now = _now_iso()
        self._conn.execute(
            "INSERT INTO aura_alexa_tokens"
            " (refresh_token, access_token, user_id, access_expires_at, created_at)"
            " VALUES (?,?,?,?,?)",
            (refresh, access, user_id, expires, now),
        )
        return {
            "access_token": access,
            "refresh_token": refresh,
            "token_type": "Bearer",
            "expires_in": self._access_ttl,
        }
