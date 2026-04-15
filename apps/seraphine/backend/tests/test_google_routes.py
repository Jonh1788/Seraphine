"""HTTP-level tests for the Google Workspace REST router.

Focus is on error mapping for Gmail write endpoints — specifically
``POST /google/gmail/messages/{id}/mark-read``, which previously
collapsed every upstream failure into a 502 and obscured missing-scope
issues.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable

import httpx
import pytest
from fastapi.testclient import TestClient

from google_integration.client import (
    GoogleAPIError,
    GoogleAuthError,
    GoogleClient,
)
from google_integration.token_store import TokenBundle, TokenStore
from seraphine.main import app


# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------


class _StubClient:
    """Minimal stand-in for :class:`GoogleClient` used by the router.

    Only the methods actually exercised by the tests are implemented;
    the others raise ``AssertionError`` if touched so the test surface
    stays small.
    """

    def __init__(
        self,
        *,
        mark_as_read: Callable[[str], Awaitable[dict]] | None = None,
    ) -> None:
        self._mark_as_read = mark_as_read

    async def mark_as_read(self, message_id: str) -> dict:
        assert self._mark_as_read is not None, "mark_as_read not stubbed"
        return await self._mark_as_read(message_id)


def _swap_client(stub: Any) -> Any:
    """Install ``stub`` on ``app.state.google_client`` and return the
    previous value so the caller can restore it in a ``finally``."""
    prev = getattr(app.state, "google_client", None)
    app.state.google_client = stub
    return prev


def _google_api_error_403_scope() -> GoogleAPIError:
    """Build a realistic 403 scope error as :class:`GoogleAPIError`."""
    body = (
        '{"error": {"code": 403, "message": "Insufficient Permission", '
        '"errors": [{"reason": "insufficientPermissions", '
        '"message": "Insufficient Permission"}]}}'
    )
    return GoogleAPIError(
        status_code=403,
        method="POST",
        url="https://gmail.googleapis.com/gmail/v1/users/me/messages/abc/modify",
        body=body,
        reason="insufficientPermissions",
    )


# ----------------------------------------------------------------------
# Tests — mark-read error surfacing
# ----------------------------------------------------------------------


def test_mark_read_403_insufficient_scope_surfaces_reauth_hint() -> None:
    async def _raise(_mid: str) -> dict:
        raise _google_api_error_403_scope()

    stub = _StubClient(mark_as_read=_raise)
    with TestClient(app) as client:
        prev = _swap_client(stub)
        try:
            resp = client.post("/google/gmail/messages/abc/mark-read")
            assert resp.status_code == 403, resp.text
            body = resp.json()
            assert "detail" in body
            detail = body["detail"]
            # PT-BR hint pointing to the re-auth flow, plus the Google
            # reason code for triage.
            assert "reconecte o Google" in detail
            assert "/google/oauth/start" in detail
            assert "insufficientPermissions" in detail
        finally:
            _swap_client(prev)


def test_mark_read_401_surfaces_as_401_via_google_auth_error() -> None:
    async def _raise(_mid: str) -> dict:
        raise GoogleAuthError("no google credentials on file")

    stub = _StubClient(mark_as_read=_raise)
    with TestClient(app) as client:
        prev = _swap_client(stub)
        try:
            resp = client.post("/google/gmail/messages/abc/mark-read")
            assert resp.status_code == 401, resp.text
            body = resp.json()
            assert body.get("detail") == "no google credentials on file"
        finally:
            _swap_client(prev)


def test_mark_read_503_when_client_unconfigured() -> None:
    with TestClient(app) as client:
        prev = _swap_client(None)
        try:
            resp = client.post("/google/gmail/messages/abc/mark-read")
            assert resp.status_code == 503, resp.text
        finally:
            _swap_client(prev)


def test_mark_read_success_returns_ok_true() -> None:
    calls: list[str] = []

    async def _ok(mid: str) -> dict:
        calls.append(mid)
        return {"id": mid, "labelIds": []}

    stub = _StubClient(mark_as_read=_ok)
    with TestClient(app) as client:
        prev = _swap_client(stub)
        try:
            resp = client.post("/google/gmail/messages/xyz/mark-read")
            assert resp.status_code == 200, resp.text
            assert resp.json() == {"ok": True}
            assert calls == ["xyz"]
        finally:
            _swap_client(prev)


# ----------------------------------------------------------------------
# Tests — GoogleClient raises GoogleAPIError from upstream 403
# ----------------------------------------------------------------------


def _patch_httpx(monkeypatch: pytest.MonkeyPatch, handler) -> None:
    real_ac = httpx.AsyncClient

    def patched_ac(*args, **kwargs):  # type: ignore[no-untyped-def]
        kwargs["transport"] = httpx.MockTransport(handler)
        return real_ac(*args, **kwargs)

    monkeypatch.setattr("google_integration.client.httpx.AsyncClient", patched_ac)


async def test_client_raises_google_api_error_with_reason_on_403(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = TokenStore(tmp_path / "tokens.enc")
    await store.save(
        TokenBundle(
            access_token="live",
            refresh_token="rt",
            expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
            scopes=[],
        )
    )
    google = GoogleClient(
        token_store=store, client_id="cid", client_secret="sec", scopes=[]
    )

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert "/messages/abc/modify" in str(request.url)
        return httpx.Response(
            403,
            json={
                "error": {
                    "code": 403,
                    "message": "Insufficient Permission",
                    "errors": [
                        {
                            "reason": "insufficientPermissions",
                            "message": "Insufficient Permission",
                        }
                    ],
                }
            },
        )

    _patch_httpx(monkeypatch, handler)

    with pytest.raises(GoogleAPIError) as excinfo:
        await google.mark_as_read("abc")
    err = excinfo.value
    assert err.status_code == 403
    assert err.reason == "insufficientPermissions"
