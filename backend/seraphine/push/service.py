"""Web Push notification service.

Stores push subscriptions and sends notifications via pywebpush.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass
class PushSubscription:
    endpoint: str
    p256dh: str
    auth: str


class PushService:
    """In-memory push subscription store + notification sender."""

    def __init__(
        self,
        vapid_private_key: str,
        vapid_public_key: str,
        vapid_email: str = "mailto:seraphine@jonhdev.io",
    ) -> None:
        self._private_key = vapid_private_key
        self._public_key = vapid_public_key
        self._email = vapid_email
        self._subscriptions: list[PushSubscription] = []

    @property
    def public_key(self) -> str:
        return self._public_key

    def add_subscription(self, sub_info: dict) -> None:
        """Store a push subscription from the frontend."""
        sub = PushSubscription(
            endpoint=sub_info["endpoint"],
            p256dh=sub_info["keys"]["p256dh"],
            auth=sub_info["keys"]["auth"],
        )
        # Avoid duplicates
        for existing in self._subscriptions:
            if existing.endpoint == sub.endpoint:
                return
        self._subscriptions.append(sub)
        logger.info("Push subscription added: %s", sub.endpoint[:50])

    def remove_subscription(self, endpoint: str) -> None:
        self._subscriptions = [s for s in self._subscriptions if s.endpoint != endpoint]

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
            self.remove_subscription(endpoint)

        return sent
