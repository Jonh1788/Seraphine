"""Async HTTP client for the Browser Agent service (Playwright REST at :3002).

Wraps httpx calls to the browser automation microservice built by the
parallel agent.  All methods return the parsed JSON response dict.
Errors raise ``BrowserAgentError`` with a clear message.

See ``specs/009-browser-automation.md`` for the full API contract.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 30.0


class BrowserAgentError(RuntimeError):
    """Raised when the browser agent service returns a non-2xx response."""


class BrowserAgentClient:
    """Async HTTP wrapper for the browser-agent REST API."""

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
    ) -> dict[str, Any]:
        resp = await self._client.request(method, path, params=params, json=json)
        if resp.status_code >= 400:
            raise BrowserAgentError(
                f"browser agent {method} {path} failed: "
                f"{resp.status_code} {resp.text[:500]}"
            )
        return resp.json()

    # ── Navigation ────────────────────────────────────────────────

    async def navigate(self, url: str) -> dict[str, Any]:
        """POST /navigate — open a URL in the browser."""
        return await self._request("POST", "/navigate", json={"url": url})

    async def screenshot(self, full_page: bool = False) -> dict[str, Any]:
        """POST /screenshot — capture the current viewport.

        Returns ``{"image": "<base64>", "width": int, "height": int}``.
        """
        return await self._request(
            "POST", "/screenshot", json={"full_page": full_page}
        )

    async def click(
        self,
        x: int | None = None,
        y: int | None = None,
        selector: str | None = None,
    ) -> dict[str, Any]:
        """POST /click — click at coordinates or CSS selector."""
        body: dict[str, Any] = {}
        if x is not None:
            body["x"] = x
        if y is not None:
            body["y"] = y
        if selector is not None:
            body["selector"] = selector
        return await self._request("POST", "/click", json=body)

    async def type_text(
        self,
        text: str,
        clear_first: bool = False,
        press_enter: bool = False,
    ) -> dict[str, Any]:
        """POST /type — type text into the focused element."""
        return await self._request(
            "POST",
            "/type",
            json={
                "text": text,
                "clear_first": clear_first,
                "press_enter": press_enter,
            },
        )

    async def scroll(
        self, direction: str = "down", amount: int = 500
    ) -> dict[str, Any]:
        """POST /scroll — scroll the page."""
        return await self._request(
            "POST", "/scroll", json={"direction": direction, "amount": amount}
        )

    async def keyboard(self, key: str) -> dict[str, Any]:
        """POST /keyboard — press a single keyboard key."""
        return await self._request("POST", "/keyboard", json={"key": key})

    async def select(self, selector: str, value: str) -> dict[str, Any]:
        """POST /select — select an option from a <select> element."""
        return await self._request(
            "POST", "/select", json={"selector": selector, "value": value}
        )

    async def page_info(self) -> dict[str, Any]:
        """GET /page — get current URL and title."""
        return await self._request("GET", "/page")

    async def close(self) -> dict[str, Any]:
        """POST /close — close the browser page."""
        return await self._request("POST", "/close")

    async def health(self) -> dict[str, Any]:
        """GET /health — health check."""
        return await self._request("GET", "/health")

    async def aclose(self) -> None:
        """Close the underlying httpx client."""
        await self._client.aclose()
