"""Google Workspace tools (Phase A + Phase B).

Read-only tools (``requires_confirmation=False``):

- ``google_auth_status`` — is Seraphine connected? whose account?
- ``calendar_list_events`` — upcoming or date-range events
- ``gmail_list_important`` — important unread emails
- ``gmail_read_message`` — full body of one message

Write tools (``requires_confirmation=True``, go through the approval gate):

- ``calendar_create_event`` — create a new Calendar event
- ``calendar_update_event`` — PATCH an existing Calendar event
- ``calendar_delete_event`` — delete a Calendar event
- ``gmail_send_message`` — send a plain-text email (optionally a reply)
"""

from __future__ import annotations

import base64
from datetime import datetime, timedelta, timezone
from email.mime.text import MIMEText
from typing import Any, Optional

from seraphine.google.client import (
    CALENDAR_API,
    GMAIL_API,
    GoogleAuthError,
    GoogleClient,
    _rfc3339,
)
from seraphine.tools.base import Tool, ToolResult


def _parse_iso(s: str) -> datetime:
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _not_authed_result() -> ToolResult:
    return ToolResult(
        ok=False,
        error=(
            "Google não está conectado. Peça ao usuário para clicar em "
            "'Conectar Google' no painel lateral."
        ),
    )


class GoogleAuthStatusTool(Tool):
    name = "google_auth_status"
    description = (
        "Check whether Seraphine is currently authenticated with Google "
        "Workspace (Calendar + Gmail). Returns the linked email address "
        "and the granted scopes, or a hint to connect if not authed. "
        "Use this when the user asks about Google connectivity or before "
        "attempting a calendar/gmail operation if you're unsure of the state."
    )
    json_schema: dict[str, Any] = {"type": "object", "properties": {}}
    requires_confirmation = False
    category = "network"

    def __init__(self, google_client: GoogleClient) -> None:
        self._client = google_client

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        try:
            authed = await self._client.is_authed()
        except Exception as e:
            return ToolResult(ok=False, error=f"status check failed: {e}")

        if not authed:
            return ToolResult(
                ok=True,
                output="Google não está conectado.",
                metadata={"authed": False},
            )

        email: Optional[str] = None
        try:
            profile = await self._client.get_profile()
            email = profile.get("emailAddress")
        except Exception:
            pass

        bundle = await self._client.get_bundle()
        scopes = list(bundle.scopes) if bundle else []
        return ToolResult(
            ok=True,
            output=f"Conectado ao Google como {email or '(email indisponível)'}",
            metadata={
                "authed": True,
                "email": email,
                "scopes": scopes,
                "expires_at": bundle.expires_at.isoformat() if bundle else None,
            },
        )


class CalendarListEventsTool(Tool):
    name = "calendar_list_events"
    description = (
        "List events from the user's primary Google Calendar in a given "
        "time window. Use this for questions like 'qual minha próxima "
        "reunião?', 'tenho algo amanhã?', 'o que tenho essa semana?'. "
        "If time_min/time_max are omitted, defaults to now → +7 days. "
        "Accepts an optional free-text query 'q' for searching by title "
        "or attendee."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "time_min": {
                "type": "string",
                "description": (
                    "ISO-8601 start of the window (inclusive). Defaults to now."
                ),
            },
            "time_max": {
                "type": "string",
                "description": (
                    "ISO-8601 end of the window (exclusive). Defaults to "
                    "time_min + 7 days."
                ),
            },
            "q": {
                "type": "string",
                "description": "Optional free-text query (title, attendee, etc).",
            },
            "max_results": {
                "type": "integer",
                "description": "Max events to return (default 20, max 100).",
            },
        },
    }
    requires_confirmation = False
    category = "network"

    def __init__(self, google_client: GoogleClient) -> None:
        self._client = google_client

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        try:
            if not await self._client.is_authed():
                return _not_authed_result()
        except Exception as e:
            return ToolResult(ok=False, error=f"auth check failed: {e}")

        try:
            time_min = (
                _parse_iso(str(args["time_min"]))
                if args.get("time_min")
                else datetime.now(timezone.utc)
            )
            time_max = (
                _parse_iso(str(args["time_max"]))
                if args.get("time_max")
                else time_min + timedelta(days=7)
            )
        except ValueError as e:
            return ToolResult(ok=False, error=f"invalid datetime: {e}")

        max_results = int(args.get("max_results") or 20)
        max_results = max(1, min(max_results, 100))
        q = args.get("q") or None

        try:
            events = await self._client.list_events(
                time_min=time_min,
                time_max=time_max,
                q=q,
                max_results=max_results,
            )
        except GoogleAuthError:
            return _not_authed_result()
        except Exception as e:
            return ToolResult(ok=False, error=f"calendar list failed: {e}")

        if not events:
            return ToolResult(
                ok=True,
                output="Nenhum evento nesse período.",
                metadata={"count": 0, "events": []},
            )

        lines: list[str] = []
        for ev in events:
            summary = ev.get("summary", "(sem título)")
            start = (ev.get("start") or {}).get("dateTime") or (
                ev.get("start") or {}
            ).get("date", "")
            end = (ev.get("end") or {}).get("dateTime") or (
                ev.get("end") or {}
            ).get("date", "")
            loc = ev.get("location")
            line = f"- {summary} | {start} → {end}"
            if loc:
                line += f" | {loc}"
            lines.append(line)

        return ToolResult(
            ok=True,
            output="\n".join(lines),
            metadata={"count": len(events), "events": events},
        )


