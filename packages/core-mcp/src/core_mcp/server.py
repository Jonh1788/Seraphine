"""MCP server base — stub for mac-agent / mobile-agent.

A future mac-agent will subclass MCPServer, register tools (mac.run_shortcut,
mac.applescript, mac.screenshot, etc.), open a WebSocket / reverse tunnel
to a Seraphine-VPS, and serve tool calls over it.

Phase 11 ships only the contract; the transport + JSON-RPC dispatch land
when the mac-agent feature is built.
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable

from core_mcp.types import Tool, ToolResult


ToolHandler = Callable[[dict[str, Any]], Awaitable[Any]]


class MCPServer:
    """Registry of tools + dispatch entry point. Transport-agnostic."""

    def __init__(self, *, name: str, version: str = "0.1.0") -> None:
        self.name = name
        self.version = version
        self._tools: dict[str, tuple[Tool, ToolHandler]] = {}

    def register(self, tool: Tool, handler: ToolHandler) -> None:
        self._tools[tool.name] = (tool, handler)

    def list_tools(self) -> list[Tool]:
        return [t for t, _ in self._tools.values()]

    async def dispatch(self, request_id: str, name: str, args: dict[str, Any]) -> ToolResult:
        entry = self._tools.get(name)
        if entry is None:
            return ToolResult(request_id=request_id, ok=False, error=f"unknown tool: {name}")
        _tool, handler = entry
        try:
            output = await handler(args)
            return ToolResult(request_id=request_id, ok=True, output=output)
        except Exception as exc:
            return ToolResult(request_id=request_id, ok=False, error=str(exc))
