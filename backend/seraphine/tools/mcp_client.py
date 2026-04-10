"""MCP Streamable HTTP client for JSON-RPC over SSE."""

from __future__ import annotations

import json
import logging
import uuid
from typing import Any

import httpx

logger = logging.getLogger("seraphine.mcp")


class McpClient:
    """Lightweight client for the MCP Streamable HTTP protocol.

    Handles session lifecycle (initialize → reuse session-id) and
    JSON-RPC request/response over SSE streams.
    """

    def __init__(
        self,
        base_url: str,
        api_key: str,
        timeout: float = 30.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout
        self._session_id: str | None = None
        self._http = httpx.AsyncClient(timeout=timeout)

    # ------------------------------------------------------------------
    # Low-level transport
    # ------------------------------------------------------------------

    def _headers(self) -> dict[str, str]:
        h: dict[str, str] = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "Authorization": f"Bearer {self.api_key}",
        }
        if self._session_id:
            h["Mcp-Session-Id"] = self._session_id
        return h

    async def _rpc(self, method: str, params: dict[str, Any] | None = None) -> Any:
        """Send a JSON-RPC 2.0 request and return the result."""
        payload: dict[str, Any] = {
            "jsonrpc": "2.0",
            "id": str(uuid.uuid4()),
            "method": method,
        }
        if params is not None:
            payload["params"] = params

        resp = await self._http.post(
            self.base_url,
            headers=self._headers(),
            json=payload,
        )
        resp.raise_for_status()

        # Capture session id from response headers
        sid = resp.headers.get("mcp-session-id")
        if sid:
            self._session_id = sid

        # Parse response — may be plain JSON or SSE
        content_type = resp.headers.get("content-type", "")
        if "text/event-stream" in content_type:
            return self._parse_sse(resp.text)
        else:
            body = resp.json()
            if "error" in body:
                raise McpError(body["error"].get("message", str(body["error"])))
            return body.get("result")

    @staticmethod
    def _parse_sse(text: str) -> Any:
        """Extract the last JSON-RPC result from an SSE stream."""
        result: Any = None
        for line in text.splitlines():
            if line.startswith("data:"):
                data_str = line[len("data:"):].strip()
                if not data_str:
                    continue
                try:
                    msg = json.loads(data_str)
                except json.JSONDecodeError:
                    continue
                if "error" in msg:
                    raise McpError(msg["error"].get("message", str(msg["error"])))
                if "result" in msg:
                    result = msg["result"]
        return result

    # ------------------------------------------------------------------
    # Session management
    # ------------------------------------------------------------------

    async def initialize(self) -> None:
        """Perform the MCP initialize handshake."""
        result = await self._rpc("initialize", {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": {"name": "seraphine", "version": "0.1.0"},
        })
        logger.info("MCP session initialized: %s", result)
        # Send initialized notification (no id, no response expected)
        payload = {
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
        }
        await self._http.post(
            self.base_url,
            headers=self._headers(),
            json=payload,
        )

    async def _ensure_session(self) -> None:
        if self._session_id is None:
            await self.initialize()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def list_tools(self) -> list[dict[str, Any]]:
        """Discover tools exposed by the MCP server."""
        await self._ensure_session()
        try:
            result = await self._rpc("tools/list")
        except (httpx.HTTPStatusError, McpError):
            # Session may have expired — reconnect once
            logger.warning("MCP session expired, re-initializing")
            self._session_id = None
            await self.initialize()
            result = await self._rpc("tools/list")
        return result.get("tools", []) if result else []

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        """Invoke a tool on the MCP server and return the result dict."""
        await self._ensure_session()
        try:
            result = await self._rpc("tools/call", {"name": name, "arguments": arguments})
        except (httpx.HTTPStatusError, McpError):
            logger.warning("MCP session expired during call_tool, re-initializing")
            self._session_id = None
            await self.initialize()
            result = await self._rpc("tools/call", {"name": name, "arguments": arguments})
        return result if result else {}

    async def aclose(self) -> None:
        await self._http.aclose()


class McpError(Exception):
    """Raised when the MCP server returns a JSON-RPC error."""
