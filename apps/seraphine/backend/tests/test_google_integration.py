from __future__ import annotations

import base64
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx
import pytest

from google_integration.client import (
    GoogleAuthError,
    GoogleClient,
    _decode_full_message,
    _summarize_message,
)
from google_integration.token_store import TokenBundle, TokenStore
from seraphine.tools.google import (
    CalendarCreateEventTool,
    CalendarDeleteEventTool,
    CalendarUpdateEventTool,
    GmailSendMessageTool,
)


# ----------------------------------------------------------------------
# TokenStore
# ----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_token_store_encrypts_and_decrypts_roundtrip(tmp_path: Path) -> None:
    path = tmp_path / "subdir" / "tokens.enc"
    store = TokenStore(path)

    bundle = TokenBundle(
        access_token="at-123",
        refresh_token="rt-abc",
        expires_at=datetime(2030, 1, 1, 12, 0, 0, tzinfo=timezone.utc),
        scopes=["https://www.googleapis.com/auth/calendar.readonly"],
    )

    await store.save(bundle)

    # File must exist and not contain the plaintext access token.
    assert path.exists()
    raw = path.read_bytes()
    assert b"at-123" not in raw
    assert b"rt-abc" not in raw

    loaded = await store.load()
    assert loaded is not None
    assert loaded.access_token == "at-123"
    assert loaded.refresh_token == "rt-abc"
    assert loaded.expires_at == bundle.expires_at
    assert loaded.scopes == bundle.scopes


@pytest.mark.asyncio
async def test_token_store_load_missing_returns_none(tmp_path: Path) -> None:
    store = TokenStore(tmp_path / "nope.enc")
    assert await store.load() is None


@pytest.mark.asyncio
async def test_token_store_clear(tmp_path: Path) -> None:
    path = tmp_path / "tokens.enc"
    store = TokenStore(path)
    await store.save(
        TokenBundle(
            access_token="x",
            refresh_token="y",
            expires_at=datetime.now(timezone.utc),
            scopes=[],
        )
    )
    assert path.exists()
    await store.clear()
    assert not path.exists()
    # Clearing a nonexistent file is a no-op.
    await store.clear()


# ----------------------------------------------------------------------
# GoogleClient.is_authed
# ----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_google_client_is_authed_false_when_empty(tmp_path: Path) -> None:
    store = TokenStore(tmp_path / "tokens.enc")
    client = GoogleClient(
        token_store=store,
        client_id="cid",
        client_secret="sec",
        scopes=[],
    )
    assert await client.is_authed() is False


@pytest.mark.asyncio
async def test_google_client_is_authed_true_when_live_token(tmp_path: Path) -> None:
    store = TokenStore(tmp_path / "tokens.enc")
    await store.save(
        TokenBundle(
            access_token="live",
            refresh_token="rt",
            expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
            scopes=["scope-a"],
        )
    )
    client = GoogleClient(
        token_store=store, client_id="cid", client_secret="sec", scopes=[]
    )
    assert await client.is_authed() is True


@pytest.mark.asyncio
async def test_google_client_is_authed_true_when_expired_but_refreshable(
    tmp_path: Path,
) -> None:
    store = TokenStore(tmp_path / "tokens.enc")
    await store.save(
        TokenBundle(
            access_token="stale",
            refresh_token="rt",
            expires_at=datetime.now(timezone.utc) - timedelta(hours=1),
            scopes=["scope-a"],
        )
    )
    client = GoogleClient(
        token_store=store, client_id="cid", client_secret="sec", scopes=[]
    )
    assert await client.is_authed() is True


@pytest.mark.asyncio
async def test_google_client_is_authed_false_when_expired_and_no_refresh(
    tmp_path: Path,
) -> None:
    store = TokenStore(tmp_path / "tokens.enc")
    await store.save(
        TokenBundle(
            access_token="stale",
            refresh_token="",
            expires_at=datetime.now(timezone.utc) - timedelta(hours=1),
            scopes=[],
        )
    )
    client = GoogleClient(
        token_store=store, client_id="cid", client_secret="sec", scopes=[]
    )
    assert await client.is_authed() is False


# ----------------------------------------------------------------------
# GoogleClient API calls via MockTransport
# ----------------------------------------------------------------------


def _patch_httpx(monkeypatch, handler) -> None:
    real_ac = httpx.AsyncClient

    def patched_ac(*args, **kwargs):  # type: ignore[no-untyped-def]
        kwargs["transport"] = httpx.MockTransport(handler)
        return real_ac(*args, **kwargs)

    monkeypatch.setattr("google_integration.client.httpx.AsyncClient", patched_ac)


