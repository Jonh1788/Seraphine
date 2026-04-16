"""Read Claude Max/Pro OAuth tokens from Claude Code storage.

Claude Code stores its OAuth credentials in two places depending on
the platform:

- **macOS**: Keychain entry ``Claude Code-credentials`` (access via the
  ``security`` CLI).
- **Linux**: plain JSON file at ``~/.claude/.credentials.json``.

Both storages wrap the same payload: a JSON dict with a
``claudeAiOauth`` key containing ``accessToken``, ``refreshToken``,
``expiresAt`` (Unix ms), ``subscriptionType``, and ``rateLimitTier``.

We read the access token and pass it as ``x-api-key`` to the standard
Anthropic Messages API — the server accepts ``sk-ant-oat01-*`` tokens
the same way it accepts ``sk-ant-api03-*`` API keys, but routes billing
to the user's subscription and applies the Max tier rate limits (20×).
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import time

logger = logging.getLogger("seraphine.llm.keychain")

_KEYCHAIN_SERVICE = "Claude Code-credentials"
_LINUX_CREDENTIALS_PATH = os.path.expanduser("~/.claude/.credentials.json")


class KeychainError(Exception):
    pass


def _read_oauth_macos() -> dict:
    try:
        result = subprocess.run(
            ["security", "find-generic-password", "-s", _KEYCHAIN_SERVICE, "-w"],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except FileNotFoundError:
        raise KeychainError(
            "macOS `security` binary not found — are you on macOS?"
        )
    except subprocess.TimeoutExpired:
        raise KeychainError("Keychain read timed out")

    if result.returncode != 0:
        raise KeychainError(
            f"Keychain entry '{_KEYCHAIN_SERVICE}' not found. "
            f"Is Claude Code installed and logged in? "
            f"(security stderr: {result.stderr.strip()})"
        )

    try:
        return json.loads(result.stdout.strip())
    except (json.JSONDecodeError, ValueError) as e:
        raise KeychainError(f"Keychain entry is not valid JSON: {e}")


def _read_oauth_linux() -> dict:
    try:
        with open(_LINUX_CREDENTIALS_PATH, "r", encoding="utf-8") as f:
            raw = f.read()
    except FileNotFoundError:
        raise KeychainError(
            f"Claude credentials not found at {_LINUX_CREDENTIALS_PATH}. "
            f"Install Claude Code on this host and run `claude` once to log in."
        )
    except PermissionError as e:
        raise KeychainError(
            f"No permission to read {_LINUX_CREDENTIALS_PATH}: {e}. "
            f"Ensure the file is owned by the current user (0600)."
        )
    try:
        return json.loads(raw.strip())
    except (json.JSONDecodeError, ValueError) as e:
        raise KeychainError(
            f"{_LINUX_CREDENTIALS_PATH} is not valid JSON: {e}"
        )


def read_claude_oauth() -> dict:
    """Read the full OAuth dict from the platform's credential store.

    Returns a dict with keys: accessToken, refreshToken, expiresAt,
    scopes, subscriptionType, rateLimitTier.

    Raises KeychainError if the entry doesn't exist or can't be parsed.
    """
    if sys.platform == "darwin":
        outer = _read_oauth_macos()
    else:
        outer = _read_oauth_linux()

    oauth = outer.get("claudeAiOauth")
    if not isinstance(oauth, dict):
        raise KeychainError(
            "Credentials payload missing 'claudeAiOauth' dict — "
            "Claude Code may need to be re-authenticated"
        )
    return oauth


def get_access_token() -> str:
    """Return the current OAuth access token, or raise KeychainError.

    Checks expiry and warns (but still returns the token) if it's within
    5 minutes of expiring — Claude Code's background refresh usually
    keeps it fresh, but if the CLI hasn't run in a while it may be stale.
    """
    oauth = read_claude_oauth()
    token = oauth.get("accessToken", "")
    if not token:
        raise KeychainError("accessToken is empty in Keychain")

    expires_at_ms = oauth.get("expiresAt", 0)
    if expires_at_ms:
        now_ms = int(time.time() * 1000)
        remaining_s = (expires_at_ms - now_ms) / 1000
        if remaining_s < 0:
            logger.warning(
                "Claude Max OAuth token expired %.0f seconds ago — "
                "run `claude` once to refresh it",
                -remaining_s,
            )
        elif remaining_s < 300:
            logger.warning(
                "Claude Max OAuth token expires in %.0f seconds — "
                "run `claude` to refresh",
                remaining_s,
            )

    return token


def get_subscription_info() -> dict:
    """Return subscription metadata for display in bootstrap."""
    try:
        oauth = read_claude_oauth()
        return {
            "subscription_type": oauth.get("subscriptionType", "unknown"),
            "rate_limit_tier": oauth.get("rateLimitTier", "unknown"),
            "expires_at_ms": oauth.get("expiresAt", 0),
            "has_token": bool(oauth.get("accessToken")),
        }
    except KeychainError:
        return {
            "subscription_type": "unknown",
            "rate_limit_tier": "unknown",
            "expires_at_ms": 0,
            "has_token": False,
        }
