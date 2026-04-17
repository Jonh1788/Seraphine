"""033 — Tool proxy broker.

Bridges in-flight tool calls from the server-side engine to the Mac
`.app` via the shared WebSocket. Each pending proxy is an asyncio
Future keyed by request_id. When the client sends
`tool_proxy_response`, the broker resolves the corresponding future.

Timeouts are enforced at the caller level (dispatcher uses
`asyncio.wait_for`).
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any

from seraphine.tools.base import ToolResult

logger = logging.getLogger("seraphine.proxy_broker")


class ProxyBroker:
    def __init__(self) -> None:
        self._pending: dict[str, asyncio.Future[ToolResult]] = {}

    def new_request_id(self) -> str:
        return str(uuid.uuid4())

    def register(self, request_id: str) -> asyncio.Future[ToolResult]:
        loop = asyncio.get_event_loop()
        fut: asyncio.Future[ToolResult] = loop.create_future()
        self._pending[request_id] = fut
        return fut

    def resolve(self, request_id: str, result: ToolResult) -> bool:
        fut = self._pending.pop(request_id, None)
        if fut is None or fut.done():
            return False
        fut.set_result(result)
        return True

    def cancel(self, request_id: str, error: str) -> None:
        fut = self._pending.pop(request_id, None)
        if fut is None or fut.done():
            return
        fut.set_result(ToolResult(ok=False, error=error))

    def any_client(self, app_state: Any) -> Any | None:
        """Return the first connected Tauri WS client, or None."""
        ws_clients = getattr(app_state, "ws_clients", None) or set()
        # Prefer clients flagged as Tauri; fall back to any.
        tauri_first = [
            ws for ws in ws_clients if getattr(ws, "_is_tauri", False)
        ]
        pool = tauri_first or list(ws_clients)
        return pool[0] if pool else None
