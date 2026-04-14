from __future__ import annotations

import time

import pytest

from core_auth import (
    JWTError,
    hash_password,
    issue,
    needs_rehash,
    verify,
    verify_password,
)


def test_password_roundtrip():
    h = hash_password("hunter2")
    assert verify_password(h, "hunter2")
    assert not verify_password(h, "hunter3")
    assert not needs_rehash(h)


def test_jwt_roundtrip():
    secret = "test-secret"
    token = issue("user-42", secret, expires_in_seconds=60)
    assert verify(token, secret) == "user-42"


def test_jwt_bad_signature():
    secret = "secret"
    token = issue("u1", secret)
    with pytest.raises(JWTError):
        verify(token, "wrong-secret")


def test_jwt_expired():
    secret = "secret"
    token = issue("u1", secret, expires_in_seconds=-1)
    # Allow clock to ensure exp < now.
    time.sleep(0.01)
    with pytest.raises(JWTError):
        verify(token, secret)


def test_jwt_malformed():
    with pytest.raises(JWTError):
        verify("not.a.jwt.really", "secret")
    with pytest.raises(JWTError):
        verify("only-one-part", "secret")