class GmailListImportantTool(Tool):
    name = "gmail_list_important"
    description = (
        "List the user's important unread Gmail messages (equivalent to "
        "Gmail's 'is:important is:unread' filter). Use this when the user "
        "asks 'tem algum email novo importante?' or wants a triage of "
        "their inbox. Returns subject, sender, snippet, and date per row."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "max_results": {
                "type": "integer",
                "description": "Max messages to return (default 20, max 50).",
            }
        },
    }
    requires_confirmation = False
    category = "network"

    def __init__(self, google_client: GoogleClient) -> None:
        self._client = google_client

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        try:
            if not await self._client.is_authed():
                return _not_authed_result()
        except Exception as e:
            return ToolResult(ok=False, error=f"auth check failed: {e}")

        max_results = int(args.get("max_results") or 20)
        max_results = max(1, min(max_results, 50))

        try:
            msgs = await self._client.list_important_unread(max_results=max_results)
        except GoogleAuthError:
            return _not_authed_result()
        except Exception as e:
            return ToolResult(ok=False, error=f"gmail list failed: {e}")

        if not msgs:
            return ToolResult(
                ok=True,
                output="Sem emails importantes no momento.",
                metadata={"count": 0, "messages": []},
            )

        lines: list[str] = []
        for m in msgs:
            subject = m.get("subject") or "(sem assunto)"
            frm = m.get("from") or ""
            snippet = (m.get("snippet") or "").strip()
            if len(snippet) > 120:
                snippet = snippet[:120] + "…"
            lines.append(f"- {subject} — {frm}\n  {snippet}")

        return ToolResult(
            ok=True,
            output="\n".join(lines),
            metadata={"count": len(msgs), "messages": msgs},
        )


class GmailReadMessageTool(Tool):
    name = "gmail_read_message"
    description = (
        "Fetch the full body of a single Gmail message by its ID. Use "
        "this after gmail_list_important when the user wants to read, "
        "reply to, or discuss a specific email. Returns decoded body "
        "(text/plain preferred, then text/html), headers, and any "
        "attachment metadata."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "message_id": {
                "type": "string",
                "description": "Gmail message ID (from gmail_list_important).",
            }
        },
        "required": ["message_id"],
    }
    requires_confirmation = False
    category = "network"

    def __init__(self, google_client: GoogleClient) -> None:
        self._client = google_client

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        message_id = str(args.get("message_id") or "").strip()
        if not message_id:
            return ToolResult(ok=False, error="message_id is required")

        try:
            if not await self._client.is_authed():
                return _not_authed_result()
        except Exception as e:
            return ToolResult(ok=False, error=f"auth check failed: {e}")

        try:
            msg = await self._client.get_message(message_id)
        except GoogleAuthError:
            return _not_authed_result()
        except Exception as e:
            return ToolResult(ok=False, error=f"gmail read failed: {e}")

        subject = msg.get("subject") or "(sem assunto)"
        frm = msg.get("from") or ""
        date = msg.get("date") or ""
        body = msg.get("body") or ""
        output = (
            f"De: {frm}\n"
            f"Assunto: {subject}\n"
            f"Data: {date}\n"
            f"\n{body}"
        )
        return ToolResult(ok=True, output=output, metadata={"message": msg})


