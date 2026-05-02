"""Business-logic layer for the WhatsApp integration.

Implements the user-facing connect dance (verification code send, OTP check,
disconnect, status) on top of the EvolutionClient and the schema migrated by
``aura.whatsapp.schema``. All persistence calls are funneled through
``asyncio.to_thread`` so SQLite work never blocks the event loop.
"""

from __future__ import annotations

import asyncio
import json
import logging
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Protocol

from aura.whatsapp.client import EvolutionClient, EvolutionError
from aura.whatsapp.phone import InvalidPhone, mask_e164, normalize_e164

logger = logging.getLogger(__name__)


VERIFICATION_TTL = timedelta(minutes=5)
VERIFICATION_COOLDOWN = timedelta(seconds=60)
MAX_VERIFICATION_ATTEMPTS = 3


class CooldownError(RuntimeError):
    """Raised when start_verification is called within the cooldown window."""


def _gen_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat()


class _StoreLike(Protocol):
    def _connect(self) -> Any: ...


class WhatsAppService:
    def __init__(
        self,
        *,
        store: _StoreLike,
        client: EvolutionClient,
        code_factory: Callable[[], str] = _gen_code,
        now: Callable[[], datetime] = _utcnow,
    ) -> None:
        self._store = store
        self._client = client
        self._code = code_factory
        self._now = now

    # ------------------------------------------------------------------
    # Verification
    # ------------------------------------------------------------------

    async def start_verification(self, user_id: str, phone_raw: str) -> None:
        """Issue a 6-digit code to ``phone_raw`` for ``user_id``.

        Enforces a 60-second cooldown per user; replaces any existing
        in-flight code so the user always sees the latest one.
        """
        phone = normalize_e164(phone_raw)
        ts = self._now()
        code = self._code()

        def _check_and_upsert() -> None:
            conn = self._store._connect()
            conn.execute("BEGIN IMMEDIATE")
            try:
                row = conn.execute(
                    "SELECT created_at FROM aura_whatsapp_verification"
                    " WHERE user_id = ?",
                    (user_id,),
                ).fetchone()
                if row:
                    last = datetime.fromisoformat(row[0])
                    if ts - last < VERIFICATION_COOLDOWN:
                        raise CooldownError(
                            "aguarde alguns segundos antes de pedir outro código"
                        )
                conn.execute(
                    "INSERT INTO aura_whatsapp_verification"
                    " (user_id, phone_e164, code, expires_at, attempts, created_at)"
                    " VALUES (?, ?, ?, ?, 0, ?)"
                    " ON CONFLICT(user_id) DO UPDATE SET"
                    "   phone_e164 = excluded.phone_e164,"
                    "   code = excluded.code,"
                    "   expires_at = excluded.expires_at,"
                    "   attempts = 0,"
                    "   created_at = excluded.created_at",
                    (
                        user_id, phone, code,
                        _iso(ts + VERIFICATION_TTL), _iso(ts),
                    ),
                )
                conn.commit()
            except Exception:
                conn.rollback()
                raise

        await asyncio.to_thread(_check_and_upsert)

        text = f"Aura: seu código de verificação é {code} (válido por 5 min)."
        try:
            await self._client.send_text(phone, text)
        except EvolutionError:
            # Why: leave the verification row in place even if Evolution's
            # response said "fail". The SMS may still have been delivered;
            # the user can submit the code anyway. The 60s cooldown will
            # block immediate re-issuance — fine, the user can retry shortly.
            logger.exception("verification send failed user=%s", user_id)
            raise

    async def verify(self, user_id: str, code: str) -> bool:
        ts = self._now()

        def _verify() -> bool:
            conn = self._store._connect()
            conn.execute("BEGIN IMMEDIATE")
            try:
                row = conn.execute(
                    "SELECT phone_e164, code, expires_at, attempts"
                    " FROM aura_whatsapp_verification WHERE user_id = ?",
                    (user_id,),
                ).fetchone()
                if not row:
                    conn.commit()
                    return False
                phone, expected, expires_at, attempts = row
                if datetime.fromisoformat(expires_at) <= ts:
                    conn.execute(
                        "DELETE FROM aura_whatsapp_verification WHERE user_id = ?",
                        (user_id,),
                    )
                    conn.commit()
                    return False
                if str(code) != str(expected):
                    new_attempts = (attempts or 0) + 1
                    if new_attempts >= MAX_VERIFICATION_ATTEMPTS:
                        conn.execute(
                            "DELETE FROM aura_whatsapp_verification WHERE user_id = ?",
                            (user_id,),
                        )
                    else:
                        conn.execute(
                            "UPDATE aura_whatsapp_verification SET attempts = ?"
                            " WHERE user_id = ?",
                            (new_attempts, user_id),
                        )
                    conn.commit()
                    return False
                ts_iso = _iso(ts)
                conn.execute(
                    "INSERT INTO aura_user_whatsapp"
                    " (user_id, phone_e164, verified_at, created_at, updated_at)"
                    " VALUES (?, ?, ?, ?, ?)"
                    " ON CONFLICT(user_id) DO UPDATE SET"
                    "   phone_e164 = excluded.phone_e164,"
                    "   verified_at = excluded.verified_at,"
                    "   updated_at = excluded.updated_at",
                    (user_id, phone, ts_iso, ts_iso, ts_iso),
                )
                conn.execute(
                    "DELETE FROM aura_whatsapp_verification WHERE user_id = ?",
                    (user_id,),
                )
                conn.commit()
                return True
            except Exception:
                conn.rollback()
                raise

        return await asyncio.to_thread(_verify)

    async def disconnect(self, user_id: str) -> bool:
        def _work() -> int:
            conn = self._store._connect()
            with conn:
                cur = conn.execute(
                    "DELETE FROM aura_user_whatsapp WHERE user_id = ?",
                    (user_id,),
                )
                return cur.rowcount or 0

        affected = await asyncio.to_thread(_work)
        return bool(affected)

    async def get_status(self, user_id: str) -> dict[str, Any]:
        def _work() -> tuple[str, ...] | None:
            conn = self._store._connect()
            row = conn.execute(
                "SELECT phone_e164 FROM aura_user_whatsapp WHERE user_id = ?",
                (user_id,),
            ).fetchone()
            return row

        row = await asyncio.to_thread(_work)
        if not row:
            return {"verified": False, "phone_masked": None}
        return {"verified": True, "phone_masked": mask_e164(row[0])}

    async def is_verified(self, user_id: str) -> bool:
        def _work() -> bool:
            conn = self._store._connect()
            row = conn.execute(
                "SELECT 1 FROM aura_user_whatsapp WHERE user_id = ? LIMIT 1",
                (user_id,),
            ).fetchone()
            return row is not None

        return await asyncio.to_thread(_work)

    async def find_or_create_conversation(self, user_id: str) -> str:
        """Return the user's permanent WhatsApp conversation id, creating one on miss."""
        ts_iso = _iso(self._now())

        def _work() -> str:
            conn = self._store._connect()
            conn.execute("BEGIN IMMEDIATE")
            try:
                row = conn.execute(
                    "SELECT id FROM conversations"
                    " WHERE user_id = ?"
                    "   AND json_extract(metadata, '$.channel') = 'whatsapp'"
                    " LIMIT 1",
                    (user_id,),
                ).fetchone()
                if row:
                    conn.commit()
                    return str(row[0])
                cid = str(uuid.uuid4())
                conn.execute(
                    "INSERT INTO conversations"
                    " (id, user_id, title, created_at, updated_at, metadata)"
                    " VALUES (?, ?, ?, ?, ?, ?)",
                    (
                        cid, user_id, "WhatsApp", ts_iso, ts_iso,
                        json.dumps({"channel": "whatsapp"}, ensure_ascii=False),
                    ),
                )
                conn.commit()
                return cid
            except Exception:
                conn.rollback()
                raise

        return await asyncio.to_thread(_work)

    async def _user_id_for_phone(self, phone_e164: str) -> str | None:
        def _work() -> str | None:
            conn = self._store._connect()
            row = conn.execute(
                "SELECT user_id FROM aura_user_whatsapp WHERE phone_e164 = ?",
                (phone_e164,),
            ).fetchone()
            return str(row[0]) if row else None

        return await asyncio.to_thread(_work)

    async def route_inbound(
        self, payload: dict[str, Any],
    ) -> dict[str, Any] | None:
        """Map an Evolution-shaped payload to a routing decision.

        Returns ``{user_id, conversation_id, text}`` for messages that
        should be processed. Returns ``None`` (silent drop) for: empty
        text, missing/malformed phone, group chat, or unknown
        (unverified) phone.

        ``payload['phone_e164']`` should already be E.164 with a leading
        '+' from the webhook adapter; we still normalize defensively so
        a buggy adapter degrades to a clean miss instead of a silent
        lookup failure.
        """
        text = (payload.get("text") or "").strip()
        if not text:
            return None
        phone_raw = payload.get("phone_e164")
        if not phone_raw:
            return None
        try:
            phone = normalize_e164(phone_raw)
        except InvalidPhone:
            logger.warning("inbound dropped: malformed phone %r", phone_raw)
            return None

        if payload.get("is_group"):
            # Verified-user group messages get a breadcrumb so future UX
            # can surface "groups not supported yet" without having to
            # re-derive the verification check.
            user_id_for_log = await self._user_id_for_phone(phone)
            if user_id_for_log:
                logger.debug("group inbound from verified phone %s — dropped", phone)
            return None

        user_id = await self._user_id_for_phone(phone)
        if user_id is None:
            logger.info("inbound from unknown phone %s — dropped", phone)
            return None

        conversation_id = await self.find_or_create_conversation(user_id)
        return {
            "user_id": user_id,
            "conversation_id": conversation_id,
            "text": text,
        }
