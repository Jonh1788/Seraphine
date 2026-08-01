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

import asyncio
import base64
import logging
import mimetypes
from datetime import datetime, timedelta, timezone
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email import encoders
from pathlib import Path
from typing import Any, Optional

from google_integration.client import (
    CALENDAR_API,
    GMAIL_API,
    GoogleAuthError,
    GoogleClient,
    _rfc3339,
)
from seraphine.tools.base import Tool, ToolResult

logger = logging.getLogger(__name__)


def _path_under_allowed_roots(path: Path, roots: list[Path]) -> bool:
    """Mirror filesystem.py: resolve then check relative_to each root."""
    try:
        resolved = path.resolve()
    except Exception:
        return False
    for r in roots:
        try:
            resolved.relative_to(r.resolve())
            return True
        except ValueError:
            continue
    return False


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
        "or attendee. Each row in the output is prefixed with "
        "'event_id=<id>' — pass that id verbatim to calendar_delete_event "
        "or calendar_update_event when the user asks to cancel or edit a "
        "specific event from the list."
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
            ev_id = ev.get("id", "")
            summary = ev.get("summary", "(sem título)")
            start = (ev.get("start") or {}).get("dateTime") or (
                ev.get("start") or {}
            ).get("date", "")
            end = (ev.get("end") or {}).get("dateTime") or (
                ev.get("end") or {}
            ).get("date", "")
            loc = ev.get("location")
            # Include event_id FIRST so the model can pass it verbatim to
            # calendar_delete_event / calendar_update_event. Format is
            # `event_id=<id> | summary | start → end [| location]` so the
            # model can parse it structurally even in a bulk listing.
            line = f"event_id={ev_id} | {summary} | {start} → {end}"
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
        "List the user's Gmail messages with optional filters. "
        "Searches ALL emails (read and unread) by default. "
        "Use this when the user asks about emails. "
        "IMPORTANT: When the user asks for 'emails de hoje' or 'emails do dia', "
        "always include 'newer_than:1d' in the query. "
        "For attachments: use 'has:attachment newer_than:1d'. "
        "Examples: query='newer_than:1d' for today's emails (read+unread), "
        "query='is:unread' for unread only, "
        "query='has:attachment newer_than:1d' for today's with attachments."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": (
                    "Gmail search query. Default: 'newer_than:1d' (today, read+unread). "
                    "Use Gmail operators: 'newer_than:1d', 'after:2026/04/13', "
                    "'from:someone', 'subject:keyword', 'is:unread', 'is:important', "
                    "'has:attachment'. Do NOT add 'is:unread' unless user specifically "
                    "asks for unread only."
                ),
            },
            "max_results": {
                "type": "integer",
                "description": "Max messages to return (default 20, max 50).",
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

        max_results = int(args.get("max_results") or 20)
        max_results = max(1, min(max_results, 50))

        query = str(args.get("query") or "newer_than:1d")

        try:
            msgs = await self._client.list_messages(q=query, max_results=max_results)
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
        for i, m in enumerate(msgs, 1):
            msg_id = m.get("id") or ""
            subject = m.get("subject") or "(sem assunto)"
            frm = m.get("from") or ""
            date = m.get("date") or ""
            snippet = (m.get("snippet") or "").strip()
            if len(snippet) > 120:
                snippet = snippet[:120] + "…"
            has_attach = " 📎" if m.get("attachments") else ""
            lines.append(
                f"{i}. {subject}{has_attach}\n"
                f"   De: {frm}\n"
                f"   Data: {date}\n"
                f"   message_id: {msg_id}\n"
                f"   {snippet}"
            )

        return ToolResult(
            ok=True,
            output=(
                f"{len(msgs)} email(s) encontrado(s):\n\n"
                + "\n\n".join(lines)
                + "\n\nPara ler um email completo, use gmail_read_message com o message_id acima."
            ),
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
        attachments = msg.get("attachments") or []

        output = (
            f"De: {frm}\n"
            f"Assunto: {subject}\n"
            f"Data: {date}\n"
            f"message_id: {message_id}\n"
        )

        if attachments:
            output += f"\nAnexos ({len(attachments)}):\n"
            for att in attachments:
                output += (
                    f"  - {att.get('filename', '?')} "
                    f"({att.get('mimeType', '?')}, {att.get('size', 0)} bytes)\n"
                    f"    attachment_id: {att.get('attachmentId', '')}\n"
                )
            output += (
                "\nPara baixar um anexo, use gmail_download_attachment "
                f"com message_id='{message_id}' e o attachment_id acima.\n"
            )
        else:
            output += "\nSem anexos.\n"

        output += f"\n{body}"
        return ToolResult(ok=True, output=output, metadata={"message": msg})


class GmailDownloadAttachmentTool(Tool):
    """Download a Gmail attachment and save to a temp file for processing."""

    name = "gmail_download_attachment"
    description = (
        "Download a PDF or file attachment from a Gmail message and save it locally. "
        "Use AFTER gmail_read_message when you see attachments and need to process them "
        "(e.g., import a bank statement PDF into the financial system). "
        "Returns the local file path that can be passed to import_financial_pdf. "
        "Triggers: 'baixa o anexo', 'importa o PDF do email', 'pega o extrato do email'."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "message_id": {
                "type": "string",
                "description": "Gmail message ID (from gmail_list_important or gmail_read_message metadata).",
            },
            "attachment_id": {
                "type": "string",
                "description": "Attachment ID from the message's attachments list.",
            },
            "filename": {
                "type": "string",
                "description": "Original filename of the attachment (for the temp file extension).",
            },
        },
        "required": ["message_id", "attachment_id"],
    }
    requires_confirmation = False
    category: Any = "network"

    def __init__(self, google_client: "GoogleClient") -> None:
        self._client = google_client

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        try:
            if not await self._client.is_authed():
                return _not_authed_result()
        except Exception as e:
            return ToolResult(ok=False, error=f"auth check failed: {e}")

        message_id = args.get("message_id", "")
        attachment_id = args.get("attachment_id", "")
        filename = args.get("filename", "attachment.pdf")

        if not message_id or not attachment_id:
            return ToolResult(ok=False, error="message_id and attachment_id are required.")

        try:
            data = await self._client.download_attachment(message_id, attachment_id)
        except Exception as e:
            return ToolResult(ok=False, error=f"Failed to download attachment: {e}")

        # Save to temp file
        import os
        import tempfile

        ext = os.path.splitext(filename)[1] or ".pdf"
        fd, tmp_path = tempfile.mkstemp(suffix=ext)
        os.write(fd, data)
        os.close(fd)

        return ToolResult(
            ok=True,
            output=(
                f"Attachment '{filename}' downloaded ({len(data)} bytes) → {tmp_path}\n\n"
                f"Para importar como extrato financeiro, use a tool import_financial_pdf "
                f"com file_path='{tmp_path}'. Se o PDF tiver senha, pergunte ao usuario."
            ),
            metadata={
                "file_path": tmp_path,
                "filename": filename,
                "size": len(data),
            },
        )


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

        description = args.get("description")
        location = args.get("location")

        # UM caminho de escrita, compartilhado com POST /google/calendar/events.
        # Este método montava o corpo e chamava `_authed_request` na mão — uma
        # segunda cópia de `client.create_event`, que já existia e já invalida o
        # cache. Duas implementações da mesma escrita divergem com o tempo: a
        # rota precisou de `date` para dia inteiro, e só uma das cópias teria
        # ganhado isso.
        try:
            if not await self._client.is_authed():
                return _not_authed_result()
            event = await self._client.create_event(
                summary=summary,
                start=start,
                end=end,
                description=str(description) if description is not None else None,
                location=str(location) if location is not None else None,
                attendees=attendees or None,
                calendar_id=calendar_id,
            )
        except GoogleAuthError:
            return _not_authed_result()
        except Exception as e:
            return ToolResult(ok=False, error=f"calendar create failed: {e}")

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
        try:
            self._client.event_cache.invalidate_calendar(calendar_id)
        except Exception:
            pass
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

        try:
            self._client.event_cache.invalidate_calendar(calendar_id)
        except Exception:
            pass
        return ToolResult(
            ok=True,
            output=f"Evento {event_id} deletado.",
            metadata={"ok": True, "event_id": event_id},
        )


class CalendarBulkDeleteEventsTool(Tool):
    name = "calendar_bulk_delete_events"
    description = (
        "Delete MANY Google Calendar events in a single batch. Accepts a "
        "list of event_ids and fires all DELETE requests in parallel "
        "server-side. Use this instead of calling calendar_delete_event "
        "repeatedly when the user asks to wipe a group of events (e.g. "
        "'delete all my Aula events', 'cancel all events from last week'). "
        "Gets ONE approval from the user for the whole batch instead of N "
        "separate confirmations. Get the ids first by calling "
        "calendar_list_events — each row starts with 'event_id=<id>'."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "event_ids": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "List of Calendar event ids to delete. Minimum 1, "
                    "maximum 200 per call."
                ),
            },
            "calendar_id": {
                "type": "string",
                "description": "Target calendar id (default 'primary').",
            },
        },
        "required": ["event_ids"],
    }
    requires_confirmation = True
    category = "network"

    # Upper bound to avoid 1000-item runaway. Google rate limits ~10 r/s
    # per user so 200 also caps wall time at ~20s.
    _MAX_IDS = 200

    def __init__(self, google_client: GoogleClient) -> None:
        self._client = google_client

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        raw = args.get("event_ids") or []
        if not isinstance(raw, list):
            return ToolResult(ok=False, error="event_ids must be a list")
        event_ids = [str(eid).strip() for eid in raw if str(eid).strip()]
        if not event_ids:
            return ToolResult(ok=False, error="event_ids is empty")
        if len(event_ids) > self._MAX_IDS:
            return ToolResult(
                ok=False,
                error=f"too many event_ids ({len(event_ids)} > {self._MAX_IDS})",
            )
        calendar_id = str(args.get("calendar_id") or "primary")

        try:
            if not await self._client.is_authed():
                return _not_authed_result()
        except Exception as e:
            return ToolResult(ok=False, error=f"auth check failed: {e}")

        async def _delete_one(eid: str) -> tuple[str, bool, str | None]:
            url = f"{CALENDAR_API}/calendars/{calendar_id}/events/{eid}"
            try:
                resp = await self._client._authed_request("DELETE", url)
                # Google returns 204 No Content on success; 410 Gone is
                # acceptable too (already-deleted / cancelled).
                if resp.status_code in (204, 200, 410):
                    return eid, True, None
                return eid, False, f"HTTP {resp.status_code}"
            except GoogleAuthError as e:
                return eid, False, f"auth: {e}"
            except Exception as e:
                return eid, False, str(e)

        # Fire all deletes in parallel. Google's per-user quota is ~10 r/s;
        # asyncio.gather means we submit them all at once and let httpx
        # connection pooling handle the concurrency. Typical 100-item
        # delete completes in under 5 seconds.
        results = await asyncio.gather(*(_delete_one(eid) for eid in event_ids))

        # Invalidate cache for this calendar after bulk mutation.
        try:
            self._client.event_cache.invalidate_calendar(calendar_id)
        except Exception:
            pass

        deleted = [eid for eid, ok, _ in results if ok]
        failed = [(eid, err) for eid, ok, err in results if not ok]

        if not failed:
            return ToolResult(
                ok=True,
                output=f"Deletados {len(deleted)} de {len(event_ids)} eventos.",
                metadata={
                    "deleted_count": len(deleted),
                    "deleted_ids": deleted,
                    "failed": [],
                },
            )

        # Partial or total failure — surface the first few error reasons
        # so the model can explain to the user.
        failure_sample = "; ".join(f"{eid[:12]}…={err}" for eid, err in failed[:3])
        return ToolResult(
            ok=len(deleted) > 0,
            output=(
                f"Deletados {len(deleted)} de {len(event_ids)} eventos. "
                f"Falharam {len(failed)}. Exemplos: {failure_sample}"
            ),
            error=None if deleted else "all deletes failed",
            metadata={
                "deleted_count": len(deleted),
                "deleted_ids": deleted,
                "failed": [{"event_id": eid, "error": err} for eid, err in failed],
            },
        )


