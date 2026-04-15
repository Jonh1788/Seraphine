"""Phase C polish tests for the Google integration.

Covers:

1. Calendar event cache — TTL hit/miss + invalidation on writes.
2. Gmail reply threading — multi-hop chain builds a correct
   RFC 5322 References header; threadId is carried through; fetch
   failure falls back to a plain send.
3. Gmail attachments — single attachment, multi-attachment,
   path-outside-allowed-roots rejection, nonexistent file rejection.
"""

from __future__ import annotations

import base64
import email
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest

from google_integration.client import (
    CALENDAR_CACHE_TTL_SECONDS,
    CalendarEventCache,
    GoogleClient,
)
from google_integration.token_store import TokenBundle, TokenStore
from seraphine.tools.google import (
    CalendarCreateEventTool,
    CalendarDeleteEventTool,
    CalendarUpdateEventTool,
    GmailSendMessageTool,
)


# ----------------------------------------------------------------------
# Helpers (mirrored from test_google_integration.py for isolation)
# ----------------------------------------------------------------------


def _patch_httpx(monkeypatch, handler) -> None:
    real_ac = httpx.AsyncClient

    def patched_ac(*args, **kwargs):  # type: ignore[no-untyped-def]
        kwargs["transport"] = httpx.MockTransport(handler)
        return real_ac(*args, **kwargs)

    monkeypatch.setattr("google_integration.client.httpx.AsyncClient", patched_ac)


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


# ----------------------------------------------------------------------
# Calendar event cache
# ----------------------------------------------------------------------


def test_cache_constant_is_30() -> None:
    assert CALENDAR_CACHE_TTL_SECONDS == 30


def test_cache_hit_within_ttl_returns_same_list() -> None:
    cache = CalendarEventCache(ttl_seconds=60)
    events = [{"id": "e1"}]
    cache.put("primary", "t0", "t1", events)
    assert cache.get("primary", "t0", "t1") == events


def test_cache_miss_on_different_window() -> None:
    cache = CalendarEventCache(ttl_seconds=60)
    cache.put("primary", "t0", "t1", [{"id": "e1"}])
    assert cache.get("primary", "tX", "tY") is None


def test_cache_expires_after_ttl() -> None:
    cache = CalendarEventCache(ttl_seconds=0.01)
    cache.put("primary", "t0", "t1", [{"id": "e1"}])
    import time as _t
    _t.sleep(0.02)
    assert cache.get("primary", "t0", "t1") is None


def test_cache_invalidate_calendar_purges_only_matching() -> None:
    cache = CalendarEventCache(ttl_seconds=60)
    cache.put("primary", "t0", "t1", [{"id": "a"}])
    cache.put("primary", "t2", "t3", [{"id": "b"}])
    cache.put("work", "t0", "t1", [{"id": "c"}])
    purged = cache.invalidate_calendar("primary")
    assert purged == 2
    assert cache.get("primary", "t0", "t1") is None
    assert cache.get("primary", "t2", "t3") is None
    assert cache.get("work", "t0", "t1") == [{"id": "c"}]


@pytest.mark.asyncio
async def test_list_events_hits_cache_on_second_call(
    tmp_path: Path, monkeypatch
) -> None:
    client = await _make_authed_client(tmp_path)

    hits = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        hits["count"] += 1
        return httpx.Response(
            200, json={"items": [{"id": f"e{hits['count']}"}]}
        )

    _patch_httpx(monkeypatch, handler)

    window = dict(
        time_min=datetime(2026, 4, 11, tzinfo=timezone.utc),
        time_max=datetime(2026, 4, 18, tzinfo=timezone.utc),
    )
    first = await client.list_events(**window)
    second = await client.list_events(**window)
    third = await client.list_events(**window)
    # Only one network hit; cache served the next two.
    assert hits["count"] == 1
    # All three return the same cached list (same element id).
    assert first == second == third
    assert first[0]["id"] == "e1"


