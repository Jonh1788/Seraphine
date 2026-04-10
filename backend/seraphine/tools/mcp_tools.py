"""Bridge MCP tools into Seraphine's Tool registry."""

from __future__ import annotations

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
    tools = await mcp_client.list_tools()
    count = 0
    for t in tools:
        name = t.get("name", "")
        if not name:
            continue
        bridge = McpBridgeTool(
            mcp_client=mcp_client,
            tool_name=name,
            tool_description=t.get("description", ""),
            tool_input_schema=t.get("inputSchema", {}),
        )
        registry.register(bridge)
        logger.info("Registered MCP tool: %s (confirmation=%s)", name, bridge.requires_confirmation)
        count += 1
    return count