# ----------------------------------------------------------------------
# Phase B — write tools (behind the approval gate)
# ----------------------------------------------------------------------


def _coerce_attendees(raw: Any) -> list[str]:
    if raw is None:
        return []
    if isinstance(raw, str):
        return [raw] if raw else []
    if isinstance(raw, (list, tuple)):
        return [str(a) for a in raw if a]
    raise ValueError("attendees must be a string or list of strings")


class CalendarCreateEventTool(Tool):
    name = "calendar_create_event"
    description = (
        "Create a new event on the user's Google Calendar. Requires user "
        "approval via the confirmation gate. Use this for 'marca uma "
        "reunião amanhã às 15h' and similar scheduling requests. Times "
        "are ISO-8601; attendees are a list of email addresses."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "summary": {"type": "string", "description": "Event title."},
            "start": {
                "type": "string",
                "description": "ISO-8601 start datetime (with timezone).",
            },
            "end": {
                "type": "string",
                "description": "ISO-8601 end datetime (with timezone).",
            },
            "description": {"type": "string"},
            "location": {"type": "string"},
            "attendees": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Attendee email addresses.",
            },
            "calendar_id": {
                "type": "string",
                "description": "Target calendar id (default 'primary').",
            },
        },
        "required": ["summary", "start", "end"],
    }
    requires_confirmation = True
    category = "network"

    def __init__(self, google_client: GoogleClient) -> None:
        self._client = google_client

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        summary = str(args.get("summary") or "").strip()
        start_raw = str(args.get("start") or "").strip()
        end_raw = str(args.get("end") or "").strip()
        if not summary:
            return ToolResult(ok=False, error="summary is required")
        if not start_raw or not end_raw:
            return ToolResult(ok=False, error="start and end are required")

        try:
            start = _parse_iso(start_raw)
            end = _parse_iso(end_raw)
        except ValueError as e:
            return ToolResult(ok=False, error=f"invalid datetime: {e}")

        try:
            attendees = _coerce_attendees(args.get("attendees"))
        except ValueError as e:
            return ToolResult(ok=False, error=str(e))

        calendar_id = str(args.get("calendar_id") or "primary")

        body: dict[str, Any] = {
            "summary": summary,
            "start": {"dateTime": _rfc3339(start)},
            "end": {"dateTime": _rfc3339(end)},
        }
        description = args.get("description")
        if description is not None:
            body["description"] = str(description)
        location = args.get("location")
        if location is not None:
            body["location"] = str(location)
        if attendees:
            body["attendees"] = [{"email": a} for a in attendees]

        url = f"{CALENDAR_API}/calendars/{calendar_id}/events"
        try:
            if not await self._client.is_authed():
                return _not_authed_result()
            resp = await self._client._authed_request("POST", url, json=body)
        except GoogleAuthError:
            return _not_authed_result()
        except Exception as e:
            return ToolResult(ok=False, error=f"calendar create failed: {e}")

        event = resp.json()
        event_id = event.get("id")
        html_link = event.get("htmlLink")
        return ToolResult(
            ok=True,
            output=f"Evento criado: {summary} (id={event_id})",
            metadata={
                "event_id": event_id,
                "htmlLink": html_link,
                "event": event,
            },
        )