@pytest.mark.asyncio
async def test_list_events_parses_response(tmp_path: Path, monkeypatch) -> None:
    store = TokenStore(tmp_path / "tokens.enc")
    await store.save(
        TokenBundle(
            access_token="live",
            refresh_token="rt",
            expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
            scopes=[],
        )
    )
    client = GoogleClient(
        token_store=store, client_id="cid", client_secret="sec", scopes=[]
    )

    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["auth"] = request.headers.get("authorization")
        return httpx.Response(
            200,
            json={
                "items": [
                    {
                        "id": "e1",
                        "summary": "Reunião X",
                        "start": {"dateTime": "2026-04-12T15:00:00-03:00"},
                        "end": {"dateTime": "2026-04-12T16:00:00-03:00"},
                    }
                ]
            },
        )

    _patch_httpx(monkeypatch, handler)

    events = await client.list_events(
        time_min=datetime(2026, 4, 11, tzinfo=timezone.utc),
        time_max=datetime(2026, 4, 13, tzinfo=timezone.utc),
        max_results=5,
    )
    assert len(events) == 1
    assert events[0]["id"] == "e1"
    assert "calendars/primary/events" in captured["url"]
    assert "timeMin=" in captured["url"]
    assert captured["auth"] == "Bearer live"


@pytest.mark.asyncio
async def test_list_messages_fetches_headers_in_parallel(
    tmp_path: Path, monkeypatch
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
    client = GoogleClient(
        token_store=store, client_id="cid", client_secret="sec", scopes=[]
    )

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.endswith("/messages") or "/messages?" in url:
            return httpx.Response(
                200,
                json={"messages": [{"id": "m1"}, {"id": "m2"}]},
            )
        if url.rstrip("/").endswith("/messages/m1") or "/messages/m1?" in url:
            return httpx.Response(
                200,
                json={
                    "id": "m1",
                    "threadId": "t1",
                    "snippet": "Hi!",
                    "labelIds": ["UNREAD", "IMPORTANT"],
                    "payload": {
                        "headers": [
                            {"name": "Subject", "value": "Hello"},
                            {"name": "From", "value": "bob@example.com"},
                            {"name": "Date", "value": "Sat, 11 Apr 2026 10:00:00 +0000"},
                        ]
                    },
                },
            )
        if url.rstrip("/").endswith("/messages/m2") or "/messages/m2?" in url:
            return httpx.Response(
                200,
                json={
                    "id": "m2",
                    "threadId": "t2",
                    "snippet": "Yo!",
                    "labelIds": ["UNREAD"],
                    "payload": {
                        "headers": [
                            {"name": "Subject", "value": "World"},
                            {"name": "From", "value": "alice@example.com"},
                            {"name": "Date", "value": "Sat, 11 Apr 2026 11:00:00 +0000"},
                        ]
                    },
                },
            )
        return httpx.Response(404)

    _patch_httpx(monkeypatch, handler)

    msgs = await client.list_messages(q="is:important", max_results=5)
    assert len(msgs) == 2
    by_id = {m["id"]: m for m in msgs}
    assert by_id["m1"]["subject"] == "Hello"
    assert by_id["m1"]["from"] == "bob@example.com"
    assert by_id["m1"]["isUnread"] is True
    assert by_id["m1"]["isImportant"] is True
    assert by_id["m2"]["isImportant"] is False


@pytest.mark.asyncio
async def test_authed_request_retries_once_on_401(
    tmp_path: Path, monkeypatch
) -> None:
    store = TokenStore(tmp_path / "tokens.enc")
    await store.save(
        TokenBundle(
            access_token="stale",
            refresh_token="rt-live",
            expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
            scopes=[],
        )
    )
    client = GoogleClient(
        token_store=store, client_id="cid", client_secret="sec", scopes=[]
    )

    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        auth = request.headers.get("authorization", "")
        calls.append(f"{request.method} {url} {auth}")
        if "oauth2.googleapis.com/token" in url:
            return httpx.Response(
                200,
                json={
                    "access_token": "fresh",
                    "expires_in": 3600,
                    "scope": "scope-a",
                },
            )
        if auth == "Bearer stale":
            return httpx.Response(401, json={"error": "invalid"})
        return httpx.Response(200, json={"items": []})

    _patch_httpx(monkeypatch, handler)

    result = await client.list_calendars()
    assert result == []
    # We expect: 1 initial call (401) → refresh → retry → 200
    assert any("Bearer stale" in c for c in calls)
    assert any("Bearer fresh" in c for c in calls)
    assert any("oauth2.googleapis.com/token" in c for c in calls)


@pytest.mark.asyncio
async def test_refresh_if_needed_skips_when_not_near_expiry(
    tmp_path: Path, monkeypatch
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
    client = GoogleClient(
        token_store=store, client_id="cid", client_secret="sec", scopes=[]
    )

    hit = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        hit["count"] += 1
        return httpx.Response(200, json={})

    _patch_httpx(monkeypatch, handler)
    await client.refresh_if_needed()
    assert hit["count"] == 0  # no refresh call made


@pytest.mark.asyncio
async def test_refresh_raises_without_refresh_token(tmp_path: Path) -> None:
    store = TokenStore(tmp_path / "tokens.enc")
    client = GoogleClient(
        token_store=store, client_id="cid", client_secret="sec", scopes=[]
    )
    with pytest.raises(GoogleAuthError):
        await client.refresh_if_needed()


# ----------------------------------------------------------------------
# Pure decoders
# ----------------------------------------------------------------------


def test_summarize_message_handles_missing_headers() -> None:
    raw = {"id": "m", "threadId": "t", "snippet": "s"}
    out = _summarize_message(raw)
    assert out["id"] == "m"
    assert out["subject"] == ""
    assert out["isUnread"] is False


def test_decode_full_message_prefers_text_plain() -> None:
    body_plain = base64.urlsafe_b64encode(b"hola mundo").decode("ascii").rstrip("=")
    body_html = base64.urlsafe_b64encode(b"<p>ignored</p>").decode("ascii").rstrip("=")
    raw = {
        "id": "mid",
        "threadId": "tid",
        "snippet": "hola",
        "labelIds": ["UNREAD"],
        "payload": {
            "mimeType": "multipart/alternative",
            "headers": [
                {"name": "Subject", "value": "Oi"},
                {"name": "From", "value": "a@b.com"},
                {"name": "Date", "value": "Sat, 11 Apr 2026 10:00:00 +0000"},
            ],
            "parts": [
                {"mimeType": "text/plain", "body": {"data": body_plain}},
                {"mimeType": "text/html", "body": {"data": body_html}},
            ],
        },
    }
    out = _decode_full_message(raw)
    assert out["subject"] == "Oi"
    assert out["from"] == "a@b.com"
    assert out["body"] == "hola mundo"
    assert out["bodyHtml"] == "<p>ignored</p>"
    assert out["isUnread"] is True


# ----------------------------------------------------------------------
# Phase B — write tools
# ----------------------------------------------------------------------


async def _make_authed_client(tmp_path: Path) -> GoogleClient:
    store = TokenStore(tmp_path / "tokens.enc")
    await store.save(
        TokenBundle(
            access_token="live",
            refresh_token="rt",
            expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
            scopes=[],
        )
    )
    return GoogleClient(
        token_store=store, client_id="cid", client_secret="sec", scopes=[]
    )


def test_phase_b_tools_require_confirmation() -> None:
    # Can instantiate without a live client for static checks.
    dummy: Any = object()
    assert CalendarCreateEventTool(dummy).requires_confirmation is True
    assert CalendarUpdateEventTool(dummy).requires_confirmation is True
    assert CalendarDeleteEventTool(dummy).requires_confirmation is True
    assert GmailSendMessageTool(dummy).requires_confirmation is True


def test_phase_b_tool_schemas_have_required_args() -> None:
    dummy: Any = object()
    create = CalendarCreateEventTool(dummy).json_schema
    assert set(create.get("required", [])) == {"summary", "start", "end"}
    for prop in ("summary", "start", "end", "description", "location", "attendees", "calendar_id"):
        assert prop in create["properties"]

    update = CalendarUpdateEventTool(dummy).json_schema
    assert update.get("required") == ["event_id"]
    for prop in ("event_id", "calendar_id", "summary", "start", "end", "description", "location", "attendees"):
        assert prop in update["properties"]

    delete = CalendarDeleteEventTool(dummy).json_schema
    assert delete.get("required") == ["event_id"]
    assert "calendar_id" in delete["properties"]

    send = GmailSendMessageTool(dummy).json_schema
    assert set(send.get("required", [])) == {"to", "subject", "body"}
    for prop in ("to", "subject", "body", "cc", "bcc", "in_reply_to_message_id"):
        assert prop in send["properties"]


@pytest.mark.asyncio
async def test_calendar_create_event_builds_correct_request(
    tmp_path: Path, monkeypatch
) -> None:
    client = await _make_authed_client(tmp_path)
    tool = CalendarCreateEventTool(client)

    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["url"] = str(request.url)
        captured["body"] = json.loads(request.content.decode("utf-8"))
        return httpx.Response(
            200,
            json={
                "id": "evt-1",
                "htmlLink": "https://cal.example/evt-1",
                "summary": captured["body"].get("summary"),
            },
        )

    _patch_httpx(monkeypatch, handler)

    result = await tool.execute(
        {
            "summary": "Reunião X",
            "start": "2026-04-12T15:00:00-03:00",
            "end": "2026-04-12T16:00:00-03:00",
            "description": "pauta",
            "location": "Sala 1",
            "attendees": ["a@b.com", "c@d.com"],
        }
    )

    assert result.ok is True
    assert captured["method"] == "POST"
    assert "calendars/primary/events" in captured["url"]
    assert captured["body"]["summary"] == "Reunião X"
    assert captured["body"]["start"]["dateTime"].startswith("2026-04-12T15:00:00")
    assert captured["body"]["end"]["dateTime"].startswith("2026-04-12T16:00:00")
    assert captured["body"]["description"] == "pauta"
    assert captured["body"]["location"] == "Sala 1"
    assert captured["body"]["attendees"] == [
        {"email": "a@b.com"},
        {"email": "c@d.com"},
    ]
    assert result.metadata["event_id"] == "evt-1"
    assert result.metadata["htmlLink"] == "https://cal.example/evt-1"


@pytest.mark.asyncio
async def test_calendar_create_event_rejects_missing_required(
    tmp_path: Path,
) -> None:
    client = await _make_authed_client(tmp_path)
    tool = CalendarCreateEventTool(client)
    result = await tool.execute({"start": "2026-04-12T15:00:00Z", "end": "2026-04-12T16:00:00Z"})
    assert result.ok is False
    assert "summary" in (result.error or "")


@pytest.mark.asyncio
async def test_calendar_update_event_only_sends_passed_fields(
    tmp_path: Path, monkeypatch
) -> None:
    client = await _make_authed_client(tmp_path)
    tool = CalendarUpdateEventTool(client)

    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["url"] = str(request.url)
        captured["body"] = json.loads(request.content.decode("utf-8"))
        return httpx.Response(
            200,
            json={"id": "evt-9", "htmlLink": "https://cal.example/evt-9"},
        )

    _patch_httpx(monkeypatch, handler)

    result = await tool.execute(
        {
            "event_id": "evt-9",
            "summary": "novo título",
            "location": "Sala 2",
        }
    )

    assert result.ok is True
    assert captured["method"] == "PATCH"
    assert captured["url"].endswith("/calendars/primary/events/evt-9")
    # Only the fields we passed should appear in the PATCH body.
    assert set(captured["body"].keys()) == {"summary", "location"}
    assert captured["body"]["summary"] == "novo título"
    assert captured["body"]["location"] == "Sala 2"


@pytest.mark.asyncio
async def test_calendar_update_event_requires_at_least_one_field(
    tmp_path: Path,
) -> None:
    client = await _make_authed_client(tmp_path)
    tool = CalendarUpdateEventTool(client)
    result = await tool.execute({"event_id": "evt-9"})
    assert result.ok is False
    assert "no fields" in (result.error or "")


@pytest.mark.asyncio
async def test_calendar_delete_event_issues_delete(
    tmp_path: Path, monkeypatch
) -> None:
    client = await _make_authed_client(tmp_path)
    tool = CalendarDeleteEventTool(client)

    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["url"] = str(request.url)
        return httpx.Response(204)

    _patch_httpx(monkeypatch, handler)

    result = await tool.execute({"event_id": "evt-del", "calendar_id": "primary"})
    assert result.ok is True
    assert captured["method"] == "DELETE"
    assert captured["url"].endswith("/calendars/primary/events/evt-del")
    assert result.metadata == {"ok": True, "event_id": "evt-del"}


@pytest.mark.asyncio
async def test_gmail_send_message_builds_mime_and_posts_raw(
    tmp_path: Path, monkeypatch
) -> None:
    client = await _make_authed_client(tmp_path)
    tool = GmailSendMessageTool(client)

    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.endswith("/users/me/profile"):
            return httpx.Response(
                200, json={"emailAddress": "me@example.com"}
            )
        if url.endswith("/messages/send"):
            captured["method"] = request.method
            captured["url"] = url
            captured["body"] = json.loads(request.content.decode("utf-8"))
            return httpx.Response(
                200, json={"id": "sent-1", "threadId": "thr-1"}
            )
        return httpx.Response(404, json={"error": "unexpected"})

    _patch_httpx(monkeypatch, handler)

    result = await tool.execute(
        {
            "to": ["alice@example.com", "bob@example.com"],
            "subject": "Oi",
            "body": "Tudo bem?",
        }
    )

    assert result.ok is True, result.error
    assert captured["method"] == "POST"
    assert captured["url"].endswith("/users/me/messages/send")
    raw_b64 = captured["body"]["raw"]
    # No threadId on a fresh message.
    assert "threadId" not in captured["body"]
    decoded = base64.urlsafe_b64decode(raw_b64.encode("ascii")).decode("utf-8")
    import email

    mime_msg = email.message_from_string(decoded)
    assert mime_msg["To"] == "alice@example.com, bob@example.com"
    assert mime_msg["Subject"] == "Oi"
    assert mime_msg["From"] == "me@example.com"
    # Body may be transfer-encoded; use get_payload(decode=True) to normalize.
    payload = mime_msg.get_payload(decode=True)
    assert payload is not None
    assert payload.decode("utf-8").strip() == "Tudo bem?"
    assert result.metadata["message_id"] == "sent-1"
    assert result.metadata["thread_id"] == "thr-1"


@pytest.mark.asyncio
async def test_gmail_send_message_threads_reply_with_references(
    tmp_path: Path, monkeypatch
) -> None:
    client = await _make_authed_client(tmp_path)
    tool = GmailSendMessageTool(client)

    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.endswith("/users/me/profile"):
            return httpx.Response(
                200, json={"emailAddress": "me@example.com"}
            )
        if "/messages/orig-123" in url:
            return httpx.Response(
                200,
                json={
                    "id": "orig-123",
                    "threadId": "thread-xyz",
                    "payload": {
                        "headers": [
                            {"name": "Message-Id", "value": "<orig@example.com>"},
                            {"name": "References", "value": "<prev@example.com>"},
                        ]
                    },
                },
            )
        if url.endswith("/messages/send"):
            captured["body"] = json.loads(request.content.decode("utf-8"))
            return httpx.Response(
                200, json={"id": "reply-1", "threadId": "thread-xyz"}
            )
        return httpx.Response(404, json={"error": "unexpected"})

    _patch_httpx(monkeypatch, handler)

    result = await tool.execute(
        {
            "to": "alice@example.com",
            "subject": "Re: Oi",
            "body": "Tudo ótimo!",
            "in_reply_to_message_id": "orig-123",
        }
    )

    assert result.ok is True, result.error
    assert captured["body"]["threadId"] == "thread-xyz"
    decoded = base64.urlsafe_b64decode(
        captured["body"]["raw"].encode("ascii")
    ).decode("utf-8")
    assert "In-Reply-To: <orig@example.com>" in decoded
    # References should include the prior chain plus the message we replied to.
    assert "References:" in decoded
    assert "<prev@example.com>" in decoded
    assert "<orig@example.com>" in decoded
    assert result.metadata["thread_id"] == "thread-xyz"


@pytest.mark.asyncio
async def test_gmail_send_message_requires_to_subject_body(
    tmp_path: Path,
) -> None:
    client = await _make_authed_client(tmp_path)
    tool = GmailSendMessageTool(client)

    r1 = await tool.execute({"subject": "s", "body": "b"})
    assert r1.ok is False
    r2 = await tool.execute({"to": "a@b.com", "body": "b"})
    assert r2.ok is False
    r3 = await tool.execute({"to": "a@b.com", "subject": "s"})
    assert r3.ok is False


def test_decode_full_message_collects_attachments() -> None:
    raw = {
        "id": "m",
        "payload": {
            "mimeType": "multipart/mixed",
            "headers": [],
            "parts": [
                {
                    "mimeType": "text/plain",
                    "body": {
                        "data": base64.urlsafe_b64encode(b"body").decode("ascii")
                    },
                },
                {
                    "filename": "doc.pdf",
                    "mimeType": "application/pdf",
                    "body": {"attachmentId": "a1", "size": 1234},
                },
            ],
        },
    }
    out = _decode_full_message(raw)
    assert out["body"] == "body"
    assert len(out["attachments"]) == 1
    assert out["attachments"][0]["filename"] == "doc.pdf"
    assert out["attachments"][0]["attachmentId"] == "a1"
