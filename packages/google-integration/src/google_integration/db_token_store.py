"""SQLite-backed, per-user encrypted OAuth token store.

Used by Aura to persist Google OAuth bundles scoped to a ``user_id``.
Encryption + key derivation mirror the file-backed
:class:`~google_integration.token_store.FileTokenStore` so the on-disk
format is consistent across the two implementations.

The *table* itself is owned by the consuming application — Aura
registers the migrator for ``google_tokens`` in its own
``aura/google/schema.py``. This module only knows the column shape:

    CREATE TABLE google_tokens (
      user_id          TEXT PRIMARY KEY,
      encrypted_bundle BLOB NOT NULL,
      email            TEXT,
      created_at       TEXT,
      updated_at       TEXT
    )
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
from datetime import datetime, timezone
from typing import Any

from cryptography.fernet import Fernet, InvalidToken

from google_integration._crypto import derive_key
from google_integration.token_store import TokenBundle


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class DBTokenStore:
    """Per-user token store backed by a ``google_tokens`` SQLite row.

    The ``store`` parameter is a ``core_db.Store``-like object exposing a
    ``_connect()`` method returning an open sqlite3 connection. We keep
    the coupling loose (duck-typed) so this package doesn't depend on
    core-db directly.
    """

    def __init__(self, store: Any, user_id: str) -> None:
        if not user_id:
            raise ValueError("user_id is required")
        self._store = store
        self._user_id = user_id
        self._lock = asyncio.Lock()
        self._fernet = Fernet(derive_key())

    @property
    def user_id(self) -> str:
        return self._user_id

    # ------------------------------------------------------------------
    # TokenStoreProtocol
    # ------------------------------------------------------------------

    async def load(self) -> TokenBundle | None:
        def _work() -> bytes | None:
            conn: sqlite3.Connection = self._store._connect()
            row = conn.execute(
                "SELECT encrypted_bundle FROM google_tokens WHERE user_id = ?",
                (self._user_id,),
            ).fetchone()
            return row[0] if row else None

        async with self._lock:
            raw = await asyncio.to_thread(_work)
        if not raw:
            return None
        try:
            plaintext = self._fernet.decrypt(raw)
        except InvalidToken:
            return None
        try:
            data = json.loads(plaintext.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None
        try:
            return TokenBundle(**data)
        except Exception:
            return None

    async def save(self, bundle: TokenBundle) -> None:
        payload = bundle.model_dump(mode="json")
        plaintext = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        ciphertext = self._fernet.encrypt(plaintext)
        ts = _now()

        def _work() -> None:
            conn: sqlite3.Connection = self._store._connect()
            with conn:
                # Upsert — preserve ``email`` and ``created_at`` on update.
                conn.execute(
                    """
                    INSERT INTO google_tokens
                        (user_id, encrypted_bundle, email, created_at, updated_at)
                    VALUES (?, ?, NULL, ?, ?)
                    ON CONFLICT(user_id) DO UPDATE SET
                        encrypted_bundle = excluded.encrypted_bundle,
                        updated_at       = excluded.updated_at
                    """,
                    (self._user_id, ciphertext, ts, ts),
                )

        async with self._lock:
            await asyncio.to_thread(_work)

    async def clear(self) -> None:
        def _work() -> None:
            conn: sqlite3.Connection = self._store._connect()
            with conn:
                conn.execute(
                    "DELETE FROM google_tokens WHERE user_id = ?",
                    (self._user_id,),
                )

        async with self._lock:
            await asyncio.to_thread(_work)

    # ------------------------------------------------------------------
    # Extras
    # ------------------------------------------------------------------

    async def set_email(self, email: str | None) -> None:
        """Cache the user's Google email on the row. Harmless if no row
        exists — the UPDATE just affects zero rows."""
        ts = _now()

        def _work() -> None:
            conn: sqlite3.Connection = self._store._connect()
            with conn:
                conn.execute(
                    "UPDATE google_tokens SET email = ?, updated_at = ?"
                    " WHERE user_id = ?",
                    (email, ts, self._user_id),
                )

        async with self._lock:
            await asyncio.to_thread(_work)

    async def get_email(self) -> str | None:
        def _work() -> str | None:
            conn: sqlite3.Connection = self._store._connect()
            row = conn.execute(
                "SELECT email FROM google_tokens WHERE user_id = ?",
                (self._user_id,),
            ).fetchone()
            return row[0] if row else None

        return await asyncio.to_thread(_work)
