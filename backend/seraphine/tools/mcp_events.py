"""SSE listener for Supertasks MCP task events.

Connects to GET /events and listens for task status changes.
When a task created by Seraphine changes status (done, failed,
awaiting_approval), pushes a notification through all connected
WebSockets so the frontend can display it and Seraphine can
announce it via TTS.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

import httpx

logger = logging.getLogger("seraphine.mcp_events")


class McpEventListener:
    """Background SSE listener for Supertasks /events endpoint."""

    def __init__(
        self,
        events_url: str,
        api_key: str,
        *,
        timeout: float = 0.0,  # 0 = no timeout (infinite stream)
        reconnect_delay: float = 5.0,
    ) -> None:
        self.events_url = events_url
        self.api_key = api_key
        self.reconnect_delay = reconnect_delay
        self._task: asyncio.Task[None] | None = None
        self._stopped = False
        self._callbacks: list[Any] = []

    def on_event(self, callback: Any) -> None:
        """Register a callback: async def callback(event_type: str, data: dict)"""
        self._callbacks.append(callback)

    def off_event(self, callback: Any) -> None:
        """Unregister a previously registered callback. No-op if not found."""
        try:
            self._callbacks.remove(callback)
        except ValueError:
            pass

    def start(self) -> None:
        """Start the background SSE listener loop."""
        if self._task is not None:
            return
        self._stopped = False
        self._task = asyncio.create_task(self._listen_loop())
        logger.info("MCP event listener started: %s", self.events_url)

    async def stop(self) -> None:
        """Stop the listener."""
        self._stopped = True
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None
        logger.info("MCP event listener stopped")

    async def _listen_loop(self) -> None:
        """Reconnecting SSE loop."""
        while not self._stopped:
            try:
                await self._connect_and_listen()
            except asyncio.CancelledError:
                return
            except Exception as e:
                if self._stopped:
                    return
                logger.warning(
                    "MCP SSE connection lost (%s), reconnecting in %.0fs...",
                    e, self.reconnect_delay,
                )
                await asyncio.sleep(self.reconnect_delay)

    async def _connect_and_listen(self) -> None:
        """Single SSE connection — reads events until disconnect."""
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Accept": "text/event-stream",
        }
        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream(
                "GET", self.events_url, headers=headers
            ) as resp:
                resp.raise_for_status()
                logger.info("SSE connected to %s", self.events_url)

                event_type = ""
                data_lines: list[str] = []

                async for line in resp.aiter_lines():
                    if self._stopped:
                        return
                    if line.startswith("event: "):
                        event_type = line[7:].strip()
                    elif line.startswith("data: "):
                        data_lines.append(line[6:])
                    elif line == "" and (event_type or data_lines):
                        # End of event
                        raw = "\n".join(data_lines)
                        data_lines = []
                        if event_type == "connected":
                            event_type = ""
                            continue
                        try:
                            data = json.loads(raw) if raw else {}
                        except json.JSONDecodeError:
                            data = {"raw": raw}
                        if event_type:
                            await self._dispatch(event_type, data)
                        event_type = ""

    async def _dispatch(self, event_type: str, data: dict[str, Any]) -> None:
        """Fire all registered callbacks."""
        logger.info("MCP event: %s (task=%s)", event_type, data.get("id", "?"))
        for cb in self._callbacks:
            try:
                await cb(event_type, data)
            except Exception as e:
                logger.warning("MCP event callback failed: %s", e)