@pytest.mark.asyncio
async def test_list_events_bypasses_cache_when_query_set(
    tmp_path: Path, monkeypatch
) -> None:
    """Free-text ``q`` + non-default ``max_results`` must always hit the API."""
    client = await _make_authed_client(tmp_path)
    hits = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        hits["count"] += 1
        return httpx.Response(200, json={"items": []})

    _patch_httpx(monkeypatch, handler)

    window = dict(
        time_min=datetime(2026, 4, 11, tzinfo=timezone.utc),
        time_max=datetime(2026, 4, 18, tzinfo=timezone.utc),
    )
    await client.list_events(q="pedro", **window)
    await client.list_events(q="pedro", **window)
    assert hits["count"] == 2

    await client.list_events(max_results=5, **window)
    await client.list_events(max_results=5, **window)
    assert hits["count"] == 4


@pytest.mark.asyncio
async def test_list_events_cache_invalidated_by_create_event(
    tmp_path: Path, monkeypatch
) -> None:
    client = await _make_authed_client(tmp_path)

    hits = {"list": 0, "create": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if request.method == "GET" and "/events" in url and "/events/" not in url:
            hits["list"] += 1
            return httpx.Response(200, json={"items": [{"id": "before"}]})
        if request.method == "POST" and url.endswith("/events"):
            hits["create"] += 1
            return httpx.Response(200, json={"id": "new-event"})
        return httpx.Response(404, json={"error": "unexpected"})

    _patch_httpx(monkeypatch, handler)

    window = dict(
        time_min=datetime(2026, 4, 11, tzinfo=timezone.utc),
        time_max=datetime(2026, 4, 18, tzinfo=timezone.utc),
    )

    # Prime the cache.
    await client.list_events(**window)
    assert hits["list"] == 1
    await client.list_events(**window)
    assert hits["list"] == 1  # cache hit

    # Create an event → invalidates.
    await client.create_event(
        summary="x",
        start=datetime(2026, 4, 12, 15, tzinfo=timezone.utc),
        end=datetime(2026, 4, 12, 16, tzinfo=timezone.utc),
    )
    assert hits["create"] == 1

    # Next list call must refetch.
    await client.list_events(**window)
    assert hits["list"] == 2


@pytest.mark.asyncio
async def test_create_event_tool_invalidates_cache(
    tmp_path: Path, monkeypatch
) -> None:
    """Tools call ``_authed_request`` directly, so they must invalidate too."""
    client = await _make_authed_client(tmp_path)
    tool = CalendarCreateEventTool(client)

    # Prime the cache manually.
    client.event_cache.put("primary", "t0", "t1", [{"id": "stale"}])

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"id": "evt-1", "htmlLink": "https://cal.example/evt-1"}
        )

    _patch_httpx(monkeypatch, handler)

    result = await tool.execute(
        {
            "summary": "Café",
            "start": "2026-04-12T15:00:00-03:00",
            "end": "2026-04-12T16:00:00-03:00",
        }
    )
    assert result.ok is True
    # Cache entry for primary should be gone.
    assert client.event_cache.get("primary", "t0", "t1") is None


@pytest.mark.asyncio
async def test_update_event_tool_invalidates_cache(
    tmp_path: Path, monkeypatch
) -> None:
    client = await _make_authed_client(tmp_path)
    tool = CalendarUpdateEventTool(client)
    client.event_cache.put("primary", "t0", "t1", [{"id": "stale"}])

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"id": "evt-1"})

    _patch_httpx(monkeypatch, handler)

    result = await tool.execute(
        {"event_id": "evt-1", "summary": "novo"}
    )
    assert result.ok is True
    assert client.event_cache.get("primary", "t0", "t1") is None


@pytest.mark.asyncio
async def test_delete_event_tool_invalidates_cache(
    tmp_path: Path, monkeypatch
) -> None:
    client = await _make_authed_client(tmp_path)
    tool = CalendarDeleteEventTool(client)
    client.event_cache.put("primary", "t0", "t1", [{"id": "stale"}])

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(204)

    _patch_httpx(monkeypatch, handler)

    result = await tool.execute({"event_id": "evt-1"})
    assert result.ok is True
    assert client.event_cache.get("primary", "t0", "t1") is None


