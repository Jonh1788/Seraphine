"""Async client for Google Workspace APIs (Calendar + Gmail).

Wraps httpx with automatic OAuth token refresh and a single
retry-on-401 path. Tokens are loaded from :class:`TokenStore` on
first use and persisted back after every refresh.

See ``specs/006-google-integration.md`` for the full design. This
module implements the Phase A read surface (list/get) and the Phase B
write surface (create/update/delete/send). Phase A tools wired into
the registry only use the read methods.
"""

from __future__ import annotations

import asyncio
import base64
import logging
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from typing import Any, Iterable, Optional

import httpx

from seraphine.google.token_store import TokenBundle, TokenStore

logger = logging.getLogger(__name__)

CALENDAR_API = "https://www.googleapis.com/calendar/v3"
GMAIL_API = "https://gmail.googleapis.com/gmail/v1"
TOKEN_URL = "https://oauth2.googleapis.com/token"

# Refresh when we're within this window of expiry.
REFRESH_SKEW = timedelta(minutes=5)
DEFAULT_TIMEOUT = 20.0


class GoogleAuthError(RuntimeError):
    """Raised when no usable credentials are available."""


class GoogleClient:
    """Async Google Workspace client with transparent refresh."""

    def __init__(
        self,
        token_store: TokenStore,
        client_id: str,
        client_secret: str,
        scopes: list[str],
    ) -> None:
        self._store = token_store
        self._client_id = client_id
        self._client_secret = client_secret
        self._scopes = list(scopes)
        self._bundle: Optional[TokenBundle] = None
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------------
    # Auth
    # ------------------------------------------------------------------

    async def _get_bundle(self) -> Optional[TokenBundle]:
        if self._bundle is None:
            self._bundle = await self._store.load()
        return self._bundle

    async def get_bundle(self) -> Optional[TokenBundle]:
        """Return the current token bundle (cached), or None if unauthed.

        Public accessor used by the REST router and tools that need to
        report ``expires_at`` / ``scopes`` without exposing the
        underlying TokenStore.
        """
        return await self._get_bundle()

    async def is_authed(self) -> bool:
        bundle = await self._get_bundle()
        if bundle is None:
            return False
        # If access_token is live, we're good.
        if bundle.expires_at > datetime.now(timezone.utc):
            return True
        # Otherwise we need a refresh_token to revive it.
        return bool(bundle.refresh_token)

    async def save_bundle(self, bundle: TokenBundle) -> None:
        """Public hook used by the OAuth flow to persist a freshly
        minted token bundle. Also updates the in-memory cache."""
        await self._store.save(bundle)
        self._bundle = bundle

    async def clear(self) -> None:
        await self._store.clear()
        self._bundle = None

    async def refresh_if_needed(self) -> None:
        bundle = await self._get_bundle()
        if bundle is None:
            raise GoogleAuthError("no google credentials on file")
        deadline = datetime.now(timezone.utc) + REFRESH_SKEW
        if bundle.expires_at > deadline:
            return
        await self._force_refresh()

    async def _force_refresh(self) -> None:
        async with self._lock:
            bundle = await self._get_bundle()
            if bundle is None or not bundle.refresh_token:
                raise GoogleAuthError("no refresh_token available; re-auth required")
            data = {
                "client_id": self._client_id,
                "client_secret": self._client_secret,
                "refresh_token": bundle.refresh_token,
                "grant_type": "refresh_token",
            }
            async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
                resp = await client.post(TOKEN_URL, data=data)
                if resp.status_code >= 400:
                    raise GoogleAuthError(
                        f"refresh failed: {resp.status_code} {resp.text}"
                    )
                payload = resp.json()
            expires_in = int(payload.get("expires_in", 3600))
            new_bundle = TokenBundle(
                access_token=payload["access_token"],
                # Google doesn't return a new refresh_token on refresh
                # unless you re-consent, so we keep the old one.
                refresh_token=payload.get("refresh_token") or bundle.refresh_token,
                expires_at=datetime.now(timezone.utc) + timedelta(seconds=expires_in),
                scopes=(payload.get("scope") or " ".join(bundle.scopes)).split(),
            )
            await self._store.save(new_bundle)
            self._bundle = new_bundle
            logger.info("google token refreshed (exp=%s)", new_bundle.expires_at.isoformat())

    async def _authed_request(
        self,
        method: str,
        url: str,
        *,
        params: dict[str, Any] | None = None,
        json: Any = None,
        headers: dict[str, str] | None = None,
    ) -> httpx.Response:
        await self.refresh_if_needed()
        bundle = await self._get_bundle()
        if bundle is None:
            raise GoogleAuthError("no google credentials on file")

        hdrs = {"Authorization": f"Bearer {bundle.access_token}"}
        if headers:
            hdrs.update(headers)

        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
            resp = await client.request(
                method, url, params=params, json=json, headers=hdrs
            )
            if resp.status_code == 401:
                logger.info("google 401 on %s %s — forcing refresh", method, url)
                await self._force_refresh()
                bundle = await self._get_bundle()
                assert bundle is not None
                hdrs["Authorization"] = f"Bearer {bundle.access_token}"
                resp = await client.request(
                    method, url, params=params, json=json, headers=hdrs
                )
            if resp.status_code >= 400:
                raise RuntimeError(
                    f"google api {method} {url} failed: "
                    f"{resp.status_code} {resp.text[:500]}"
                )
            return resp

    # ------------------------------------------------------------------
    # Calendar — read
    # ------------------------------------------------------------------

    async def list_calendars(self) -> list[dict]:
        url = f"{CALENDAR_API}/users/me/calendarList"
        resp = await self._authed_request("GET", url)
        return resp.json().get("items", [])

    async def list_events(
        self,
        *,
        time_min: datetime | None = None,
        time_max: datetime | None = None,
        q: str | None = None,
        max_results: int = 20,
        calendar_id: str = "primary",
    ) -> list[dict]:
        url = f"{CALENDAR_API}/calendars/{calendar_id}/events"
        params: dict[str, Any] = {
            "maxResults": max_results,
            "singleEvents": "true",
            "orderBy": "startTime",
        }
        if time_min is not None:
            params["timeMin"] = _rfc3339(time_min)
        if time_max is not None:
            params["timeMax"] = _rfc3339(time_max)
        if q:
            params["q"] = q
        resp = await self._authed_request("GET", url, params=params)
        return resp.json().get("items", [])

    async def get_event(
        self, event_id: str, *, calendar_id: str = "primary"
    ) -> dict:
        url = f"{CALENDAR_API}/calendars/{calendar_id}/events/{event_id}"
        resp = await self._authed_request("GET", url)
        return resp.json()

    # ------------------------------------------------------------------
    # Calendar — write (Phase B; wired but no tools yet)
    # ------------------------------------------------------------------

    async def create_event(
        self,
        *,
        summary: str,
        start: datetime,
        end: datetime,
        description: str | None = None,
        location: str | None = None,
        attendees: list[str] | None = None,
        calendar_id: str = "primary",
    ) -> dict:
        url = f"{CALENDAR_API}/calendars/{calendar_id}/events"
        body: dict[str, Any] = {
            "summary": summary,
            "start": {"dateTime": _rfc3339(start)},
            "end": {"dateTime": _rfc3339(end)},
        }
        if description is not None:
            body["description"] = description
        if location is not None:
            body["location"] = location
        if attendees:
            body["attendees"] = [{"email": a} for a in attendees]
        resp = await self._authed_request("POST", url, json=body)
        return resp.json()

    async def update_event(
        self, event_id: str, *, calendar_id: str = "primary", **fields: Any
    ) -> dict:
        url = f"{CALENDAR_API}/calendars/{calendar_id}/events/{event_id}"
        # Support convenience kwargs that mirror create_event.
        body: dict[str, Any] = {}
        if "summary" in fields:
            body["summary"] = fields.pop("summary")
        if "description" in fields:
            body["description"] = fields.pop("description")
        if "location" in fields:
            body["location"] = fields.pop("location")
        if "start" in fields:
            s = fields.pop("start")
            body["start"] = {"dateTime": _rfc3339(s)} if isinstance(s, datetime) else s
        if "end" in fields:
            e = fields.pop("end")
            body["end"] = {"dateTime": _rfc3339(e)} if isinstance(e, datetime) else e
        if "attendees" in fields:
            attendees = fields.pop("attendees") or []
            body["attendees"] = [{"email": a} for a in attendees]
        # Any remaining kwargs are passed through verbatim.
        body.update(fields)
        resp = await self._authed_request("PATCH", url, json=body)
        return resp.json()

    async def delete_event(
        self, event_id: str, *, calendar_id: str = "primary"
    ) -> None:
        url = f"{CALENDAR_API}/calendars/{calendar_id}/events/{event_id}"
        await self._authed_request("DELETE", url)

    # ------------------------------------------------------------------
    # Gmail — read
    # ------------------------------------------------------------------

    async def get_profile(self) -> dict:
        url = f"{GMAIL_API}/users/me/profile"
        resp = await self._authed_request("GET", url)
        return resp.json()

    async def list_messages(
        self,
        *,
        q: str | None = None,
        label_ids: list[str] | None = None,
        max_results: int = 20,
    ) -> list[dict]:
        """List messages and fetch headers in parallel.

        Returns a compact shape with the parsed ``from``, ``subject`` and
        ``date`` headers already resolved so callers don't have to make
        a second round-trip.
        """
        url = f"{GMAIL_API}/users/me/messages"
        params: dict[str, Any] = {"maxResults": max_results}
        if q:
            params["q"] = q
        if label_ids:
            # httpx will repeat labelIds for each list entry.
            params["labelIds"] = label_ids
        resp = await self._authed_request("GET", url, params=params)
        ids = [m["id"] for m in resp.json().get("messages", [])]
        if not ids:
            return []

        async def _fetch(mid: str) -> dict | None:
            try:
                detail_url = f"{GMAIL_API}/users/me/messages/{mid}"
                detail = await self._authed_request(
                    "GET",
                    detail_url,
                    params={
                        "format": "metadata",
                        "metadataHeaders": ["Subject", "From", "Date"],
                    },
                )
            except Exception as e:  # pragma: no cover
                logger.warning("gmail message fetch failed for %s: %s", mid, e)
                return None
            return _summarize_message(detail.json())

        results = await asyncio.gather(*(_fetch(i) for i in ids))
        return [r for r in results if r is not None]

    async def get_message(self, message_id: str, *, format: str = "full") -> dict:
        url = f"{GMAIL_API}/users/me/messages/{message_id}"
        resp = await self._authed_request("GET", url, params={"format": format})
        raw = resp.json()
        return _decode_full_message(raw)

    async def list_important_unread(self, *, max_results: int = 20) -> list[dict]:
        return await self.list_messages(
            q="is:important is:unread", max_results=max_results
        )

    # ------------------------------------------------------------------
    # Gmail — write (Phase B)
    # ------------------------------------------------------------------

    async def send_message(
        self,
        *,
        to: list[str] | str,
        subject: str,
        body: str,
        cc: list[str] | None = None,
        in_reply_to: str | None = None,
    ) -> dict:
        msg = EmailMessage()
        msg["To"] = ", ".join(to) if isinstance(to, (list, tuple)) else to
        if cc:
            msg["Cc"] = ", ".join(cc)
        msg["Subject"] = subject
        if in_reply_to:
            msg["In-Reply-To"] = in_reply_to
            msg["References"] = in_reply_to
        msg.set_content(body)

        raw = base64.urlsafe_b64encode(msg.as_bytes()).decode("ascii")
        url = f"{GMAIL_API}/users/me/messages/send"
        resp = await self._authed_request("POST", url, json={"raw": raw})
        return resp.json()


# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------


def _rfc3339(dt: datetime) -> str:
    """Return an RFC3339 timestamp with a 'Z' suffix for UTC if naive."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat().replace("+00:00", "Z")


def _summarize_message(raw: dict) -> dict:
    """Extract the compact row shape used by ``list_messages``."""
    headers = {h.get("name", "").lower(): h.get("value", "")
               for h in raw.get("payload", {}).get("headers", [])}
    labels = raw.get("labelIds") or []
    return {
        "id": raw.get("id"),
        "threadId": raw.get("threadId"),
        "snippet": raw.get("snippet", ""),
        "from": headers.get("from", ""),
        "subject": headers.get("subject", ""),
        "date": headers.get("date", ""),
        "isUnread": "UNREAD" in labels,
        "isImportant": "IMPORTANT" in labels,
    }


def _decode_b64url(data: str) -> bytes:
    data = data.replace("-", "+").replace("_", "/")
    # Re-pad
    pad = (-len(data)) % 4
    data += "=" * pad
    try:
        return base64.b64decode(data)
    except Exception:
        return b""


def _walk_parts(payload: dict) -> Iterable[dict]:
    """Depth-first walk over a Gmail message payload's parts."""
    yield payload
    for part in payload.get("parts", []) or []:
        yield from _walk_parts(part)


