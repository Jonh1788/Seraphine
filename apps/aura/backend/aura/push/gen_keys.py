"""One-shot CLI to generate a stable VAPID keypair for prod.

Usage:
    uv run python -m aura.push.gen_keys

Copy the output into your .env.prod under
    AURA_VAPID_PRIVATE_PEM='...'
    AURA_VAPID_PUBLIC_B64='...'
"""

from __future__ import annotations

import base64

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec


def main() -> None:
    priv = ec.generate_private_key(ec.SECP256R1())
    # TraditionalOpenSSL = SEC1 for EC keys (BEGIN EC PRIVATE KEY).
    # py_vapid requires this format; PKCS8 fails with ASN.1 parse error.
    pem = priv.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.TraditionalOpenSSL,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("ascii")
    pub = priv.public_key()
    raw = pub.public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.UncompressedPoint,
    )
    pub_b64 = base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")

    print("# Add to apps/aura/.env.prod (or .env for dev):")
    print()
    print("AURA_VAPID_PUBLIC_B64=" + pub_b64)
    print()
    print("AURA_VAPID_PRIVATE_PEM='" + pem.replace("\n", "\\n") + "'")
    print()
    print("# Or write the PEM as multi-line via an env loader that supports it.")


if __name__ == "__main__":
    main()
