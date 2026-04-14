"""Web Push notification service.

Stores push subscriptions in the shared MemoryStore (SQLite) and sends
notifications via pywebpush. Subscriptions survive backend restarts.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from seraphine.memory.store import MemoryStore

logger = logging.getLogger(__name__)


@dataclass
class PushSubscription:
    endpoint: str
    p256dh: str
    auth: str


class PushService:
    """Push subscription store backed by SQLite + notification sender.

    Subscriptions are loaded from the DB on startup and persisted on every
    add/remove, so they survive backend restarts.
    """

    def __init__(
        self,
        vapid_private_key: str,
        vapid_public_key: str,
        store: "MemoryStore | None" = None,
        vapid_email: str = "mailto:seraphine@jonhdev.io",
    ) -> None:
        self._private_key = vapid_private_key
        self._public_key = vapid_public_key
        self._email = vapid_email
        self._store = store
        # In-memory cache, kept in sync with DB.
        self._subscriptions: list[PushSubscription] = []

    @property
    def public_key(self) -> str:
        return self._public_key

    @property
    def subscription_count(self) -> int:
        return len(self._subscriptions)

    def list_endpoints(self) -> list[str]:
        return [s.endpoint for s in self._subscriptions]

    async def load_from_store(self) -> None:
        """Populate the in-memory cache from the DB. Call once at startup."""
        if self._store is None:
            return
        rows = await self._store.list_push_subscriptions()
        self._subscriptions = [
            PushSubscription(
                endpoint=r["endpoint"], p256dh=r["p256dh"], auth=r["auth"]
            )
            for r in rows
        ]
        logger.info("Loaded %d push subscription(s) from store", len(self._subscriptions))

    async def add_subscription(self, sub_info: dict) -> None:
        """Store a push subscription from the frontend (DB + cache)."""
        sub = PushSubscription(
            endpoint=sub_info["endpoint"],
            p256dh=sub_info["keys"]["p256dh"],
            auth=sub_info["keys"]["auth"],
        )
        # Upsert into cache (replace existing by endpoint).
        self._subscriptions = [s for s in self._subscriptions if s.endpoint != sub.endpoint]
        self._subscriptions.append(sub)
        if self._store is not None:
            try:
                await self._store.add_push_subscription(sub.endpoint, sub.p256dh, sub.auth)
            except Exception as exc:
                logger.warning("Failed to persist push subscription: %s", exc)
        logger.info("Push subscription added: %s", sub.endpoint[:50])

    async def remove_subscription(self, endpoint: str) -> None:
        self._subscriptions = [s for s in self._subscriptions if s.endpoint != endpoint]
        if self._store is not None:
            try:
                await self._store.remove_push_subscription(endpoint)
            except Exception as exc:
                logger.warning("Failed to delete push subscription: %s", exc)

    async def send_notification(
        self,
        title: str,
        body: str,
        *,
        url: str = "/",
        tag: str = "seraphine",
    ) -> int:
        """Send push notification to all subscribers. Returns count sent."""
        from pywebpush import webpush, WebPushException

        payload = json.dumps({
            "title": title,
            "body": body,
            "icon": "/icon-192.png",
            "badge": "/icon-192.png",
            "url": url,
            "tag": tag,
        })

        sent = 0
        dead: list[str] = []

        for sub in self._subscriptions:
            sub_info = {
                "endpoint": sub.endpoint,
                "keys": {"p256dh": sub.p256dh, "auth": sub.auth},
            }
            try:
                webpush(
                    subscription_info=sub_info,
                    data=payload,
                    vapid_private_key=self._private_key,
                    vapid_claims={"sub": self._email},
                )
                sent += 1
            except WebPushException as e:
                if "410" in str(e) or "404" in str(e):
                    dead.append(sub.endpoint)
                    logger.info("Push subscription expired: %s", sub.endpoint[:50])
                else:
                    logger.warning("Push send failed: %s", e)
            except Exception as e:
                logger.warning("Push send error: %s", e)

        for endpoint in dead:
            await self.remove_subscription(endpoint)

        return sent