def _decode_full_message(raw: dict) -> dict:
    """Decode a full Gmail message into a flat user-friendly shape."""
    payload = raw.get("payload", {}) or {}
    headers = {h.get("name", "").lower(): h.get("value", "")
               for h in payload.get("headers", [])}
    labels = raw.get("labelIds") or []

    # Prefer text/plain, then text/html.
    text_plain: str | None = None
    text_html: str | None = None
    attachments: list[dict] = []

    for part in _walk_parts(payload):
        mime = (part.get("mimeType") or "").lower()
        body = part.get("body") or {}
        data = body.get("data")
        filename = part.get("filename") or ""

        if filename and body.get("attachmentId"):
            attachments.append(
                {
                    "filename": filename,
                    "mimeType": mime,
                    "size": body.get("size", 0),
                    "attachmentId": body.get("attachmentId"),
                }
            )
            continue

        if not data:
            continue
        decoded = _decode_b64url(data)
        if mime == "text/plain" and text_plain is None:
            text_plain = decoded.decode("utf-8", errors="replace")
        elif mime == "text/html" and text_html is None:
            text_html = decoded.decode("utf-8", errors="replace")

    body_text = text_plain if text_plain is not None else (text_html or "")

    return {
        "id": raw.get("id"),
        "threadId": raw.get("threadId"),
        "snippet": raw.get("snippet", ""),
        "from": headers.get("from", ""),
        "to": headers.get("to", ""),
        "cc": headers.get("cc", ""),
        "subject": headers.get("subject", ""),
        "date": headers.get("date", ""),
        "body": body_text,
        "bodyHtml": text_html,
        "isUnread": "UNREAD" in labels,
        "isImportant": "IMPORTANT" in labels,
        "attachments": attachments,
        "labelIds": labels,
    }
