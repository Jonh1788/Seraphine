"""Amazon Alexa request signature validation.

Per the Alexa Skills Kit docs, every request to the skill endpoint carries:
  - ``Signature-256`` header — base64 RSA-SHA256 over the raw body.
  - ``SignatureCertChainUrl`` header — URL to the signing cert chain in
    Amazon's S3 bucket.

This module validates the URL allowlist, fetches and caches the cert chain,
checks ``echo-api.amazon.com`` is in the SAN, and verifies the RSA signature
over the raw body bytes. Also exposes ``is_timestamp_fresh`` for the
150-second freshness window.
"""

from __future__ import annotations

import base64
import logging
import posixpath
from datetime import UTC, datetime, timedelta
from threading import Lock
from urllib.parse import urlparse

import httpx
from cryptography import x509
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.x509.oid import ExtensionOID

logger = logging.getLogger(__name__)

TIMESTAMP_TOLERANCE = timedelta(seconds=150)
_CERT_CACHE: dict[str, list[x509.Certificate]] = {}
_CERT_CACHE_LOCK = Lock()


class InvalidSignatureError(Exception):
    """Raised when any step of signature validation fails."""


def is_valid_cert_url(url: str) -> bool:
    """Match the Amazon-published rules for the cert chain URL."""
    try:
        p = urlparse(url)
    except Exception:
        return False
    if p.scheme != "https":
        return False
    if p.hostname != "s3.amazonaws.com":
        return False
    if p.port not in (None, 443):
        return False
    # Normalized path must start with /echo.api/
    norm = posixpath.normpath(p.path)
    if not norm.startswith("/echo.api/"):
        return False
    return True


def is_timestamp_fresh(iso_timestamp: str, *, now: datetime | None = None) -> bool:
    try:
        ts = datetime.fromisoformat(iso_timestamp.replace("Z", "+00:00"))
    except ValueError:
        return False
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=UTC)
    cur = now or datetime.now(UTC)
    return abs(cur - ts) <= TIMESTAMP_TOLERANCE


def _fetch_cert_chain(url: str) -> list[x509.Certificate]:
    with _CERT_CACHE_LOCK:
        cached = _CERT_CACHE.get(url)
        if cached is not None:
            return cached
    with httpx.Client(timeout=5.0) as client:
        r = client.get(url)
        r.raise_for_status()
        pem = r.content
    certs: list[x509.Certificate] = []
    # PEM may concatenate multiple certs.
    sep = b"-----END CERTIFICATE-----"
    for chunk in pem.split(sep):
        chunk = chunk.strip()
        if not chunk:
            continue
        certs.append(x509.load_pem_x509_certificate(chunk + b"\n" + sep))
    with _CERT_CACHE_LOCK:
        _CERT_CACHE[url] = certs
    return certs


def verify_signature(
    *,
    body: bytes,
    signature_b64: str,
    cert_chain_url: str,
) -> None:
    """Raise ``InvalidSignatureError`` if signature verification fails."""
    if not is_valid_cert_url(cert_chain_url):
        raise InvalidSignatureError(f"cert url not allowed: {cert_chain_url!r}")

    try:
        certs = _fetch_cert_chain(cert_chain_url)
    except Exception as e:
        raise InvalidSignatureError(f"could not fetch cert chain: {e}") from e

    if not certs:
        raise InvalidSignatureError("empty cert chain")

    leaf = certs[0]

    # SAN must include echo-api.amazon.com.
    try:
        san_ext = leaf.extensions.get_extension_for_oid(
            ExtensionOID.SUBJECT_ALTERNATIVE_NAME
        )
        sans = san_ext.value.get_values_for_type(x509.DNSName)
    except x509.ExtensionNotFound:
        sans = []
    if "echo-api.amazon.com" not in sans:
        raise InvalidSignatureError("SAN missing echo-api.amazon.com")

    # Cert not expired.
    now = datetime.now(UTC)
    if not (leaf.not_valid_before_utc <= now <= leaf.not_valid_after_utc):
        raise InvalidSignatureError("leaf cert expired")

    public_key = leaf.public_key()
    try:
        signature = base64.b64decode(signature_b64, validate=True)
    except Exception as e:
        raise InvalidSignatureError(f"signature not base64: {e}") from e

    try:
        public_key.verify(
            signature,
            body,
            padding.PKCS1v15(),
            hashes.SHA256(),
        )
    except InvalidSignature as e:
        raise InvalidSignatureError("rsa verify failed") from e
