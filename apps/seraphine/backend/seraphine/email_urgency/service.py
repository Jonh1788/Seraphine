"""Background email urgency scanner → WhatsApp push.

Lists new unread Gmail, classifies each unseen message's urgency with the
anti-manipulation triage prompt, records it (so each message is classified
once), and sends a WhatsApp push for ``high``-urgency mail only — with a
deep-link to the inbox at that message. Respects quiet hours.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

from .triage import classify_urgency

logger = logging.getLogger(__name__)

_SP = ZoneInfo("America/Sao_Paulo")
_QUERY = "is:unread newer_than:1d"
_MAX = 25


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _short_from(sender: str) -> str:
    """Human display name from a 'Name <email>' header."""
    if not sender:
        return "desconhecido"
    return sender.split("<")[0].strip() or sender


class EmailUrgencyService:
    def __init__(
        self,
        *,
        store: Any,
        google_client: Any,
        llm: Any,
        whatsapp_client: Any,
        owner_chat_id: str,
        public_url: str,
        quiet_start: str,
        quiet_end: str,
    ) -> None:
        self._store = store
        self._google = google_client
        self._llm = llm
        self._whatsapp = whatsapp_client
        self._owner_chat_id = (owner_chat_id or "").strip()
        self._public_url = (public_url or "").rstrip("/")
        self._quiet_start = (quiet_start or "").strip()
        self._quiet_end = (quiet_end or "").strip()

    # -- time (overridable in tests) -----------------------------------
    def _now_sp(self) -> datetime:
        return datetime.now(_SP)

    def _in_quiet_hours(self, now: datetime) -> bool:
        start, end = self._quiet_start, self._quiet_end
        if not start or not end or start == end:
            return False
        hhmm = now.strftime("%H:%M")
        if start <= end:
            return start <= hhmm < end
        # window wraps midnight (e.g. 22:00 → 07:00)
        return hhmm >= start or hhmm < end

    # -- public --------------------------------------------------------
    async def scan(self) -> int:
        """Scan unread mail, push high-urgency. Returns # of pushes sent."""
        if self._google is None:
            return 0
        if self._in_quiet_hours(self._now_sp()):
            return 0
        try:
            if not await self._google.is_authed():
                return 0
        except Exception:
            logger.warning("email urgency: is_authed check failed", exc_info=True)
            return 0

        try:
            emails = await self._google.list_messages(q=_QUERY, max_results=_MAX)
        except Exception:
            logger.warning("email urgency: list_messages failed", exc_info=True)
            return 0

        seen = await self._seen_ids()
        pushed = 0
        for email in emails or []:
            mid = email.get("id")
            if not mid or mid in seen:
                continue
            sender = email.get("from", "") or ""
            subject = email.get("subject", "") or ""
            snippet = email.get("snippet", "") or ""

            result = await classify_urgency(
                self._llm, sender=sender, subject=subject, snippet=snippet,
            )
            urgency = result["urgency"]
            reason = result["reason"]

            alerted = False
            if urgency == "high":
                alerted = await self._push(mid, sender, subject, reason)

            await self._record(mid, urgency, reason, alerted)
            seen.add(mid)
            if alerted:
                pushed += 1
        return pushed

    # -- helpers -------------------------------------------------------
    async def _push(self, message_id: str, sender: str, subject: str, reason: str) -> bool:
        if self._whatsapp is None or not self._owner_chat_id:
            return False
        text = self._build_message(sender, subject, reason, message_id)
        try:
            await self._whatsapp.send_message(self._owner_chat_id, text)
            logger.info("email urgency: pushed WhatsApp for %s", message_id)
            return True
        except Exception:
            logger.exception("email urgency: whatsapp send failed for %s", message_id)
            return False

    def _build_message(self, sender: str, subject: str, reason: str, message_id: str) -> str:
        name = _short_from(sender)
        subj = (subject or "(sem assunto)").strip()
        link = f"{self._public_url}/?inbox={message_id}"
        lines = [f"\U0001f534 Urgente: {name}", subj]
        if reason:
            lines.append(reason.strip())
        lines.append("")
        lines.append(f"Abrir: {link}")
        return "\n".join(lines)

    async def _seen_ids(self) -> set[str]:
        def _work() -> set[str]:
            with self._store._connect() as conn:
                rows = conn.execute("SELECT message_id FROM email_urgency_seen").fetchall()
            return {r[0] for r in rows}
        try:
            return await asyncio.to_thread(_work)
        except Exception:
            logger.warning("email urgency: seen_ids read failed", exc_info=True)
            return set()

    async def _record(self, message_id: str, urgency: str, reason: str, alerted: bool) -> None:
        def _work() -> None:
            with self._store._connect() as conn:
                conn.execute(
                    "INSERT OR IGNORE INTO email_urgency_seen"
                    "(message_id, urgency, reason, alerted, created_at)"
                    " VALUES (?, ?, ?, ?, ?)",
                    (message_id, urgency, (reason or "")[:300], 1 if alerted else 0, _now_iso()),
                )
        try:
            await asyncio.to_thread(_work)
        except Exception:
            logger.warning("email urgency: record failed", exc_info=True)
