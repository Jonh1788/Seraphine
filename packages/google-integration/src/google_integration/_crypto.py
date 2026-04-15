"""Shared crypto primitives for OAuth token storage.

Both :mod:`google_integration.token_store` (file-backed, Seraphine) and
:mod:`google_integration.db_token_store` (SQLite-backed, Aura) derive
their Fernet key the same way: PBKDF2HMAC over the machine hostname
with a fixed salt. See the file-backed store's module docstring for the
(intentionally modest) threat model.
"""

from __future__ import annotations

import base64
import socket

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC


# Fixed salt — changing this invalidates every existing encrypted token.
_FIXED_SALT = b"seraphine.google.v1.salt.\x12\x34\x56\x78"
_PBKDF2_ITERS = 200_000


def derive_key() -> bytes:
    """Derive a Fernet key from the machine hostname + fixed salt."""
    hostname = socket.gethostname().encode("utf-8")
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=_FIXED_SALT,
        iterations=_PBKDF2_ITERS,
    )
    raw = kdf.derive(hostname)
    return base64.urlsafe_b64encode(raw)