# ----------------------------------------------------------------------
# Gmail reply threading — multi-hop chain
# ----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_gmail_reply_builds_multi_hop_references_chain(
    tmp_path: Path, monkeypatch
) -> None:
    """Reply to a reply to a reply: References must list all ancestors
    in order, with the parent's Message-Id appended at the end."""
    client = await _make_authed_client(tmp_path)
    tool = GmailSendMessageTool(client, allowed_roots=[tmp_path])

    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.endswith("/users/me/profile"):
            return httpx.Response(200, json={"emailAddress": "me@example.com"})
        # Parent of the new reply = third hop: Message-Id <c@x>, with
        # References listing the two ancestors above it.
        if "/messages/msg-c" in url:
            return httpx.Response(
                200,
                json={
                    "id": "msg-c",
                    "threadId": "thr-1",
                    "payload": {
                        "headers": [
                            {"name": "Message-Id", "value": "<c@example.com>"},
                            {
                                "name": "References",
                                "value": "<a@example.com> <b@example.com>",
                            },
                        ]
                    },
                },
            )
        if url.endswith("/messages/send"):
            captured["body"] = json.loads(request.content.decode("utf-8"))
            return httpx.Response(200, json={"id": "sent", "threadId": "thr-1"})
        return httpx.Response(404, json={"error": "unexpected"})

    _patch_httpx(monkeypatch, handler)

    result = await tool.execute(
        {
            "to": "alice@example.com",
            "subject": "Re: topic",
            "body": "fourth hop",
            "in_reply_to_message_id": "msg-c",
        }
    )
    assert result.ok is True, result.error
    assert captured["body"]["threadId"] == "thr-1"

    decoded = base64.urlsafe_b64decode(
        captured["body"]["raw"].encode("ascii")
    ).decode("utf-8")
    mime_msg = email.message_from_string(decoded)

    # In-Reply-To is always just the immediate parent.
    assert mime_msg["In-Reply-To"] == "<c@example.com>"
    # References must be the prior chain plus the parent, space-separated,
    # order preserved.
    refs = mime_msg["References"]
    assert refs is not None
    assert refs == "<a@example.com> <b@example.com> <c@example.com>"


@pytest.mark.asyncio
async def test_gmail_reply_no_prior_references_uses_parent_only(
    tmp_path: Path, monkeypatch
) -> None:
    """When the parent has no References header, the reply's References
    is exactly ``<parent-msgid>``."""
    client = await _make_authed_client(tmp_path)
    tool = GmailSendMessageTool(client, allowed_roots=[tmp_path])

    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.endswith("/users/me/profile"):
            return httpx.Response(200, json={"emailAddress": "me@example.com"})
        if "/messages/root-1" in url:
            return httpx.Response(
                200,
                json={
                    "id": "root-1",
                    "threadId": "thr-root",
                    "payload": {
                        "headers": [
                            {"name": "Message-Id", "value": "<root@example.com>"},
                        ]
                    },
                },
            )
        if url.endswith("/messages/send"):
            captured["body"] = json.loads(request.content.decode("utf-8"))
            return httpx.Response(200, json={"id": "r", "threadId": "thr-root"})
        return httpx.Response(404)

    _patch_httpx(monkeypatch, handler)

    result = await tool.execute(
        {
            "to": "a@b.com",
            "subject": "Re: first",
            "body": "first reply",
            "in_reply_to_message_id": "root-1",
        }
    )
    assert result.ok is True
    decoded = base64.urlsafe_b64decode(
        captured["body"]["raw"].encode("ascii")
    ).decode("utf-8")
    mime_msg = email.message_from_string(decoded)
    assert mime_msg["In-Reply-To"] == "<root@example.com>"
    assert mime_msg["References"] == "<root@example.com>"


@pytest.mark.asyncio
async def test_gmail_reply_fetch_failure_falls_back_to_plain_send(
    tmp_path: Path, monkeypatch
) -> None:
    """404 on the parent lookup must not hard-fail; we strip threading
    headers and send plain."""
    client = await _make_authed_client(tmp_path)
    tool = GmailSendMessageTool(client, allowed_roots=[tmp_path])

    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.endswith("/users/me/profile"):
            return httpx.Response(200, json={"emailAddress": "me@example.com"})
        if "/messages/ghost" in url:
            return httpx.Response(404, json={"error": "not found"})
        if url.endswith("/messages/send"):
            captured["body"] = json.loads(request.content.decode("utf-8"))
            return httpx.Response(200, json={"id": "sent", "threadId": "new"})
        return httpx.Response(404)

    _patch_httpx(monkeypatch, handler)

    result = await tool.execute(
        {
            "to": "a@b.com",
            "subject": "oi",
            "body": "corpo",
            "in_reply_to_message_id": "ghost",
        }
    )
    assert result.ok is True, result.error
    # No threadId in the payload — we fell back.
    assert "threadId" not in captured["body"]
    decoded = base64.urlsafe_b64decode(
        captured["body"]["raw"].encode("ascii")
    ).decode("utf-8")
    mime_msg = email.message_from_string(decoded)
    assert mime_msg["In-Reply-To"] is None
    assert mime_msg["References"] is None


