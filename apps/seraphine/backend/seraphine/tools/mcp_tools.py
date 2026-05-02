"""Bridge MCP tools into Seraphine's Tool registry."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from seraphine.tools.base import Tool, ToolCategory, ToolResult
from seraphine.tools.mcp_client import McpClient
from seraphine.tools.registry import ToolRegistry

logger = logging.getLogger("seraphine.mcp")

# Tools that modify state require user confirmation before execution.
_CONFIRMATION_TOOLS = frozenset({
    "create_task",
    "update_task_status",
    "approve_task",
    "reject_task",
    "replan_task",
    "complete_task",
    "upload_image",
    "decide_suggestion",
    "create_suggestion",
})


class McpBridgeTool(Tool):
    """Wraps a single MCP tool as a Seraphine Tool."""

    def __init__(
        self,
        mcp_client: McpClient,
        tool_name: str,
        tool_description: str,
        tool_input_schema: dict[str, Any],
    ) -> None:
        self.name = tool_name
        self.description = tool_description
        self.json_schema = tool_input_schema
        self.requires_confirmation = tool_name in _CONFIRMATION_TOOLS
        self.category: ToolCategory = "network"
        self._client = mcp_client

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        try:
            result = await self._client.call_tool(self.name, args)
            # MCP tools/call returns {"content": [{"type":"text","text":"..."}], ...}
            content = result.get("content", [])
            texts: list[str] = []
            for item in content:
                if isinstance(item, dict) and item.get("type") == "text":
                    texts.append(item["text"])
            output = "\n".join(texts) if texts else json.dumps(result, indent=2)

            is_error = result.get("isError", False)
            if is_error:
                return ToolResult(ok=False, error=output)
            return ToolResult(ok=True, output=output)
        except Exception as exc:
            logger.exception("MCP tool %s failed", self.name)
            return ToolResult(ok=False, error=str(exc))


async def register_mcp_tools(registry: ToolRegistry, mcp_client: McpClient) -> int:
    """Discover MCP tools and register each as a McpBridgeTool.

    Returns the number of tools registered.
    """
    return await _sync_mcp_tools(registry, mcp_client)


async def _sync_mcp_tools(registry: ToolRegistry, mcp_client: McpClient) -> int:
    """(Re-)sync MCP tools into the registry. Can be called at startup
    AND whenever the server signals ``notifications/tools/list_changed``.
    New tools are added, removed tools are unregistered, existing tools
    get their schema refreshed."""
    tools = await mcp_client.list_tools()
    server_names: set[str] = set()
    count = 0
    for t in tools:
        name = t.get("name", "")
        if not name:
            continue
        server_names.add(name)
        bridge = McpBridgeTool(
            mcp_client=mcp_client,
            tool_name=name,
            tool_description=t.get("description", ""),
            tool_input_schema=t.get("inputSchema", {}),
        )
        registry.register(bridge)  # overwrites existing if same name
        count += 1

    # Log what changed
    existing = {t.name for t in registry.list() if isinstance(t, McpBridgeTool)}
    added = server_names - existing
    if added:
        for n in added:
            logger.info("MCP tool added: %s", n)
    logger.info("MCP tools synced: %d total", count)
    return count


def start_tools_changed_watcher(
    registry: ToolRegistry,
    mcp_client: McpClient,
    events_url: str,
    api_key: str,
) -> "asyncio.Task[None]":
    """Start a background task that listens for ``notifications/tools/list_changed``
    on the MCP SSE stream and re-syncs the tool registry automatically.

    This makes tool additions/removals on the Supertasks server show up
    in Seraphine without a restart.
    """
    import httpx as _httpx

    async def _watch() -> None:
        backoff = 1.0
        while True:
            try:
                async with _httpx.AsyncClient(timeout=None) as http:
                    headers = {
                        "Accept": "text/event-stream",
                        "Authorization": f"Bearer {api_key}",
                    }
                    if mcp_client._session_id:
                        headers["Mcp-Session-Id"] = mcp_client._session_id
                    async with http.stream("GET", events_url, headers=headers) as resp:
                        resp.raise_for_status()
                        backoff = 1.0
                        async for line in resp.aiter_lines():
                            if not line.startswith("data:"):
                                continue
                            data_str = line[len("data:"):].strip()
                            if not data_str:
                                continue
                            try:
                                msg = json.loads(data_str)
                            except json.JSONDecodeError:
                                continue
                            method = msg.get("method", "")
                            if method == "notifications/tools/list_changed":
                                logger.info("MCP tools/list_changed received — re-syncing")
                                try:
                                    await _sync_mcp_tools(registry, mcp_client)
                                except Exception as e:
                                    logger.warning("MCP tool re-sync failed: %s", e)
            except asyncio.CancelledError:
                return
            except Exception as e:
                logger.debug("MCP tools_changed watcher error: %s, retrying in %.0fs", e, backoff)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60)

    return asyncio.create_task(_watch())
