"""User CRUD against the shared core-db Store + bcrypt-style hashing."""

from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
import uuid
from datetime import datetime, timezone

from core_auth import hash_password, verify_password
from core_db import Store
from mod_tasks.routes import MAX_OFFSET_MINUTES

logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class UserAlreadyExists(Exception):
    pass


class InvalidCredentials(Exception):
    pass


class UsersService:
    def __init__(self, store: Store) -> None:
        self._store = store

    async def register(
        self, email: str, password: str, name: str | None = None,
    ) -> str:
        """Create a user. Returns the new user id. Raises
        ``UserAlreadyExists`` if email is taken."""
        normalized = email.strip().lower()
        if not normalized or not password:
            raise InvalidCredentials("email and password are required")
        user_id = str(uuid.uuid4())
        password_hash = hash_password(password)
        ts = _now()
        clean_name = (name or "").strip() or None

        def _work() -> str:
            with self._store._connect() as conn:
                try:
                    conn.execute(
                        "INSERT INTO users (id, email, password_hash, name, created_at)"
                        " VALUES (?, ?, ?, ?, ?)",
                        (user_id, normalized, password_hash, clean_name, ts),
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

    async def get_name(self, user_id: str) -> str | None:
        def _work() -> str | None:
            with self._store._connect() as conn:
                row = conn.execute(
                    "SELECT name FROM users WHERE id = ?", (user_id,),
                ).fetchone()
            return row[0] if row and row[0] else None

        return await asyncio.to_thread(_work)

    async def get_user_id_by_email(self, email: str) -> str | None:
        """Return the user_id for a registered email, or None if not found.
        Counterpart to ``get_email`` for participant invites."""
        normalized = email.strip().lower()
        if not normalized:
            return None

        def _work() -> str | None:
            with self._store._connect() as conn:
                row = conn.execute(
                    "SELECT id FROM users WHERE email = ?", (normalized,),
                ).fetchone()
            return row[0] if row else None

        return await asyncio.to_thread(_work)

    async def get_default_reminder_offsets(self, user_id: str) -> list[int]:
        """Return the user's saved defaults, [] if NULL/missing/malformed."""

        def _work() -> str | None:
            with self._store._connect() as conn:
                row = conn.execute(
                    "SELECT default_reminder_offsets FROM users WHERE id = ?",
                    (user_id,),
                ).fetchone()
            return row[0] if row else None

        raw = await asyncio.to_thread(_work)
        if not raw:
            return []
        try:
            parsed = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return []
        if not isinstance(parsed, list):
            return []
        out: list[int] = []
        for v in parsed:
            if isinstance(v, bool) or not isinstance(v, int):
                continue
            if 0 <= v <= MAX_OFFSET_MINUTES:
                out.append(v)
        return sorted(set(out))

    async def set_default_reminder_offsets(
        self, user_id: str, offsets: list[int],
    ) -> list[int]:
        """Validate, dedupe, sort, persist as JSON. Returns the persisted
        list. Raises ValueError on out-of-range / non-int values."""
        clean: list[int] = []
        for v in offsets:
            if isinstance(v, bool) or not isinstance(v, int):
                raise ValueError("offsets must be integers (minutes)")
            if v < 0 or v > MAX_OFFSET_MINUTES:
                raise ValueError(
                    f"offsets must be 0..{MAX_OFFSET_MINUTES} (got {v})"
                )
            clean.append(v)
        clean = sorted(set(clean))
        payload = json.dumps(clean)

        def _work() -> int:
            with self._store._connect() as conn:
                cur = conn.execute(
                    "UPDATE users SET default_reminder_offsets = ?"
                    " WHERE id = ?",
                    (payload, user_id),
                )
            return cur.rowcount or 0

        affected = await asyncio.to_thread(_work)
        if not affected:
            raise LookupError(f"no user with id {user_id}")
        return clean
