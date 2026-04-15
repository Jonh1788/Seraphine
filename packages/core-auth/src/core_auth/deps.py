"""FastAPI dependency factories.

Apps wire one of these as the ``get_current_user_id`` dep override
(see mod_tasks.routes.get_current_user_id).

- ``single_user_dep(id)`` — Seraphine. Always returns the same id.
- ``jwt_dep(secret)`` — Aura. Validates Authorization: Bearer <token>.
"""

from __future__ import annotations

from typing import Callable

from fastapi import Header, HTTPException, status

from core_auth.jwt import JWTError, verify


def single_user_dep(user_id: str = "default") -> Callable[[], str]:
    """Return a dep that always yields the same user id. Used by
    Seraphine which has no login. Pass into
    ``app.dependency_overrides`` for ``get_current_user_id``.

    Note: Seraphine historically uses ``user_id=None`` everywhere
    (single-tenant, all rows have user_id IS NULL). To keep the legacy
    behavior, override the dep to return None instead — see
    ``no_user_dep`` below.
    """

    def _dep() -> str:
        return user_id

    return _dep


def no_user_dep() -> None:
    """Returns None — Seraphine's true legacy behavior. Tasks/finance
    rows are not scoped by user_id."""
    return None


def jwt_dep(secret: str) -> Callable[..., str]:
    """Return a dep that extracts user id from a Bearer JWT in
    ``Authorization``. Used by Aura. 401 on missing or invalid token."""

    def _dep(authorization: str | None = Header(default=None)) -> str:
        if not authorization or not authorization.lower().startswith("bearer "):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="missing bearer token",
            )
        token = authorization.split(" ", 1)[1].strip()
        try:
            return verify(token, secret)
        except JWTError as e:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail=str(e),
            ) from None

    return _dep
