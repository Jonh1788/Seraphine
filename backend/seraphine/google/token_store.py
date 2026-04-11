"""Encrypted OAuth token persistence for the Google integration.

Tokens live at ``settings.google_token_path`` (default
``~/.seraphine/google_tokens.enc``). We encrypt the JSON payload with
``cryptography.fernet.Fernet``, deriving the key via PBKDF2HMAC from a
fixed salt combined with ``socket.gethostname()``.

**This is light obfuscation, not real security.** The threat model is
"another script on the same Mac shouldn't casually grep plaintext
OAuth tokens". A determined attacker with code exec on the box can
trivially recover the key — the hostname is public and the salt is in
this file.

The dir is chmod 0700 and the token file chmod 0600 after every write.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import socket
from datetime import datetime
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from pydantic import BaseModel


# Fixed salt — this is intentional, see module docstring for the
# threat model. Changing this value invalidates every existing token
# file (users will have to re-auth).
_FIXED_SALT = b"seraphine.google.v1.salt.\x12\x34\x56\x78"
_PBKDF2_ITERS = 200_000


class TokenBundle(BaseModel):
    """OAuth token bundle persisted by :class:`TokenStore`."""

    access_token: str
    refresh_token: str
    expires_at: datetime
    scopes: list[str]


def _derive_key() -> bytes:
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


class TokenStore:
    """Persist OAuth tokens encrypted at rest under ``~/.seraphine/``.

    All methods are async so callers can stay in the event loop; the
    underlying file I/O is small (<1 KB) and synchronous, so we just
    run it inline instead of offloading to a thread.
    """

    def __init__(self, path: Path) -> None:
        self._path = Path(path)
        self._lock = asyncio.Lock()
        self._fernet = Fernet(_derive_key())

    @property
    def path(self) -> Path:
        return self._path

    def _ensure_dir(self) -> None:
        parent = self._path.parent
        parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        # If it already existed with looser perms, tighten it.
        try:
            os.chmod(parent, 0o700)
        except OSError:
            pass

    async def load(self) -> TokenBundle | None:
        async with self._lock:
            if not self._path.exists():
                return None
            try:
                raw = self._path.read_bytes()
            except OSError:
                return None
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
        async with self._lock:
            self._ensure_dir()
            payload = bundle.model_dump(mode="json")
            plaintext = json.dumps(payload, separators=(",", ":")).encode("utf-8")
            ciphertext = self._fernet.encrypt(plaintext)
            # Write atomically: write to tmp, chmod, rename.
            tmp = self._path.with_suffix(self._path.suffix + ".tmp")
            tmp.write_bytes(ciphertext)
            try:
                os.chmod(tmp, 0o600)
            except OSError:
                pass
            os.replace(tmp, self._path)
            try:
                os.chmod(self._path, 0o600)
            except OSError:
                pass

    async def clear(self) -> None:
        async with self._lock:
            try:
                self._path.unlink()
            except FileNotFoundError:
                pass
