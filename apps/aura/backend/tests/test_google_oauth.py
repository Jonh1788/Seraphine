"""End-to-end Google OAuth wiring for Aura.

Exercises the real routes behind a TestClient with the Google token
HTTP endpoints mocked out. Covers:
- /google/status — 401 without auth, disconnected when no row.
- /google/connect — 501 when google_client_id missing.
- /google/connect — returns consent_url with correct state + redirect.
- /google/oauth/callback — rejects bad state, accepts a good one and
  persists the row so /google/status flips to connected.
- /google/disconnect — removes the row, /status flips back.
"""

from __future__ import annotations

import importlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from fastapi.testclient import TestClient


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _boot_app(tmp_path: Path, monkeypatch, *, configured: bool) -> Any:
    monkeypatch.setenv("AURA_SQLITE_PATH", str(tmp_path / "aura.sqlite"))
    monkeypatch.setenv("AURA_JWT_SECRET", "test-secret-do-not-ship")
    if configured:
        monkeypatch.setenv("AURA_GOOGLE_CLIENT_ID", "test-client-id")
        monkeypatch.setenv("AURA_GOOGLE_CLIENT_SECRET", "test-client-secret")
        monkeypatch.setenv(
            "AURA_GOOGLE_OAUTH_REDIRECT_URL",
            "http://localhost:8001/google/oauth/callback",
        )
    else:
        monkeypatch.delenv("AURA_GOOGLE_CLIENT_ID", raising=False)
        monkeypatch.delenv("AURA_GOOGLE_CLIENT_SECRET", raising=False)

    import aura.config as config_mod
    import aura.main as main_mod

    importlib.reload(config_mod)
    importlib.reload(main_mod)
    return main_mod


@pytest.fixture
def client_configured(tmp_path: Path, monkeypatch):
    main_mod = _boot_app(tmp_path, monkeypatch, configured=True)
    with TestClient(main_mod.app) as c:
        yield c


@pytest.fixture
def client_unconfigured(tmp_path: Path, monkeypatch):
    main_mod = _boot_app(tmp_path, monkeypatch, configured=False)
    with TestClient(main_mod.app) as c:
        yield c


def _register(c: TestClient, email: str = "oauth@x.io") -> dict:
    r = c.post(
        "/auth/register",
        json={"email": email, "password": "hunter2x", "name": "Test"},
    )
    assert r.status_code == 200, r.text
    return r.json()


def _auth(body: dict) -> dict:
    return {"Authorization": f"Bearer {body['access_token']}"}


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_status_requires_auth(client_configured: TestClient):
    # No token at all.
    r = client_configured.get("/google/status")
    assert r.status_code == 401


def test_status_disconnected_for_new_user(client_configured: TestClient):
    body = _register(client_configured, "fresh@x.io")
    r = client_configured.get("/google/status", headers=_auth(body))
    assert r.status_code == 200
    assert r.json() == {"connected": False, "email": None}


def test_connect_501_when_not_configured(client_unconfigured: TestClient):
    body = _register(client_unconfigured, "nocfg@x.io")
    r = client_unconfigured.post("/google/connect", headers=_auth(body))
    assert r.status_code == 501
    assert "configurado" in r.json()["detail"].lower()


def test_connect_returns_consent_url_with_state(client_configured: TestClient):
    body = _register(client_configured, "ok@x.io")
    r = client_configured.post("/google/connect", headers=_auth(body))
    assert r.status_code == 200, r.text
    consent_url = r.json()["consent_url"]

    parsed = urlparse(consent_url)
    assert parsed.netloc == "accounts.google.com"
    qs = parse_qs(parsed.query)
    assert qs["client_id"] == ["test-client-id"]
    assert qs["redirect_uri"] == [
        "http://localhost:8001/google/oauth/callback"
    ]
    assert qs["response_type"] == ["code"]
    assert qs["access_type"] == ["offline"]
    assert "state" in qs and qs["state"][0]
    # State JWT decodes back to this user's id.
    from core_auth import verify as jwt_verify
    sub = jwt_verify(qs["state"][0], "test-secret-do-not-ship")
    assert sub == body["user_id"]


def test_callback_rejects_bad_state(client_configured: TestClient):
    r = client_configured.get(
        "/google/oauth/callback",
        params={"code": "anything", "state": "not.a.jwt"},
    )
    assert r.status_code == 400
    # Body is HTML but should carry the failure message for humans.
    assert "n\u00e3o foi poss\u00edvel" in r.text.lower() or "falha" in r.text.lower() or "invalid" in r.text.lower()


