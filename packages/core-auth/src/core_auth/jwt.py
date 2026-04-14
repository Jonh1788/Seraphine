"""HS256 JWT helpers for Aura's auth flow.

Tokens carry only ``sub`` (user id) and ``exp``. No claim sprawl —
add fields here only when there's a concrete need.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time


class JWTError(Exception):
    pass


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding)


def issue(
    user_id: str,
    secret: str,
    *,
    expires_in_seconds: int = 60 * 60 * 24 * 7,  # 7 days
) -> str:
    header = {"alg": "HS256", "typ": "JWT"}
    payload = {"sub": user_id, "exp": int(time.time()) + expires_in_seconds}

    header_b64 = _b64url_encode(
        json.dumps(header, separators=(",", ":")).encode("utf-8")
    )
    payload_b64 = _b64url_encode(
        json.dumps(payload, separators=(",", ":")).encode("utf-8")
    )
    signing_input = f"{header_b64}.{payload_b64}".encode("ascii")
    signature = hmac.new(
        secret.encode("utf-8"), signing_input, hashlib.sha256,
    ).digest()
    sig_b64 = _b64url_encode(signature)
    return f"{header_b64}.{payload_b64}.{sig_b64}"


def verify(token: str, secret: str) -> str:
    """Validate signature + expiry. Returns the user id (``sub``)."""
    try:
        header_b64, payload_b64, sig_b64 = token.split(".")
    except ValueError:
        raise JWTError("malformed token") from None

    signing_input = f"{header_b64}.{payload_b64}".encode("ascii")
    expected = hmac.new(
        secret.encode("utf-8"), signing_input, hashlib.sha256,
    ).digest()
    actual = _b64url_decode(sig_b64)
    if not hmac.compare_digest(expected, actual):
        raise JWTError("bad signature")

    try:
        payload = json.loads(_b64url_decode(payload_b64).decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise JWTError("invalid payload") from None

    exp = payload.get("exp")
    if not isinstance(exp, (int, float)) or exp < time.time():
        raise JWTError("expired")
    sub = payload.get("sub")
    if not isinstance(sub, str) or not sub:
        raise JWTError("missing sub")
    return sub
