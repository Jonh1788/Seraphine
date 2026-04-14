"""User CRUD against the shared core-db Store + bcrypt-style hashing."""

from __future__ import annotations

import asyncio
import sqlite3
import uuid
from datetime import datetime, timezone

from core_auth import hash_password, verify_password
from core_db import Store


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class UserAlreadyExists(Exception):
    pass


class InvalidCredentials(Exception):
    pass


class UsersService:
    def __init__(self, store: Store) -> None:
        self._store = store

    async def register(self, email: str, password: str) -> str:
        """Create a user. Returns the new user id. Raises
        ``UserAlreadyExists`` if email is taken."""
        normalized = email.strip().lower()
        if not normalized or not password:
            raise InvalidCredentials("email and password are required")
        user_id = str(uuid.uuid4())
        password_hash = hash_password(password)
        ts = _now()

        def _work() -> str:
            with self._store._connect() as conn:
                try:
                    conn.execute(
                        "INSERT INTO users (id, email, password_hash, created_at)"
                        " VALUES (?, ?, ?, ?)",
                        (user_id, normalized, password_hash, ts),
                    )
                except sqlite3.IntegrityError:
                    raise UserAlreadyExists(email) from None
            return user_id

        return await asyncio.to_thread(_work)

    async def authenticate(self, email: str, password: str) -> str:
        """Validate credentials. Returns the user id on success.
        Raises ``InvalidCredentials`` on failure."""
        normalized = email.strip().lower()

        def _work() -> tuple[str, str] | None:
            with self._store._connect() as conn:
                row = conn.execute(
                    "SELECT id, password_hash FROM users WHERE email = ?",
                    (normalized,),
                ).fetchone()
            return row

        row = await asyncio.to_thread(_work)
        if row is None:
            raise InvalidCredentials("invalid credentials")
        user_id, password_hash = row[0], row[1]
        if not verify_password(password_hash, password):
            raise InvalidCredentials("invalid credentials")
        return user_id

    async def get_email(self, user_id: str) -> str | None:
        def _work() -> str | None:
            with self._store._connect() as conn:
                row = conn.execute(
                    "SELECT email FROM users WHERE id = ?", (user_id,),
                ).fetchone()
            return row[0] if row else None

        return await asyncio.to_thread(_work)
