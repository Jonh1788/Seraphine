"""Domain errors of the agent harness (mapped to HTTP codes by routes)."""

from __future__ import annotations


class HarnessError(Exception):
    """Base error. ``code`` is a stable machine-readable slug."""

    status = 400
    code = "error"

    def __init__(self, message: str, *, code: str | None = None) -> None:
        super().__init__(message)
        if code:
            self.code = code


class NotFound(HarnessError):
    status = 404
    code = "not_found"


class Invalid(HarnessError):
    status = 422
    code = "invalid"


class Conflict(HarnessError):
    status = 409
    code = "conflict"


class Unavailable(HarnessError):
    status = 503
    code = "unavailable"
