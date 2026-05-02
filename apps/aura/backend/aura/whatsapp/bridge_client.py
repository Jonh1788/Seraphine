"""Async HTTP client for the whatsapp-web.js bridge.

Drop-in replacement for ``EvolutionClient`` — exposes the same three
public methods (``send_text``, ``get_status``, ``get_qr``) plus
``aclose``, returning the same shapes so ``WhatsAppService`` doesn't
care which backend is wired.

The bridge runs as the ``whatsapp-bridge`` service in Aura's compose
stack (see ``apps/aura/docker-compose.yml``). It exposes a small REST
surface on port 3001:

- ``POST /send``       body ``{chatId, message}``      send a text
- ``GET  /qr``         → ``{qr, expires_in_s}``        latest QR
- ``GET  /status``     → ``{status, phone, name}``     session state

Used as the operational fallback when Evolution/Baileys can't
complete the WhatsApp Web handshake.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

import httpx

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 15.0


class BridgeError(RuntimeError):
    """Raised on non-2xx responses from the bridge. Carries status +
    parsed reason so the routing layer can decide how to surface."""

    def __init__(self, *, status_code: int, body: str, reason: str) -> None:
        self.status_code = status_code
        self.body = body
        self.reason = reason
        super().__init__(f"bridge error {status_code}: {reason}")


def _phone_to_chat_id(phone_e164: str) -> str:
    """``+5511987654321`` → ``5511987654321@c.us`` (1:1 chat JID)."""
    return phone_e164.lstrip("+") + "@c.us"


def _chat_id_to_e164(chat_id: str | None) -> str | None:
    """``5511987654321@c.us`` → ``+5511987654321``; ``None`` if shape off."""
    if not chat_id:
        return None
    bare = chat_id.split("@", 1)[0]
    if not bare.isdigit():
        return None
    return "+" + bare


class BridgeClient:
    """Async wrapper around the whatsapp-web.js bridge REST API."""

    def __init__(
        self,
        *,
        base_url: str,
        http_client: Optional[httpx.AsyncClient] = None,
    ) -> None:
        self._base = base_url.rstrip("/")
        self._http = http_client or httpx.AsyncClient(
            base_url=self._base, timeout=DEFAULT_TIMEOUT,
        )
        self._owns_http = http_client is None

    async def aclose(self) -> None:
        if self._owns_http:
            await self._http.aclose()

    async def _request(
        self, method: str, path: str, *, json: Any = None,
    ) -> httpx.Response:
        url = f"{self._base}{path}"
        resp = await self._http.request(
            method, url, json=json,
            headers={"Content-Type": "application/json"} if json is not None else None,
        )
        if resp.status_code >= 400:
            body = resp.text or ""
            reason: str = body[:200]
            try:
                payload = resp.json()
                if isinstance(payload, dict):
                    reason = (
                        payload.get("error")
                        or payload.get("message")
                        or body[:200]
                    )
            except Exception:
                pass
            raise BridgeError(
                status_code=resp.status_code, body=body, reason=str(reason),
            )
        return resp

    # ------------------------------------------------------------------
    # Send
    # ------------------------------------------------------------------

    async def send_text(self, phone_e164: str, text: str) -> str:
        body = {"chatId": _phone_to_chat_id(phone_e164), "message": text}
        resp = await self._request("POST", "/api/send", json=body)
        data = resp.json() or {}
        msg_id = (
            (data.get("messageId") if isinstance(data, dict) else None)
            or ""
        )
        if not msg_id:
            raise BridgeError(
                status_code=resp.status_code,
                body=resp.text or "",
                reason="missing messageId in send response",
            )
        return str(msg_id)

    # ------------------------------------------------------------------
    # Instance state
    # ------------------------------------------------------------------

    async def get_status(self) -> dict[str, Any]:
        """Mirror EvolutionClient.get_status: ``{connected, phone, state}``.

        bridge ``status`` values: ``"loading" | "qr_pending" | "ready" |
        "auth_failure" | "disconnected"``. We map ``"ready"`` →
        ``connected: True``.
        """
        resp = await self._request("GET", "/api/status")
        data = resp.json() or {}
        status = data.get("status")
        # Bridge returns the bare phone digits (no '+'). Normalize.
        raw_phone = data.get("phone")
        phone_e164 = (
            ("+" + raw_phone) if isinstance(raw_phone, str) and raw_phone.isdigit()
            else None
        )
        return {
            "connected": status == "ready",
            "phone": phone_e164,
            "state": status,
        }

    async def get_qr(self) -> tuple[str | None, str | None]:
        """Return ``(base64_png, state)`` to match EvolutionClient.

        - ``(b64, "qr_ready")`` — QR available; b64 is a ``data:image/png;base64,...``
        - ``(None, "ready")`` — already authenticated; no QR needed
        - ``(None, <state>)`` — bridge is loading / disconnected
        - ``(None, None)`` — unrecognized response
        """
        # Always check status first so we report the right state alongside.
        st = await self.get_status()
        state = st.get("state")
        if state == "ready":
            return None, "ready"
        if state != "qr_pending":
            # loading / disconnected / auth_failure → no QR yet
            return None, str(state) if state else None

        resp = await self._request("GET", "/api/qr")
        data = resp.json() or {}
        qr = data.get("qr") if isinstance(data, dict) else None
        if isinstance(qr, str) and qr:
            return qr, "qr_ready"
        return None, "qr_pending"