# ----------------------------------------------------------------------
# Gmail attachments
# ----------------------------------------------------------------------


def _profile_and_send_handler(captured: dict):
    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.endswith("/users/me/profile"):
            return httpx.Response(200, json={"emailAddress": "me@example.com"})
        if url.endswith("/messages/send"):
            captured["body"] = json.loads(request.content.decode("utf-8"))
            return httpx.Response(200, json={"id": "sent-1", "threadId": "t-1"})
        return httpx.Response(404, json={"error": "unexpected"})
    return handler


@pytest.mark.asyncio
async def test_gmail_send_with_single_attachment(
    tmp_path: Path, monkeypatch
) -> None:
    client = await _make_authed_client(tmp_path)
    tool = GmailSendMessageTool(client, allowed_roots=[tmp_path])

    attach_path = tmp_path / "doc.txt"
    attach_path.write_bytes(b"hello attachment")

    captured: dict = {}
    _patch_httpx(monkeypatch, _profile_and_send_handler(captured))

    result = await tool.execute(
        {
            "to": "a@b.com",
            "subject": "with file",
            "body": "see attached",
            "attachments": [{"path": str(attach_path)}],
        }
    )
    assert result.ok is True, result.error
    assert result.metadata["attachments_count"] == 1

    raw = base64.urlsafe_b64decode(
        captured["body"]["raw"].encode("ascii")
    )
    mime_msg = email.message_from_bytes(raw)
    assert mime_msg.is_multipart()
    parts = list(mime_msg.walk())
    # [multipart/mixed root, text/plain body, text/plain attachment]
    types = [p.get_content_type() for p in parts]
    assert types[0] == "multipart/mixed"
    assert "text/plain" in types
    # Attachment part has a filename.
    filenames = [p.get_filename() for p in parts if p.get_filename()]
    assert "doc.txt" in filenames
    # Decoded attachment content matches original bytes.
    attachment_part = next(p for p in parts if p.get_filename() == "doc.txt")
    assert attachment_part.get_payload(decode=True) == b"hello attachment"


@pytest.mark.asyncio
async def test_gmail_send_with_two_attachments_of_different_types(
    tmp_path: Path, monkeypatch
) -> None:
    client = await _make_authed_client(tmp_path)
    tool = GmailSendMessageTool(client, allowed_roots=[tmp_path])

    txt_path = tmp_path / "notes.txt"
    txt_path.write_bytes(b"notes")
    bin_path = tmp_path / "pic.png"
    # A tiny PNG header is fine — we're not decoding the image, we just
    # verify MIME typing and byte preservation.
    bin_path.write_bytes(b"\x89PNG\r\n\x1a\nFAKEDATA")

    captured: dict = {}
    _patch_httpx(monkeypatch, _profile_and_send_handler(captured))

    result = await tool.execute(
        {
            "to": "a@b.com",
            "subject": "two",
            "body": "body",
            "attachments": [
                {"path": str(txt_path)},
                {"path": str(bin_path), "mime_type": "image/png"},
            ],
        }
    )
    assert result.ok is True, result.error
    assert result.metadata["attachments_count"] == 2

    raw = base64.urlsafe_b64decode(captured["body"]["raw"].encode("ascii"))
    mime_msg = email.message_from_bytes(raw)
    parts = list(mime_msg.walk())
    filenames = [p.get_filename() for p in parts if p.get_filename()]
    assert "notes.txt" in filenames
    assert "pic.png" in filenames

    png_part = next(p for p in parts if p.get_filename() == "pic.png")
    assert png_part.get_content_type() == "image/png"
    assert png_part.get_payload(decode=True) == b"\x89PNG\r\n\x1a\nFAKEDATA"

    txt_part = next(p for p in parts if p.get_filename() == "notes.txt")
    assert txt_part.get_payload(decode=True) == b"notes"


