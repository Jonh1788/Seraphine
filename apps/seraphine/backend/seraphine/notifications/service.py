"""094 -- NotificationService: DND, priority scoring, batching, feedback learning.

Single-tenant. All state in SQLite via MemoryStore.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from core_db import Store

from seraphine.notifications.types import (
    BASE_PRIORITY,
    IMMEDIATE_THRESHOLD,
    NotificationSettings,
)

logger = logging.getLogger(__name__)

_SP_TZ = ZoneInfo("America/Sao_Paulo")


class NotificationService:
    """Gate that decides whether a notification should be delivered now,
    queued for batching, or dropped entirely."""

    def __init__(
        self,
        store: Store,
        *,
        google_client: Any | None = None,
        focus_service: Any | None = None,
    ) -> None:
        self._store = store
        self._google_client = google_client
        self._focus_service = focus_service
        # In-memory cache (single-tenant, single row).
        self._settings: NotificationSettings | None = None

    # ------------------------------------------------------------------
    # Settings CRUD
    # ------------------------------------------------------------------

    async def get_settings(self) -> NotificationSettings:
        if self._settings is not None:
            return self._settings

        def _load() -> str | None:
            with self._store._connect() as conn:
                row = conn.execute(
                    "SELECT settings_json FROM notification_settings WHERE id = 1"
                ).fetchone()
            return str(row[0]) if row else None

        raw = await asyncio.to_thread(_load)
        if raw:
            try:
                self._settings = NotificationSettings.from_dict(json.loads(raw))
            except Exception:
                self._settings = NotificationSettings()
        else:
            self._settings = NotificationSettings()
        return self._settings

    async def update_settings(self, patch: dict[str, Any]) -> NotificationSettings:
        current = await self.get_settings()
        d = current.to_dict()
        d.update(patch)
        updated = NotificationSettings.from_dict(d)
        blob = json.dumps(updated.to_dict(), ensure_ascii=False)

        def _save() -> None:
            with self._store._connect() as conn:
                conn.execute(
                    "INSERT INTO notification_settings (id, settings_json) "
                    "VALUES (1, ?) "
                    "ON CONFLICT(id) DO UPDATE SET settings_json = excluded.settings_json",
                    (blob,),
                )

        await asyncio.to_thread(_save)
        self._settings = updated
        return updated

    # ------------------------------------------------------------------
    # Priority scoring
    # ------------------------------------------------------------------

    async def compute_priority(self, notification_type: str) -> int:
        base = BASE_PRIORITY.get(notification_type, 20)
        boost = await self._interaction_boost(notification_type)
        decay = await self._dismiss_decay(notification_type)
        return max(0, min(100, base + boost + decay))

    async def _interaction_boost(self, ntype: str) -> int:
        """+ 10 if user interacted (opened/snoozed) with this type in last 7d."""
        cutoff = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()

        def _check() -> bool:
            with self._store._connect() as conn:
                row = conn.execute(
                    "SELECT 1 FROM notification_feedback "
                    "WHERE notification_type = ? AND action IN ('opened', 'snoozed') "
                    "AND timestamp >= ? LIMIT 1",
                    (ntype, cutoff),
                ).fetchone()
            return row is not None

        found = await asyncio.to_thread(_check)
        return 10 if found else 0

    async def _dismiss_decay(self, ntype: str) -> int:
        """-20 if user dismissed the last 3 of this type."""

        def _check() -> bool:
            with self._store._connect() as conn:
                rows = conn.execute(
                    "SELECT action FROM notification_feedback "
                    "WHERE notification_type = ? "
                    "ORDER BY timestamp DESC LIMIT 3",
                    (ntype,),
                ).fetchall()
            if len(rows) < 3:
                return False
            return all(str(r[0]) == "dismissed" for r in rows)

        all_dismissed = await asyncio.to_thread(_check)
        return -20 if all_dismissed else 0

    async def get_priority_weights(self) -> dict[str, int]:
        """Return computed priority for every known type."""
        weights: dict[str, int] = {}
        for ntype in BASE_PRIORITY:
            weights[ntype] = await self.compute_priority(ntype)
        return weights

    # ------------------------------------------------------------------
    # DND detection
    # ------------------------------------------------------------------

    async def _is_quiet_hours(self) -> bool:
        settings = await self.get_settings()
        now_sp = datetime.now(_SP_TZ)
        now_hhmm = now_sp.strftime("%H:%M")
        start = settings.quiet_hours_start
        end = settings.quiet_hours_end
        if start <= end:
            # Same-day window, e.g. 08:00-22:00
            return start <= now_hhmm <= end
        else:
            # Crosses midnight, e.g. 23:00-07:00
            return now_hhmm >= start or now_hhmm <= end

    async def _is_in_meeting(self) -> bool:
        """Check Google Calendar for a current meeting."""
        gc = self._google_client
        if gc is None:
            return False
        try:
            authed = await gc.is_authed()
            if not authed:
                return False
            now = datetime.now(timezone.utc)
            time_min = now.isoformat()
            time_max = (now + timedelta(minutes=1)).isoformat()
            events = await gc.list_events(
                time_min=time_min,
                time_max=time_max,
                single_events=True,
                max_results=5,
            )
            # Filter to events that are actually happening now (not all-day).
            for ev in events:
                start = ev.get("start", {})
                if start.get("dateTime"):
                    return True
            return False
        except Exception as e:
            logger.debug("is_in_meeting check failed: %s", e)
            return False

    async def _is_focus_active(self) -> bool:
        """Check if a Pomodoro/focus session is currently active.

        Reads the in-memory flag set by `POST /focus/active` — the frontend
        signals start/stop of focus sessions via that endpoint.
        """
        if self._focus_service is None:
            return False
        return self._focus_service.is_active()

    async def is_dnd(self) -> bool:
        """Returns True if DND is active (meeting, focus, or quiet hours)."""
        if await self._is_quiet_hours():
            return True
        if await self._is_in_meeting():
            return True
        if await self._is_focus_active():
            return True
        return False

    # ------------------------------------------------------------------
    # Core gate
    # ------------------------------------------------------------------

    async def should_deliver(self, notification_type: str) -> bool:
        """Whether a notification of this type should be delivered now.

        Returns True  -> deliver immediately.
        Returns False -> queue for batch delivery.
        """
        settings = await self.get_settings()

        # 1. Type disabled entirely?
        if not settings.per_type_enabled.get(notification_type, True):
            return False

        # 2. Compute priority
        priority = await self.compute_priority(notification_type)

        # 3. High priority always delivers (fura DND)
        if priority >= IMMEDIATE_THRESHOLD:
            return True

        # 4. DND active? Queue.
        if await self.is_dnd():
            return False

        # 5. Batching enabled and low priority? Queue.
        if settings.batching_enabled and priority < IMMEDIATE_THRESHOLD:
            return False

        return True

    # ------------------------------------------------------------------
    # Queue management
    # ------------------------------------------------------------------

    async def queue_notification(
        self,
        *,
        type: str,
        title: str,
        body: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Insert a notification into the queue (not delivered yet)."""
        nid = str(uuid.uuid4())
        priority = await self.compute_priority(type)
        now_iso = datetime.now(timezone.utc).isoformat()
        payload_json = json.dumps(payload or {}, ensure_ascii=False)

        def _insert() -> None:
            with self._store._connect() as conn:
                conn.execute(
                    "INSERT INTO notification_queue "
                    "(id, type, title, body, payload_json, priority, queued_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (nid, type, title, body, payload_json, priority, now_iso),
                )

        await asyncio.to_thread(_insert)
        return {
            "id": nid,
            "type": type,
            "title": title,
            "body": body,
            "priority": priority,
            "queued_at": now_iso,
        }

    async def get_pending_queue(self) -> list[dict[str, Any]]:
        """Return all queued (undelivered) notifications."""

        def _load() -> list[dict[str, Any]]:
            with self._store._connect() as conn:
                rows = conn.execute(
                    "SELECT id, type, title, body, payload_json, priority, queued_at "
                    "FROM notification_queue "
                    "WHERE delivered_at IS NULL "
                    "ORDER BY priority DESC, queued_at ASC",
                ).fetchall()
            return [
                {
                    "id": str(r[0]),
                    "type": str(r[1]),
                    "title": str(r[2]),
                    "body": str(r[3]),
                    "payload": json.loads(str(r[4])) if r[4] else {},
                    "priority": int(r[5]),
                    "queued_at": str(r[6]),
                }
                for r in rows
            ]

        return await asyncio.to_thread(_load)

    async def flush_queue(self) -> list[dict[str, Any]]:
        """Mark all pending notifications as delivered and return them.

        The caller is responsible for actually delivering the batch (e.g.
        via WS or push).
        """
        now_iso = datetime.now(timezone.utc).isoformat()

        def _flush() -> list[dict[str, Any]]:
            with self._store._connect() as conn:
                rows = conn.execute(
                    "SELECT id, type, title, body, payload_json, priority, queued_at "
                    "FROM notification_queue "
                    "WHERE delivered_at IS NULL "
                    "ORDER BY priority DESC, queued_at ASC",
                ).fetchall()
                if rows:
                    ids = [str(r[0]) for r in rows]
                    placeholders = ",".join("?" for _ in ids)
                    conn.execute(
                        f"UPDATE notification_queue SET delivered_at = ? "
                        f"WHERE id IN ({placeholders})",
                        [now_iso, *ids],
                    )
                return [
                    {
                        "id": str(r[0]),
                        "type": str(r[1]),
                        "title": str(r[2]),
                        "body": str(r[3]),
                        "payload": json.loads(str(r[4])) if r[4] else {},
                        "priority": int(r[5]),
                        "queued_at": str(r[6]),
                    }
                    for r in rows
                ]

        return await asyncio.to_thread(_flush)

    # ------------------------------------------------------------------
    # Feedback
    # ------------------------------------------------------------------

    async def record_feedback(
        self,
        notification_id: str,
        notification_type: str,
        action: str,
    ) -> None:
        """Record user interaction with a notification."""
        valid_actions = ("opened", "dismissed", "snoozed", "ignored")
        if action not in valid_actions:
            raise ValueError(
                f"invalid action: {action!r} (must be one of {valid_actions})"
            )
        now_iso = datetime.now(timezone.utc).isoformat()

        def _insert() -> None:
            with self._store._connect() as conn:
                conn.execute(
                    "INSERT OR REPLACE INTO notification_feedback "
                    "(id, notification_type, action, timestamp) "
                    "VALUES (?, ?, ?, ?)",
                    (notification_id, notification_type, action, now_iso),
                )

        await asyncio.to_thread(_insert)

    # ------------------------------------------------------------------
    # DND status endpoint helper
    # ------------------------------------------------------------------

    async def get_dnd_status(self) -> dict[str, Any]:
        """Return current DND state for the frontend."""
        is_dnd = await self.is_dnd()
        quiet = await self._is_quiet_hours()
        meeting = await self._is_in_meeting()
        focus = await self._is_focus_active()
        return {
            "dnd": is_dnd,
            "reasons": {
                "quiet_hours": quiet,
                "meeting": meeting,
                "focus_session": focus,
            },
        }