class CalendarUpdateEventTool(Tool):
    name = "calendar_update_event"
    description = (
        "PATCH an existing Google Calendar event. Only the fields you "
        "pass are modified; omitted fields are left alone. Requires user "
        "approval via the confirmation gate."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "event_id": {"type": "string"},
            "calendar_id": {
                "type": "string",
                "description": "Target calendar id (default 'primary').",
            },
            "summary": {"type": "string"},
            "start": {
                "type": "string",
                "description": "ISO-8601 start datetime (with timezone).",
            },
            "end": {
                "type": "string",
                "description": "ISO-8601 end datetime (with timezone).",
            },
            "description": {"type": "string"},
            "location": {"type": "string"},
            "attendees": {
                "type": "array",
                "items": {"type": "string"},
            },
        },
        "required": ["event_id"],
    }
    requires_confirmation = True
    category = "network"

    def __init__(self, google_client: GoogleClient) -> None:
        self._client = google_client

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        event_id = str(args.get("event_id") or "").strip()
        if not event_id:
            return ToolResult(ok=False, error="event_id is required")
        calendar_id = str(args.get("calendar_id") or "primary")

        body: dict[str, Any] = {}
        if "summary" in args and args["summary"] is not None:
            body["summary"] = str(args["summary"])
        if "description" in args and args["description"] is not None:
            body["description"] = str(args["description"])
        if "location" in args and args["location"] is not None:
            body["location"] = str(args["location"])
        if "start" in args and args["start"] is not None:
            try:
                body["start"] = {"dateTime": _rfc3339(_parse_iso(str(args["start"])))}
            except ValueError as e:
                return ToolResult(ok=False, error=f"invalid start: {e}")
        if "end" in args and args["end"] is not None:
            try:
                body["end"] = {"dateTime": _rfc3339(_parse_iso(str(args["end"])))}
            except ValueError as e:
                return ToolResult(ok=False, error=f"invalid end: {e}")
        if "attendees" in args and args["attendees"] is not None:
            try:
                attendees = _coerce_attendees(args["attendees"])
            except ValueError as e:
                return ToolResult(ok=False, error=str(e))
            body["attendees"] = [{"email": a} for a in attendees]

        if not body:
            return ToolResult(
                ok=False,
                error="no fields to update (pass summary/start/end/description/location/attendees)",
            )

        url = f"{CALENDAR_API}/calendars/{calendar_id}/events/{event_id}"
        try:
            if not await self._client.is_authed():
                return _not_authed_result()
            resp = await self._client._authed_request("PATCH", url, json=body)
        except GoogleAuthError:
            return _not_authed_result()
        except Exception as e:
            return ToolResult(ok=False, error=f"calendar update failed: {e}")

        event = resp.json()
        return ToolResult(
            ok=True,
            output=f"Evento {event_id} atualizado.",
            metadata={
                "event_id": event.get("id") or event_id,
                "htmlLink": event.get("htmlLink"),
                "event": event,
            },
        )


class CalendarDeleteEventTool(Tool):
    name = "calendar_delete_event"
    description = (
        "Delete a Google Calendar event by id. Requires user approval "
        "via the confirmation gate."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "event_id": {"type": "string"},
            "calendar_id": {
                "type": "string",
                "description": "Target calendar id (default 'primary').",
            },
        },
        "required": ["event_id"],
    }
    requires_confirmation = True
    category = "network"

    def __init__(self, google_client: GoogleClient) -> None:
        self._client = google_client

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        event_id = str(args.get("event_id") or "").strip()
        if not event_id:
            return ToolResult(ok=False, error="event_id is required")
        calendar_id = str(args.get("calendar_id") or "primary")

        url = f"{CALENDAR_API}/calendars/{calendar_id}/events/{event_id}"
        try:
            if not await self._client.is_authed():
                return _not_authed_result()
            await self._client._authed_request("DELETE", url)
        except GoogleAuthError:
            return _not_authed_result()
        except Exception as e:
            return ToolResult(ok=False, error=f"calendar delete failed: {e}")

        return ToolResult(
            ok=True,
            output=f"Evento {event_id} deletado.",
            metadata={"ok": True, "event_id": event_id},
        )