@pytest.mark.asyncio
async def test_gmail_attachment_outside_allowed_roots_is_rejected(
    tmp_path: Path, monkeypatch
) -> None:
    client = await _make_authed_client(tmp_path)
    sandbox = tmp_path / "sandbox"
    sandbox.mkdir()
    tool = GmailSendMessageTool(client, allowed_roots=[sandbox])

    # File lives outside the sandbox root.
    outside = tmp_path / "outside.txt"
    outside.write_bytes(b"nope")

    # The tool should reject before making any HTTP call — intercept
    # everything to make sure nothing leaks out.
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"no network call expected, got {request.url}")

    _patch_httpx(monkeypatch, handler)

    result = await tool.execute(
        {
            "to": "a@b.com",
            "subject": "x",
            "body": "x",
            "attachments": [{"path": str(outside)}],
        }
    )
    assert result.ok is False
    assert result.error is not None
    assert "not under allowed roots" in result.error


@pytest.mark.asyncio
async def test_gmail_attachment_nonexistent_file_is_rejected(
    tmp_path: Path, monkeypatch
) -> None:
    client = await _make_authed_client(tmp_path)
    tool = GmailSendMessageTool(client, allowed_roots=[tmp_path])

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"no network call expected, got {request.url}")

    _patch_httpx(monkeypatch, handler)

    missing = tmp_path / "ghost.txt"
    result = await tool.execute(
        {
            "to": "a@b.com",
            "subject": "x",
            "body": "x",
            "attachments": [{"path": str(missing)}],
        }
    )
    assert result.ok is False
    assert result.error is not None
    assert "not found" in result.error


@pytest.mark.asyncio
async def test_gmail_attachment_without_allowed_roots_is_rejected(
    tmp_path: Path, monkeypatch
) -> None:
    """If the tool was constructed with no allowed_roots, attachments
    must be refused outright (the Phase A/B test fixtures still
    construct without roots — they must keep working because they
    don't pass attachments)."""
    client = await _make_authed_client(tmp_path)
    tool = GmailSendMessageTool(client)  # no allowed_roots

    attach = tmp_path / "f.txt"
    attach.write_bytes(b"x")

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("no network call expected")

    _patch_httpx(monkeypatch, handler)

    result = await tool.execute(
        {
            "to": "a@b.com",
            "subject": "x",
            "body": "x",
            "attachments": [{"path": str(attach)}],
        }
    )
    assert result.ok is False
    assert "allowed_tool_roots" in (result.error or "")


@pytest.mark.asyncio
async def test_gmail_attachment_with_reply_threading_combo(
    tmp_path: Path, monkeypatch
) -> None:
    """threadId + attachments must coexist."""
    client = await _make_authed_client(tmp_path)
    tool = GmailSendMessageTool(client, allowed_roots=[tmp_path])

    attach = tmp_path / "a.txt"
    attach.write_bytes(b"attached")

    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.endswith("/users/me/profile"):
            return httpx.Response(200, json={"emailAddress": "me@example.com"})
        if "/messages/parent" in url:
            return httpx.Response(
                200,
                json={
                    "id": "parent",
                    "threadId": "thr-x",
                    "payload": {
                        "headers": [
                            {"name": "Message-Id", "value": "<p@example.com>"},
                        ]
                    },
                },
            )
        if url.endswith("/messages/send"):
            captured["body"] = json.loads(request.content.decode("utf-8"))
            return httpx.Response(
                200, json={"id": "sent", "threadId": "thr-x"}
            )
        return httpx.Response(404)

    _patch_httpx(monkeypatch, handler)

    result = await tool.execute(
        {
            "to": "a@b.com",
            "subject": "Re: combo",
            "body": "body",
            "in_reply_to_message_id": "parent",
            "attachments": [{"path": str(attach)}],
        }
    )
    assert result.ok is True, result.error
    assert captured["body"]["threadId"] == "thr-x"
    raw = base64.urlsafe_b64decode(captured["body"]["raw"].encode("ascii"))
    mime_msg = email.message_from_bytes(raw)
    assert mime_msg.is_multipart()
    assert mime_msg["In-Reply-To"] == "<p@example.com>"
    filenames = [p.get_filename() for p in mime_msg.walk() if p.get_filename()]
    assert "a.txt" in filenames
