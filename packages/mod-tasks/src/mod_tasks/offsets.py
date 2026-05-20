"""Shared reminder-offset constants + validator.

Hosted here (not in routes.py) so non-route callers — Aura's recurring
service, the auth defaults setter, etc. — don't have to depend on
FastAPI just to validate a list of integers.
"""

from __future__ import annotations

from fastapi import HTTPException


# 30 days in minutes — anything larger is almost certainly a unit mistake.
MAX_OFFSET_MINUTES = 60 * 24 * 30


def validate_offsets(raw: list[int] | None) -> list[int] | None:
    """Validate user-supplied offsets. Returns None if input is None.
    Raises 422 on negative / out-of-range / non-int values."""
    if raw is None:
        return None
    cleaned: list[int] = []
    for o in raw:
        if not isinstance(o, int) or isinstance(o, bool):
            raise HTTPException(
                status_code=422,
                detail="reminder_offsets must be integers (minutes)",
            )
        if o < 0 or o > MAX_OFFSET_MINUTES:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"reminder_offsets must be 0..{MAX_OFFSET_MINUTES}"
                    f" (got {o})"
                ),
            )
        cleaned.append(o)
    return cleaned
