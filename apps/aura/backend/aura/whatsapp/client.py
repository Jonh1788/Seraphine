"""Async HTTP client for the Evolution API REST surface.

Stateless wrapper. One instance per app (lives on app.state). Failures
map to a single ``EvolutionError`` carrying status + parsed reason so
the routing layer can decide what to do.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

import httpx

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 15.0


class EvolutionError(RuntimeError):
    """Raised on any non-2xx response from the Evolution API."""

    def __init__(self, *, status_code: int, body: str, reason: str) -> None:
        self.status_code = status_code
        self.body = body
        self.reason = reason
        super().__init__(f"evolution error {status_code}: {reason}")


def _phone_to_remote_jid_input(phone_e164: str) -> str:
    """Evolution accepts the bare E.164 (without the '+') in `number`."""
    return phone_e164.lstrip("+")


def _wuid_to_e164(wuid: str | None) -> str | None:
    """`5511987654321@s.whatsapp.net` -> `+5511987654321`."""
    if not wuid:
        return None
    raw = wuid.split("@", 1)[0]
    if not raw.isdigit():
        return None
    return "+" + raw


class EvolutionClient:
    """Thin async wrapper around the Evolution API endpoints Aura uses."""

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        instance: str,
        http_client: Optional[httpx.AsyncClient] = None,
    ) -> None:
        self._base = base_url.rstrip("/")
        self._key = api_key
        self._instance = instance
        self._http = http_client or httpx.AsyncClient(
            base_url=self._base, timeout=DEFAULT_TIMEOUT,
        )
        self._owns_http = http_client is None

    async def aclose(self) -> None:
        """Close the underlying httpx client when this instance owns it."""
        if self._owns_http:
            await self._http.aclose()

    def _headers(self) -> dict[str, str]:
        return {"apikey": self._key, "Content-Type": "application/json"}

    async def _request(
        self, method: str, path: str, *, json: Any = None,
    ) -> httpx.Response:
        url = f"{self._base}{path}"
        resp = await self._http.request(
            method, url, headers=self._headers(), json=json,
        )
        if resp.status_code >= 400:
            body = resp.text or ""
            try:
                payload = resp.json()
                reason = (
                    payload.get("message")
                    or payload.get("error")
                    or body[:200]
                )
            except Exception:
                reason = body[:200]
            raise EvolutionError(
                status_code=resp.status_code, body=body, reason=str(reason),
            )
        return resp

    async def send_text(self, phone_e164: str, text: str) -> str:
        """POST a text message; returns the Evolution message id."""
        path = f"/message/sendText/{self._instance}"
        body = {
            "number": _phone_to_remote_jid_input(phone_e164),
            "text": text,
        }
        resp = await self._request("POST", path, json=body)
        data = resp.json() or {}
        key = data.get("key") if isinstance(data, dict) else None
        msg_id = key.get("id") if isinstance(key, dict) else None
        if not msg_id:
            msg_id = str(data.get("messageId") or "")
        return msg_id

    async def get_status(self) -> dict[str, Any]:
        """Return ``{connected, phone, state}`` for the current instance."""
        path = f"/instance/connectionState/{self._instance}"
        resp = await self._request("GET", path)
        data = resp.json() or {}
        instance = data.get("instance") or {}
        state = instance.get("state")
        wuid = instance.get("wuid")
        return {
            "connected": state == "open",
            "phone": _wuid_to_e164(wuid),
            "state": state,
        }

    async def get_qr(self) -> str | None:
        """Return the base64 QR PNG, or ``None`` if already connected."""
        path = f"/instance/connect/{self._instance}"
        resp = await self._request("GET", path)
        data = resp.json() or {}
        if isinstance(data, dict):
            if data.get("base64"):
                return str(data["base64"])
            instance = data.get("instance") or {}
            if instance.get("state") == "open":
                return None
        return None
