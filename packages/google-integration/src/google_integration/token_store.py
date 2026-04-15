"""Encrypted OAuth token persistence for the Google integration.

Two implementations live in this package:

- :class:`FileTokenStore` (this module) — single-tenant, on-disk.
  Used by Seraphine (one user per box). Tokens live at
  ``settings.google_token_path`` (default
  ``~/.seraphine/google_tokens.enc``), encrypted with Fernet and keyed
  off the hostname.
- :class:`~google_integration.db_token_store.DBTokenStore` — multi-tenant,
  SQLite-backed. Used by Aura. Same encryption + key derivation; the
  ciphertext is stored per-user in a SQL row.

Both implement :class:`TokenStoreProtocol` so callers (``GoogleClient``,
``OAuthFlow``) can swap between them. ``TokenStore`` remains exported
as a back-compat alias for ``FileTokenStore``.

**Threat model (file store):** Light obfuscation, not real security.
"Another script on the same Mac shouldn't casually grep plaintext OAuth
tokens." A determined attacker with code exec on the box can trivially
recover the key — the hostname is public and the salt is in
``_crypto.py``. The dir is chmod 0700 and the token file chmod 0600
after every write.
"""

from __future__ import annotations

import asyncio
import json
import os
from datetime import datetime
from pathlib import Path
from typing import Protocol

from cryptography.fernet import Fernet, InvalidToken
from pydantic import BaseModel

from google_integration._crypto import derive_key


class TokenBundle(BaseModel):
    """OAuth token bundle persisted by a :class:`TokenStoreProtocol`."""

    access_token: str
    refresh_token: str
    expires_at: datetime
    scopes: list[str]


class TokenStoreProtocol(Protocol):
    """Contract every token store implementation honors.

    Async-first; callers should never block the event loop.
    """

    async def load(self) -> TokenBundle | None: ...
    async def save(self, bundle: TokenBundle) -> None: ...
    async def clear(self) -> None: ...


class FileTokenStore:
    """Persist OAuth tokens encrypted at rest under ``~/.seraphine/``.

    All methods are async so callers can stay in the event loop; the
    underlying file I/O is small (<1 KB) and synchronous, so we just
    run it inline instead of offloading to a thread.
    """

    def __init__(self, path: Path) -> None:
        self._path = Path(path)
        self._lock = asyncio.Lock()
        self._fernet = Fernet(derive_key())

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


# Back-compat alias — Seraphine and older call sites import ``TokenStore``.
TokenStore = FileTokenStore
