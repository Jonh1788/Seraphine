"""Argon2id password hashing.

Aura's only auth path. Seraphine doesn't store passwords (single user),
so this module is unused there but importable cheaply (argon2-cffi is
~50KB native + a few KB Python).
"""

from __future__ import annotations

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

_HASHER = PasswordHasher()


def hash_password(plaintext: str) -> str:
    return _HASHER.hash(plaintext)


def verify_password(hashed: str, plaintext: str) -> bool:
    try:
        _HASHER.verify(hashed, plaintext)
        return True
    except VerifyMismatchError:
        return False
    except Exception:
        return False


def needs_rehash(hashed: str) -> bool:
    """True when the stored hash uses outdated parameters and should
    be replaced on next successful login."""
    return _HASHER.check_needs_rehash(hashed)
