from datetime import UTC, datetime, timedelta

import pytest

from aura.alexa.signature import (
    InvalidSignatureError,
    is_valid_cert_url,
    is_timestamp_fresh,
)


@pytest.mark.parametrize("url", [
    "https://s3.amazonaws.com/echo.api/echo-api-cert-12.pem",
    "https://s3.amazonaws.com:443/echo.api/cert.pem",
    "https://s3.amazonaws.com/echo.api/../echo.api/cert.pem",  # normalized OK
])
def test_cert_url_allowed(url):
    assert is_valid_cert_url(url) is True


@pytest.mark.parametrize("url", [
    "http://s3.amazonaws.com/echo.api/cert.pem",          # not https
    "https://evil.com/echo.api/cert.pem",                  # wrong host
    "https://s3.amazonaws.com:8443/echo.api/cert.pem",     # wrong port
    "https://s3.amazonaws.com/EVIL/echo-api/cert.pem",     # wrong path prefix
    "not-a-url",
])
def test_cert_url_rejected(url):
    assert is_valid_cert_url(url) is False


def test_timestamp_fresh_within_window():
    now = datetime.now(UTC)
    ts = now.isoformat().replace("+00:00", "Z")
    assert is_timestamp_fresh(ts, now=now) is True


def test_timestamp_too_old():
    now = datetime.now(UTC)
    old = (now - timedelta(seconds=200)).isoformat().replace("+00:00", "Z")
    assert is_timestamp_fresh(old, now=now) is False


def test_timestamp_too_future():
    now = datetime.now(UTC)
    future = (now + timedelta(seconds=200)).isoformat().replace("+00:00", "Z")
    assert is_timestamp_fresh(future, now=now) is False


def test_verify_signature_rejects_bad_url():
    from aura.alexa.signature import verify_signature
    with pytest.raises(InvalidSignatureError, match="cert url"):
        verify_signature(
            body=b"{}",
            signature_b64="ZmFrZQ==",
            cert_chain_url="https://evil.com/cert.pem",
        )