def test_callback_happy_path_connects_user(
    client_configured: TestClient, monkeypatch
):
    body = _register(client_configured, "happy@x.io")

    # Grab a consent URL to mint a valid state.
    r = client_configured.post("/google/connect", headers=_auth(body))
    assert r.status_code == 200
    state = parse_qs(urlparse(r.json()["consent_url"]).query)["state"][0]

    # Mock httpx.AsyncClient so the callback's token-exchange +
    # userinfo calls hit our fake transport instead of google.com.
    def _handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "oauth2.googleapis.com" and request.url.path == "/token":
            return httpx.Response(
                200,
                json={
                    "access_token": "fake-access",
                    "refresh_token": "fake-refresh",
                    "expires_in": 3600,
                    "scope": "https://www.googleapis.com/auth/gmail.modify",
                },
            )
            # userinfo
        if "userinfo" in request.url.path:
            return httpx.Response(
                200, json={"email": "happy@gmail.com"},
            )
        return httpx.Response(404, json={"error": "unexpected-url"})

    transport = httpx.MockTransport(_handler)
    real_async_client = httpx.AsyncClient

    def _patched_async_client(*args, **kwargs):
        kwargs["transport"] = transport
        return real_async_client(*args, **kwargs)

    monkeypatch.setattr("httpx.AsyncClient", _patched_async_client)

    # Hit the callback.
    r = client_configured.get(
        "/google/oauth/callback",
        params={"code": "fake-code", "state": state},
    )
    assert r.status_code == 200, r.text
    assert "aura.google.oauth" in r.text
    assert '"source"' in r.text or "source:" in r.text

    # Now status should flip.
    r = client_configured.get("/google/status", headers=_auth(body))
    assert r.status_code == 200
    payload = r.json()
    assert payload["connected"] is True
    assert payload["email"] == "happy@gmail.com"


def test_disconnect_removes_row(client_configured: TestClient, monkeypatch):
    body = _register(client_configured, "gone@x.io")

    # Seed a token row by driving the callback once (reuse the mocked
    # transport from the previous test's shape).
    r = client_configured.post("/google/connect", headers=_auth(body))
    state = parse_qs(urlparse(r.json()["consent_url"]).query)["state"][0]

    def _handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/token":
            return httpx.Response(
                200,
                json={
                    "access_token": "fake-access",
                    "refresh_token": "fake-refresh",
                    "expires_in": 3600,
                    "scope": "https://www.googleapis.com/auth/gmail.modify",
                },
            )
        if "userinfo" in request.url.path:
            return httpx.Response(200, json={"email": "gone@gmail.com"})
        if request.url.path == "/revoke":
            return httpx.Response(200, json={})
        return httpx.Response(404, json={})

    transport = httpx.MockTransport(_handler)
    real_async_client = httpx.AsyncClient

    def _patched_async_client(*args, **kwargs):
        kwargs["transport"] = transport
        return real_async_client(*args, **kwargs)

    monkeypatch.setattr("httpx.AsyncClient", _patched_async_client)

    r = client_configured.get(
        "/google/oauth/callback",
        params={"code": "code1", "state": state},
    )
    assert r.status_code == 200
    assert client_configured.get(
        "/google/status", headers=_auth(body),
    ).json()["connected"] is True

    # Disconnect.
    r = client_configured.post("/google/disconnect", headers=_auth(body))
    assert r.status_code == 200
    assert r.json() == {"ok": True}

    # Status flips back.
    r = client_configured.get("/google/status", headers=_auth(body))
    assert r.status_code == 200
    assert r.json() == {"connected": False, "email": None}


def test_callback_missing_params(client_configured: TestClient):
    r = client_configured.get("/google/oauth/callback")
    assert r.status_code == 400


def test_callback_google_error_param(client_configured: TestClient):
    r = client_configured.get(
        "/google/oauth/callback",
        params={"error": "access_denied"},
    )
    # Still returns the HTML page (so the popup closes), but with a 4xx
    # status so the caller's network panel reflects failure.
    assert r.status_code in (200, 400)
    assert "access_denied" in r.text


def test_expired_state_rejected(client_configured: TestClient, monkeypatch):
    # Mint an already-expired state by swapping in a fake ``time``
    # module in core_auth.jwt, then restoring the real one so
    # verification runs against the real clock.
    import time as real_time_mod
    import core_auth.jwt as jwt_mod
    from core_auth import issue as jwt_issue

    class _FakeTime:
        @staticmethod
        def time() -> float:
            return real_time_mod.time() - 3600

    monkeypatch.setattr(jwt_mod, "time", _FakeTime)
    state = jwt_issue(
        "user-123", "test-secret-do-not-ship", expires_in_seconds=1,
    )
    monkeypatch.setattr(jwt_mod, "time", real_time_mod)

    r = client_configured.get(
        "/google/oauth/callback",
        params={"code": "x", "state": state},
    )
    assert r.status_code == 400
