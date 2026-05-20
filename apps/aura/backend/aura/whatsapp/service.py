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
from collections import deque
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Protocol

from llm_adapters.types import ChatMessage

from aura.whatsapp.client import EvolutionClient, EvolutionError
from aura.whatsapp.phone import InvalidPhone, mask_e164, normalize_e164

logger = logging.getLogger(__name__)


VERIFICATION_TTL = timedelta(minutes=5)
VERIFICATION_COOLDOWN = timedelta(seconds=60)
MAX_VERIFICATION_ATTEMPTS = 3
WA_SUFFIX = (
    "Você está respondendo via WhatsApp. Seja conciso (1-3 frases quando "
    "possível), evite listas longas e markdown pesado. Negrito com "
    "*asterisco* funciona; títulos `#`, links e tabelas não."
)
RATE_LIMIT_MAX = 30
RATE_LIMIT_WINDOW = timedelta(hours=1)
# Why: in-memory rate limiter is intentional — at our scale we accept the
# reset-on-restart trade-off in exchange for zero infra and trivial code.


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
        # Late-bound by bind_dependencies(); a None _conversations means
        # the service was wired without the chat-side collaborators yet
        # (e.g. background webhook arriving during lifespan startup).
        # process_user_message logs and no-ops in that case.
        self._llm: Any = None
        self._finance: Any = None
        self._tasks: Any = None
        self._recurring: Any = None
        self._projects: Any = None
        self._habits: Any = None
        self._knowledge: Any = None
        self._goals: Any = None
        self._conversations: Any = None
        self._users: Any = None
        # Optional user-name lookup (wired by main.py from UsersService);
        # used to personalize the agent's system prompt for inbound WA.
        self._user_id_to_name: Callable[[str], Awaitable[str | None]] | None = None
        self._rate: dict[str, deque[datetime]] = {}
        # Latest QR base64 received via the qrcode.updated webhook
        # (Evolution v2 only delivers QRs through events, not via
        # /instance/connect responses). Cleared when state flips to
        # 'open' via connection.update.
        self._latest_qr: str | None = None
        self._latest_qr_at: datetime | None = None

    # ------------------------------------------------------------------
    # QR cache (fed by webhook qrcode.updated events)
    # ------------------------------------------------------------------

    def cache_qr(self, base64_png: str | None) -> None:
        if not base64_png:
            return
        self._latest_qr = base64_png
        self._latest_qr_at = self._now()

    def clear_qr(self) -> None:
        self._latest_qr = None
        self._latest_qr_at = None

    @property
    def latest_qr(self) -> str | None:
        return self._latest_qr

    # ------------------------------------------------------------------
    # Verification
    # ------------------------------------------------------------------

    async def start_verification(self, user_id: str, phone_raw: str) -> None:
        """Issue a 6-digit code to ``phone_raw`` for ``user_id``.

        Enforces a 60-second cooldown per user; replaces any existing
        in-flight code so the user always sees the latest one.

        After the local E.164 normalization we ask WhatsApp (via the
        bridge) for the canonical phone. This guards against malformed
        inputs that still pass ``normalize_e164`` — most notably a
        Brazilian number entered without the ``55`` country code (e.g.
        ``"21976513455"`` → ``"+21976513455"``), which the regex
        accepts as a generic E.164. Without canonicalization the
        verification row would store the bogus phone, the OTP would
        still arrive (the bridge re-resolves at send time), and inbound
        messages would never match — exactly the failure mode we saw
        in prod on 2026-05-19.
        """
        phone = normalize_e164(phone_raw)
        lookup = getattr(self._client, "lookup_phone", None)
        if callable(lookup):
            try:
                canonical = await lookup(phone)
            except Exception:
                # Bridge unreachable / transport failure — fall back to
                # the locally-normalized phone so a transient outage
                # doesn't block onboarding. The OTP delivery itself
                # will surface a clearer error if the bridge is truly
                # down.
                logger.exception(
                    "phone canonicalization failed; falling back phone=%s",
                    phone,
                )
            else:
                if canonical is None:
                    raise InvalidPhone(
                        "número não encontrado no WhatsApp"
                    )
                # Re-normalize so the persisted phone matches what
                # ``route_inbound`` will produce on subsequent inbound.
                # WhatsApp sometimes exposes BR mobile numbers in the
                # legacy 12-digit form (``557388836445``); normalize_e164
                # reinserts the post-2012 mandatory leading 9 so DB
                # lookup hits the canonical 13-digit shape.
                try:
                    phone = normalize_e164(canonical)
                except InvalidPhone:
                    logger.warning(
                        "canonical phone from bridge failed normalize: %r — "
                        "falling back to local form %r",
                        canonical, phone,
                    )
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

    # ------------------------------------------------------------------
    # Agentic processing (chat-side late-bound)
    # ------------------------------------------------------------------

    def bind_dependencies(
        self,
        *,
        llm: Any,
        finance: Any,
        tasks: Any,
        recurring: Any,
        projects: Any,
        habits: Any,
        knowledge: Any,
        goals: Any,
        conversations: Any,
        users: Any = None,
    ) -> None:
        """Late-bind chat-side services. Called once on lifespan startup.

        ``users`` is optional — when present, the ``set_reminder_defaults``
        chat tool can run from inbound WhatsApp (matches web parity).
        """
        self._llm = llm
        self._finance = finance
        self._tasks = tasks
        self._recurring = recurring
        self._projects = projects
        self._habits = habits
        self._knowledge = knowledge
        self._goals = goals
        self._conversations = conversations
        self._users = users

    def attach_user_lookup(
        self, user_id_to_name: Callable[[str], Awaitable[str | None]],
    ) -> None:
        """Wire UsersService.get_name so process_user_message can address
        the user by name in WhatsApp replies."""
        self._user_id_to_name = user_id_to_name

    def _mark_user_send(self, user_id: str) -> None:
        q = self._rate.setdefault(user_id, deque())
        q.append(self._now())

    def _is_over_cap(self, user_id: str) -> bool:
        q = self._rate.get(user_id)
        if not q:
            return False
        cutoff = self._now() - RATE_LIMIT_WINDOW
        while q and q[0] < cutoff:
            q.popleft()
        return len(q) >= RATE_LIMIT_MAX

    async def _phone_for_user(self, user_id: str) -> str | None:
        def _work() -> str | None:
            row = self._store._connect().execute(
                "SELECT phone_e164 FROM aura_user_whatsapp WHERE user_id = ?",
                (user_id,),
            ).fetchone()
            return str(row[0]) if row else None

        return await asyncio.to_thread(_work)

    async def process_user_message(
        self, user_id: str, conversation_id: str, text: str,
    ) -> None:
        """Persist inbound, run the agentic loop, send reply via Evolution.

        Best-effort: any failure is logged, never raised. Rate limited
        to RATE_LIMIT_MAX messages per RATE_LIMIT_WINDOW per user.
        """
        if self._conversations is None:
            logger.error(
                "WA process_user_message called before bind_dependencies "
                "(user=%s); dropping silently",
                user_id,
            )
            return
        if self._is_over_cap(user_id):
            logger.warning(
                "WA rate-limit hit for user=%s; dropping inbound", user_id,
            )
            return

        await self._conversations.add_message(
            conversation_id, user_id, "user", text, metadata=None,
        )
        history = await self._conversations.get_messages_for_llm(
            conversation_id, user_id,
        )
        if history is None:
            logger.warning(
                "WA inbound: history is None after add_message "
                "(conversation deleted? user=%s cid=%s); dropping reply",
                user_id, conversation_id,
            )
            return

        # Deferred import to avoid a chat <-> whatsapp import cycle.
        from aura.chat.routes import _build_system_prompt, _run_agentic_collect

        # Best-effort name lookup; missing name just skips the personalization.
        user_name: str | None = None
        if self._user_id_to_name is not None:
            try:
                user_name = await self._user_id_to_name(user_id)
            except Exception:
                logger.exception("WA user name lookup failed user=%s", user_id)

        msgs: list[ChatMessage] = [
            ChatMessage(role="system", content=_build_system_prompt()),
        ]
        if user_name:
            msgs.append(ChatMessage(
                role="system",
                content=(
                    f"Você está conversando com {user_name} via WhatsApp. "
                    "Trate-o(a) pelo primeiro nome quando soar natural — "
                    "não exagere e não force em toda mensagem."
                ),
            ))
        msgs.append(ChatMessage(role="system", content=WA_SUFFIX))
        for m in history:
            msgs.append(ChatMessage(role=m["role"], content=m["content"]))
        is_first_exchange = len(history) == 1

        # Why: webhook background task — anything that escapes here gets
        # logged by uvicorn with no user-actionable context. Swallow so a
        # single bad LLM/tool round doesn't crash the task.
        try:
            out = await _run_agentic_collect(
                llm=self._llm,
                finance=self._finance,
                tasks_svc=self._tasks,
                recurring_svc=self._recurring,
                projects_svc=self._projects,
                habits_svc=self._habits,
                knowledge_svc=self._knowledge,
                goals_svc=self._goals,
                svc=self._conversations,
                uid=user_id,
                conversation_id=conversation_id,
                user_text=text,
                msgs=msgs,
                is_first_exchange=is_first_exchange,
                users_svc=self._users,
            )
        except Exception:
            logger.exception("WA agentic loop failed user=%s", user_id)
            return

        phone = await self._phone_for_user(user_id)
        if phone is None:
            return
        try:
            await self._client.send_text(phone, out["reply"])
            self._mark_user_send(user_id)
        except EvolutionError:
            logger.exception("WA reply send failed user=%s", user_id)

    async def send_reminder(
        self,
        *,
        user_id: str,
        task_id: int,
        title: str,
        due_time: str | None,
        offset_minutes: int = 0,
    ) -> bool:
        """Send a reminder push via WhatsApp; True only when actually sent.

        Idempotent via aura_whatsapp_dispatches: ``ON CONFLICT DO NOTHING``
        on the (task_id, user_id, offset_minutes) PK means a duplicate
        INSERT silently no-ops and ``rowcount == 0`` flags it as already
        dispatched. Other IntegrityErrors (e.g. FK violations under
        ``PRAGMA foreign_keys = ON``) surface so the dispatcher can
        retry / alert instead of swallowing them as "done." On Evolution
        failure we delete the claim row so the next dispatcher cycle
        retries.
        """
        phone = await self._phone_for_user(user_id)
        if phone is None:
            return False

        ts_iso = _iso(self._now())
        offset = int(offset_minutes or 0)

        def _claim() -> bool:
            conn = self._store._connect()
            with conn:
                cur = conn.execute(
                    "INSERT INTO aura_whatsapp_dispatches"
                    " (task_id, user_id, offset_minutes, sent_at)"
                    " VALUES (?, ?, ?, ?)"
                    " ON CONFLICT(task_id, user_id, offset_minutes) DO NOTHING",
                    (task_id, user_id, offset, ts_iso),
                )
            return (cur.rowcount or 0) == 1

        claimed = await asyncio.to_thread(_claim)
        if not claimed:
            return False

        text = _reminder_text(title, due_time, offset)
        try:
            await self._client.send_text(phone, text)
            return True
        except EvolutionError:
            logger.exception(
                "WA reminder send failed user=%s task=%s offset=%s — rolling back claim",
                user_id, task_id, offset,
            )

            def _rollback() -> None:
                conn = self._store._connect()
                with conn:
                    conn.execute(
                        "DELETE FROM aura_whatsapp_dispatches"
                        " WHERE task_id = ? AND user_id = ?"
                        " AND offset_minutes = ?",
                        (task_id, user_id, offset),
                    )

            try:
                await asyncio.to_thread(_rollback)
            except Exception:
                logger.exception(
                    "WA reminder rollback failed user=%s task=%s offset=%s",
                    user_id, task_id, offset,
                )
            return False


def _reminder_text(title: str, due_time: str | None, offset_minutes: int) -> str:
    """Reminder body. Mirrors push.service._format_offset_when wording
    but adapted to WhatsApp's short, single-line style."""
    if offset_minutes <= 0:
        return f"*{title}* às {due_time}" if due_time else f"*{title}* hoje"
    if offset_minutes >= 60 * 24 and offset_minutes % (60 * 24) == 0:
        d = offset_minutes // (60 * 24)
        prefix = "em 1 dia" if d == 1 else f"em {d} dias"
    elif offset_minutes >= 60 and offset_minutes % 60 == 0:
        h = offset_minutes // 60
        prefix = "em 1 h" if h == 1 else f"em {h} h"
    else:
        prefix = f"em {offset_minutes} min"
    when = f"às {due_time}" if due_time else "hoje"
    return f"*{title}* — {prefix} ({when})"
