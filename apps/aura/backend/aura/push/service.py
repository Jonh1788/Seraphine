"""PushService — manage VAPID keys, browser subscriptions, dispatch.

VAPID keys are generated once on first boot if not present in the
settings. Public key is exposed via /push/vapid-public-key for the
client to subscribe; private key signs each push payload.

Reminder dispatch: the lifespan loop calls ``dispatch_due_reminders``
every minute. It pulls pending tasks of type='reminder' due within the
last minute that haven't been dispatched, sends a push to every
subscription of that user, and records the dispatch so we don't fire
twice. Failed pushes (410 Gone) prune the subscription.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import uuid
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Any

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from pywebpush import WebPushException, webpush  # type: ignore[import-untyped]

from core_db import Store
from mod_tasks.service import TaskService

logger = logging.getLogger("aura.push")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


@dataclass
class PushSubscriptionRow:
    id: str
    user_id: str
    endpoint: str
    p256dh: str
    auth: str
    user_agent: str | None
    created_at: str
    last_seen: str


@dataclass
class VapidKeys:
    private_pem: str
    public_uncompressed_b64: str


class PushService:
    def __init__(
        self,
        *,
        store: Store,
        tasks: TaskService,
        vapid_subject: str,
        vapid_private_pem: str | None = None,
        vapid_public_b64: str | None = None,
    ) -> None:
        self._store = store
        self._tasks = tasks
        self._subject = vapid_subject
        if vapid_private_pem and vapid_public_b64:
            # py_vapid (used by pywebpush) does NOT understand PEM —
            # `Vapid.from_string` strips newlines and base64-decodes,
            # then routes 32-byte payloads to `from_raw` and longer to
            # `from_der`. So we always feed it the raw 32-byte private
            # scalar as base64url, which works regardless of whether
            # the env var was PKCS8 or SEC1.
            normalized = vapid_private_pem.replace("\\n", "\n")
            try:
                pkey = serialization.load_pem_private_key(
                    normalized.encode("utf-8"), password=None,
                )
                # EC SECP256R1 → 32-byte big-endian private scalar.
                priv_int = pkey.private_numbers().private_value
                raw = priv_int.to_bytes(32, "big")
                normalized = _b64url(raw)
            except Exception:
                logger.exception(
                    "VAPID private key reformat failed; pywebpush will "
                    "likely reject it. Check AURA_VAPID_PRIVATE_PEM."
                )
            self._keys = VapidKeys(
                private_pem=normalized,
                public_uncompressed_b64=vapid_public_b64.strip(),
            )
        else:
            self._keys = self._generate_keys()
            logger.warning(
                "VAPID keys not set in env — generated ephemeral pair. "
                "Subscriptions will break on restart. Set "
                "AURA_VAPID_PRIVATE_PEM and AURA_VAPID_PUBLIC_B64 in prod."
            )

    # ------------------------------------------------------------------
    # Public properties / metadata
    # ------------------------------------------------------------------

    @property
    def vapid_public_key_b64(self) -> str:
        return self._keys.public_uncompressed_b64

    # ------------------------------------------------------------------
    # Subscriptions CRUD
    # ------------------------------------------------------------------

    async def upsert_subscription(
        self,
        *,
        user_id: str,
        endpoint: str,
        p256dh: str,
        auth: str,
        user_agent: str | None,
    ) -> PushSubscriptionRow:
        ts = _now_iso()

        def _work() -> PushSubscriptionRow:
            with self._store._connect() as conn:
                row = conn.execute(
                    "SELECT id, created_at FROM push_subscriptions"
                    " WHERE user_id = ? AND endpoint = ?",
                    (user_id, endpoint),
                ).fetchone()
                if row:
                    sid, created_at = row[0], row[1]
                    conn.execute(
                        "UPDATE push_subscriptions SET p256dh = ?, auth = ?,"
                        " user_agent = ?, last_seen = ? WHERE id = ?",
                        (p256dh, auth, user_agent, ts, sid),
                    )
                    return PushSubscriptionRow(
                        id=sid,
                        user_id=user_id,
                        endpoint=endpoint,
                        p256dh=p256dh,
                        auth=auth,
                        user_agent=user_agent,
                        created_at=created_at,
                        last_seen=ts,
                    )
                sid = str(uuid.uuid4())
                conn.execute(
                    "INSERT INTO push_subscriptions"
                    " (id, user_id, endpoint, p256dh, auth, user_agent,"
                    "  created_at, last_seen)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (sid, user_id, endpoint, p256dh, auth, user_agent, ts, ts),
                )
                return PushSubscriptionRow(
                    id=sid,
                    user_id=user_id,
                    endpoint=endpoint,
                    p256dh=p256dh,
                    auth=auth,
                    user_agent=user_agent,
                    created_at=ts,
                    last_seen=ts,
                )

        return await asyncio.to_thread(_work)

    async def list_subscriptions(self, user_id: str) -> list[PushSubscriptionRow]:
        def _work() -> list[PushSubscriptionRow]:
            with self._store._connect() as conn:
                rows = conn.execute(
                    "SELECT id, user_id, endpoint, p256dh, auth, user_agent,"
                    " created_at, last_seen FROM push_subscriptions"
                    " WHERE user_id = ?",
                    (user_id,),
                ).fetchall()
            return [
                PushSubscriptionRow(
                    id=r[0],
                    user_id=r[1],
                    endpoint=r[2],
                    p256dh=r[3],
                    auth=r[4],
                    user_agent=r[5],
                    created_at=r[6],
                    last_seen=r[7],
                )
                for r in rows
            ]

        return await asyncio.to_thread(_work)

    async def delete_subscription(self, user_id: str, endpoint: str) -> int:
        def _work() -> int:
            with self._store._connect() as conn:
                cur = conn.execute(
                    "DELETE FROM push_subscriptions"
                    " WHERE user_id = ? AND endpoint = ?",
                    (user_id, endpoint),
                )
            return cur.rowcount

        return await asyncio.to_thread(_work)

    # ------------------------------------------------------------------
    # Send
    # ------------------------------------------------------------------

    async def send_to_user(self, user_id: str, payload: dict[str, Any]) -> int:
        """Push payload to every subscription of this user. Returns how
        many succeeded. Subscriptions returning 404/410 are pruned."""
        subs = await self.list_subscriptions(user_id)
        if not subs:
            return 0
        body = json.dumps(payload, ensure_ascii=False)

        def _send_one(sub: PushSubscriptionRow) -> bool:
            sub_info = {
                "endpoint": sub.endpoint,
                "keys": {"p256dh": sub.p256dh, "auth": sub.auth},
            }
            try:
                webpush(
                    subscription_info=sub_info,
                    data=body,
                    vapid_private_key=self._keys.private_pem,
                    vapid_claims={"sub": self._subject},
                    timeout=10,
                )
                return True
            except WebPushException as e:
                status = e.response.status_code if e.response is not None else None
                if status in (404, 410):
                    # Endpoint dead — prune.
                    try:
                        with self._store._connect() as conn:
                            conn.execute(
                                "DELETE FROM push_subscriptions WHERE id = ?",
                                (sub.id,),
                            )
                    except Exception:
                        pass
                    logger.info("pruned dead push subscription %s", sub.id)
                else:
                    logger.warning(
                        "push send failed (status=%s, sub=%s): %s",
                        status, sub.id, e,
                    )
                return False
            except Exception:
                logger.exception("unexpected push error for sub=%s", sub.id)
                return False

        results = await asyncio.gather(
            *(asyncio.to_thread(_send_one, s) for s in subs)
        )
        return sum(1 for r in results if r)

    # ------------------------------------------------------------------
    # Reminder dispatch loop
    # ------------------------------------------------------------------

    async def dispatch_due_reminders(self, *, lookback_minutes: int = 2) -> int:
        """Find pending reminders whose due_date+due_time fell in the
        last `lookback_minutes` and haven't been dispatched yet. Send a
        push for each and mark dispatched. Returns count dispatched.

        Note: due_date/due_time are stored as local-date strings; we
        treat them as the user's local time. Multi-timezone users would
        need a per-user tz column — out of scope for v1."""
        now = datetime.now()
        window_start = now - timedelta(minutes=lookback_minutes)

        def _candidates() -> list[tuple[str, str, str, str | None, str | None]]:
            # (id, user_id, title, due_date, due_time)
            with self._store._connect() as conn:
                rows = conn.execute(
                    "SELECT t.id, t.user_id, t.title, t.due_date, t.due_time"
                    " FROM tasks t"
                    " LEFT JOIN push_dispatches d"
                    "   ON d.task_id = t.id AND d.user_id = t.user_id"
                    " WHERE t.type = 'reminder'"
                    "   AND t.status = 'pending'"
                    "   AND t.due_date IS NOT NULL"
                    "   AND d.task_id IS NULL",
                ).fetchall()
            return [(r[0], r[1], r[2], r[3], r[4]) for r in rows]

        try:
            rows = await asyncio.to_thread(_candidates)
        except Exception:
            # Tasks table may not yet exist — bail without spamming logs.
            logger.debug("dispatch_due_reminders: candidate query failed", exc_info=True)
            return 0

        dispatched = 0
        for task_id, user_id, title, due_date, due_time in rows:
            try:
                fire_at = _parse_due(due_date, due_time)
                if fire_at is None:
                    continue
                if fire_at > now:
                    continue
                if fire_at < window_start:
                    # Reminder is older than the lookback window: still
                    # fire so we don't silently swallow stale ones.
                    pass
                payload = {
                    "title": title,
                    "body": _format_when(due_date, due_time),
                    "tag": f"reminder-{task_id}",
                    "data": {"task_id": task_id, "url": "/mais/lembretes"},
                }
                sent = await self.send_to_user(user_id, payload)
                if sent > 0:
                    await self._mark_dispatched(task_id, user_id)
                    dispatched += 1
            except Exception:
                logger.exception("dispatch failed for task=%s", task_id)

        return dispatched

    async def _mark_dispatched(self, task_id: str, user_id: str) -> None:
        def _work() -> None:
            with self._store._connect() as conn:
                conn.execute(
                    "INSERT OR IGNORE INTO push_dispatches"
                    " (task_id, user_id, dispatched_at) VALUES (?, ?, ?)",
                    (task_id, user_id, _now_iso()),
                )

        await asyncio.to_thread(_work)

    # ------------------------------------------------------------------
    # VAPID key generation
    # ------------------------------------------------------------------

    def _generate_keys(self) -> VapidKeys:
        # Generates an ECDSA P-256 keypair and exports as PEM (private)
        # plus uncompressed public point in URL-safe base64 (the format
        # browsers want for `applicationServerKey`).
        priv = ec.generate_private_key(ec.SECP256R1())
        pem = priv.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        ).decode("ascii")

        pub = priv.public_key()
        raw = pub.public_bytes(
            encoding=serialization.Encoding.X962,
            format=serialization.PublicFormat.UncompressedPoint,
        )
        return VapidKeys(
            private_pem=pem,
            public_uncompressed_b64=_b64url(raw),
        )


# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------


def _parse_due(due_date: str | None, due_time: str | None) -> datetime | None:
    if not due_date:
        return None
    try:
        d = date.fromisoformat(due_date[:10])
    except ValueError:
        return None
    if due_time:
        try:
            parts = due_time.split(":")
            t = time(int(parts[0]), int(parts[1]))
        except (ValueError, IndexError):
            t = time.min
    else:
        t = time(9, 0)  # default 09:00 local
    return datetime.combine(d, t)


def _format_when(due_date: str | None, due_time: str | None) -> str:
    if not due_date:
        return "Lembrete"
    if due_time:
        return f"Hoje · {due_time}" if due_date == date.today().isoformat() else f"{due_date} · {due_time}"
    return f"{due_date}"


# Convenience for env var derivation: read VAPID config from env without
# leaking the names everywhere.
def vapid_from_env() -> tuple[str | None, str | None]:
    return (
        os.environ.get("AURA_VAPID_PRIVATE_PEM"),
        os.environ.get("AURA_VAPID_PUBLIC_B64"),
    )
