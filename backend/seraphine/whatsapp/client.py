"""Async client for the WhatsApp bridge REST API.

Wraps httpx calls to the Node.js whatsapp-web.js bridge service
(default ``http://localhost:3001``). All methods raise on non-2xx
responses with clear messages.

See ``specs/008-whatsapp-integration.md`` for the full API contract.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 10.0


class WhatsAppBridgeError(RuntimeError):
    """Raised when the bridge returns a non-2xx response."""


class WhatsAppBridgeClient:
    """Async HTTP wrapper for the whatsapp-bridge REST API."""

    def __init__(self, base_url: str, timeout: float = DEFAULT_TIMEOUT) -> None:
        self._base_url = base_url.rstrip("/")
        self._client = httpx.AsyncClient(
            base_url=self._base_url, timeout=timeout
        )

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json: Any = None,
    ) -> httpx.Response:
        resp = await self._client.request(method, path, params=params, json=json)
        if resp.status_code >= 400:
            raise WhatsAppBridgeError(
                f"whatsapp bridge {method} {path} failed: "
                f"{resp.status_code} {resp.text[:500]}"
            )
        return resp

    async def status(self) -> dict:
        """GET /api/status — connection state, phone, name."""
        resp = await self._request("GET", "/api/status")
        return resp.json()

    async def qr(self) -> dict:
        """GET /api/qr — QR code data URL for authentication."""
        resp = await self._request("GET", "/api/qr")
        return resp.json()

    async def list_chats(
        self, limit: int = 20, unread_only: bool = False
    ) -> list[dict]:
        """GET /api/chats — recent chats with preview + unread count."""
        params: dict[str, Any] = {"limit": limit}
        if unread_only:
            params["unreadOnly"] = "true"
        resp = await self._request("GET", "/api/chats", params=params)
        return resp.json().get("chats", [])

    async def read_messages(self, chat_id: str, limit: int = 30) -> dict:
        """GET /api/messages/:chatId — messages from a specific chat."""
        resp = await self._request(
            "GET", f"/api/messages/{chat_id}", params={"limit": limit}
        )
        return resp.json()

    async def send_message(
        self,
        chat_id: str,
        message: str,
        quote_msg_id: str | None = None,
    ) -> dict:
        """POST /api/send — send a text message."""
        body: dict[str, Any] = {"chatId": chat_id, "message": message}
        if quote_msg_id:
            body["quoteMsgId"] = quote_msg_id
        resp = await self._request("POST", "/api/send", json=body)
        return resp.json()

    async def search(
        self,
        query: str,
        chat_id: str | None = None,
        limit: int = 20,
    ) -> list[dict]:
        """GET /api/search — search message history by text."""
        params: dict[str, Any] = {"query": query, "limit": limit}
        if chat_id:
            params["chatId"] = chat_id
        resp = await self._request("GET", "/api/search", params=params)
        return resp.json().get("results", [])

    async def send_voice(
        self,
        chat_id: str,
        audio_base64: str,
        quote_msg_id: str | None = None,
    ) -> dict:
        """POST /api/send — send a voice note (base64 ogg/opus audio)."""
        body: dict[str, Any] = {"chatId": chat_id, "audio": audio_base64}
        if quote_msg_id:
            body["quoteMsgId"] = quote_msg_id
        resp = await self._request("POST", "/api/send", json=body)
        return resp.json()

    async def contacts(self, query: str | None = None) -> list[dict]:
        """GET /api/contacts — list contacts, optionally filtered by name."""
        params: dict[str, Any] = {}
        if query:
            params["query"] = query
        resp = await self._request("GET", "/api/contacts", params=params)
        return resp.json().get("contacts", [])

    async def aclose(self) -> None:
        """Close the underlying httpx client."""
        await self._client.aclose()