class GmailSendMessageTool(Tool):
    name = "gmail_send_message"
    description = (
        "Send a plain-text email via the user's Gmail account. Requires "
        "user approval via the confirmation gate. If "
        "`in_reply_to_message_id` is provided, the message is threaded as "
        "a reply using Gmail's threadId and RFC 2822 In-Reply-To / "
        "References headers."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "to": {
                "oneOf": [
                    {"type": "string"},
                    {"type": "array", "items": {"type": "string"}},
                ],
                "description": "Recipient email or list of emails.",
            },
            "subject": {"type": "string"},
            "body": {"type": "string", "description": "Plain-text body."},
            "cc": {
                "oneOf": [
                    {"type": "string"},
                    {"type": "array", "items": {"type": "string"}},
                ],
            },
            "bcc": {
                "oneOf": [
                    {"type": "string"},
                    {"type": "array", "items": {"type": "string"}},
                ],
            },
            "in_reply_to_message_id": {
                "type": "string",
                "description": (
                    "Gmail message id to reply to. When set, the tool "
                    "looks up the original Message-Id header and threadId "
                    "so the reply threads correctly."
                ),
            },
        },
        "required": ["to", "subject", "body"],
    }
    requires_confirmation = True
    category = "network"

    def __init__(self, google_client: GoogleClient) -> None:
        self._client = google_client

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        subject = str(args.get("subject") or "").strip()
        body_text = args.get("body")
        if not subject:
            return ToolResult(ok=False, error="subject is required")
        if body_text is None or str(body_text) == "":
            return ToolResult(ok=False, error="body is required")

        try:
            to_list = _coerce_attendees(args.get("to"))
            cc_list = _coerce_attendees(args.get("cc"))
            bcc_list = _coerce_attendees(args.get("bcc"))
        except ValueError as e:
            return ToolResult(ok=False, error=str(e))
        if not to_list:
            return ToolResult(ok=False, error="to is required")

        try:
            if not await self._client.is_authed():
                return _not_authed_result()
        except Exception as e:
            return ToolResult(ok=False, error=f"auth check failed: {e}")

        # Best-effort lookup of the sender address for the From header.
        from_addr: Optional[str] = None
        try:
            profile = await self._client.get_profile()
            from_addr = profile.get("emailAddress")
        except Exception:
            from_addr = None

        # Resolve reply metadata if requested.
        thread_id: Optional[str] = None
        reply_msgid: Optional[str] = None
        combined_refs: Optional[str] = None
        reply_ref: Optional[str] = args.get("in_reply_to_message_id")
        if reply_ref:
            try:
                detail_url = f"{GMAIL_API}/users/me/messages/{reply_ref}"
                resp = await self._client._authed_request(
                    "GET",
                    detail_url,
                    params={
                        "format": "metadata",
                        "metadataHeaders": ["Message-Id", "References"],
                    },
                )
                raw = resp.json()
                thread_id = raw.get("threadId")
                headers = {
                    (h.get("name") or "").lower(): h.get("value", "")
                    for h in (raw.get("payload") or {}).get("headers", [])
                }
                reply_msgid = headers.get("message-id") or None
                prior_refs = headers.get("references") or ""
                if reply_msgid:
                    combined_refs = (
                        f"{prior_refs} {reply_msgid}".strip()
                        if prior_refs
                        else reply_msgid
                    )
            except GoogleAuthError:
                return _not_authed_result()
            except Exception as e:
                return ToolResult(
                    ok=False, error=f"failed to resolve reply target: {e}"
                )

        msg = MIMEText(str(body_text), _subtype="plain", _charset="utf-8")
        msg["To"] = ", ".join(to_list)
        if cc_list:
            msg["Cc"] = ", ".join(cc_list)
        if bcc_list:
            msg["Bcc"] = ", ".join(bcc_list)
        if from_addr:
            msg["From"] = from_addr
        msg["Subject"] = subject
        if reply_msgid:
            msg["In-Reply-To"] = reply_msgid
        if combined_refs:
            msg["References"] = combined_refs

        raw_bytes = msg.as_bytes()
        raw_b64 = base64.urlsafe_b64encode(raw_bytes).decode("ascii")

        payload: dict[str, Any] = {"raw": raw_b64}
        if thread_id:
            payload["threadId"] = thread_id

        send_url = f"{GMAIL_API}/users/me/messages/send"
        try:
            resp = await self._client._authed_request("POST", send_url, json=payload)
        except GoogleAuthError:
            return _not_authed_result()
        except Exception as e:
            return ToolResult(ok=False, error=f"gmail send failed: {e}")

        sent = resp.json()
        message_id = sent.get("id")
        returned_thread = sent.get("threadId")
        return ToolResult(
            ok=True,
            output=f"Email enviado para {', '.join(to_list)} (id={message_id}).",
            metadata={
                "message_id": message_id,
                "thread_id": returned_thread,
            },
        )