class GmailSendMessageTool(Tool):
    name = "gmail_send_message"
    description = (
        "Send a plain-text email via the user's Gmail account. Requires "
        "user approval via the confirmation gate. If "
        "`in_reply_to_message_id` is provided, the message is threaded as "
        "a reply using Gmail's threadId and RFC 5322 In-Reply-To / "
        "References headers. Optional `attachments` is a list of "
        "{path, mime_type?} objects; files must reside under the "
        "configured allowed_tool_roots for safety."
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
                    "so the reply threads correctly. If the lookup fails "
                    "(404, permissions, etc.) the tool falls back to a "
                    "plain (unthreaded) send and logs a warning."
                ),
            },
            "attachments": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": (
                                "Absolute path to the file. Must be under "
                                "the configured allowed_tool_roots."
                            ),
                        },
                        "mime_type": {
                            "type": "string",
                            "description": (
                                "Optional MIME type; guessed from the "
                                "filename if omitted, fallback "
                                "application/octet-stream."
                            ),
                        },
                    },
                    "required": ["path"],
                },
                "description": "Optional list of file attachments.",
            },
        },
        "required": ["to", "subject", "body"],
    }
    requires_confirmation = True
    category = "network"

    def __init__(
        self,
        google_client: GoogleClient,
        allowed_roots: list[Path] | None = None,
    ) -> None:
        self._client = google_client
        self._allowed_roots: list[Path] = (
            [Path(r) for r in allowed_roots] if allowed_roots else []
        )

    async def _resolve_reply_headers(
        self, reply_ref: str
    ) -> tuple[Optional[str], Optional[str], Optional[str]]:
        """Return ``(thread_id, reply_msgid, combined_refs)``.

        On any non-auth failure (404, permissions, parse errors) returns
        ``(None, None, None)`` and logs a warning so the caller falls
        back to a plain send. A ``GoogleAuthError`` is re-raised so the
        caller can surface an un-authed hint to the user.
        """
        detail_url = f"{GMAIL_API}/users/me/messages/{reply_ref}"
        try:
            resp = await self._client._authed_request(
                "GET",
                detail_url,
                params={
                    "format": "metadata",
                    "metadataHeaders": ["Message-Id", "References"],
                },
            )
        except GoogleAuthError:
            raise
        except Exception as e:
            logger.warning(
                "gmail_send_message: failed to fetch reply target %s, "
                "falling back to plain send: %s",
                reply_ref, e,
            )
            return (None, None, None)

        raw = resp.json()
        thread_id = raw.get("threadId")
        headers = {
            (h.get("name") or "").lower(): h.get("value", "")
            for h in (raw.get("payload") or {}).get("headers", [])
        }
        reply_msgid = headers.get("message-id") or None
        prior_refs = (headers.get("references") or "").strip()

        combined_refs: Optional[str] = None
        if reply_msgid:
            # RFC 5322 §3.6.4: References is the original References list
            # with the parent's Message-Id appended. If the original had
            # no References, the new References is just <parent-msgid>.
            combined_refs = (
                f"{prior_refs} {reply_msgid}" if prior_refs else reply_msgid
            )
        return (thread_id, reply_msgid, combined_refs)

    def _load_attachment(
        self, spec: Any
    ) -> tuple[Optional[MIMEBase], Optional[str]]:
        """Read + build a MIME part for one attachment spec. Returns
        ``(part, None)`` on success, ``(None, error_message)`` on failure."""
        if not isinstance(spec, dict):
            return (None, "attachment entries must be objects with a 'path' key")
        raw_path = spec.get("path")
        if not raw_path or not isinstance(raw_path, str):
            return (None, "attachment 'path' is required")

        path = Path(raw_path).expanduser()
        if not self._allowed_roots:
            return (
                None,
                "attachments are disabled: no allowed_tool_roots configured",
            )
        if not _path_under_allowed_roots(path, self._allowed_roots):
            return (None, f"attachment path not under allowed roots: {raw_path}")
        if not path.exists() or not path.is_file():
            return (None, f"attachment not found: {raw_path}")

        try:
            data = path.read_bytes()
        except Exception as e:
            return (None, f"failed to read attachment {raw_path}: {e}")

        mime_type = spec.get("mime_type")
        if not mime_type:
            guessed, _ = mimetypes.guess_type(path.name)
            mime_type = guessed or "application/octet-stream"
        try:
            maintype, subtype = mime_type.split("/", 1)
        except ValueError:
            maintype, subtype = "application", "octet-stream"

        part = MIMEBase(maintype, subtype)
        part.set_payload(data)
        encoders.encode_base64(part)
        part.add_header(
            "Content-Disposition",
            "attachment",
            filename=path.name,
        )
        return (part, None)

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

        # Validate + load attachments eagerly so we fail *before* any
        # Google API call if the user passed a bad path.
        raw_attachments = args.get("attachments") or []
        if raw_attachments and not isinstance(raw_attachments, (list, tuple)):
            return ToolResult(
                ok=False, error="attachments must be a list of {path, mime_type?}"
            )
        attachment_parts: list[MIMEBase] = []
        for spec in raw_attachments:
            part, err = self._load_attachment(spec)
            if err is not None:
                return ToolResult(ok=False, error=err)
            assert part is not None
            attachment_parts.append(part)

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

        # Resolve reply metadata if requested. A failed fetch degrades
        # gracefully to a plain (unthreaded) send.
        thread_id: Optional[str] = None
        reply_msgid: Optional[str] = None
        combined_refs: Optional[str] = None
        reply_ref: Optional[str] = args.get("in_reply_to_message_id")
        if reply_ref:
            try:
                thread_id, reply_msgid, combined_refs = (
                    await self._resolve_reply_headers(reply_ref)
                )
            except GoogleAuthError:
                return _not_authed_result()

        # Build the MIME payload. We always use multipart/mixed when
        # there are attachments; otherwise a single text/plain part
        # keeps the wire shape identical to the pre-Phase-C behavior
        # (and keeps existing tests passing).
        msg: Any
        if attachment_parts:
            msg = MIMEMultipart("mixed")
            msg.attach(MIMEText(str(body_text), _subtype="plain", _charset="utf-8"))
            for part in attachment_parts:
                msg.attach(part)
        else:
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
                "attachments_count": len(attachment_parts),
            },
        )
