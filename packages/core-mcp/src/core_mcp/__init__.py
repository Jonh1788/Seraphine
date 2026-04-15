"""core-mcp — Model Context Protocol primitives.

Stub package for the upcoming mac-agent / mobile-agent. Today only:
- Wire types (Tool, ToolCall, ToolResult, HelloMessage)
- Server-side tool registry + dispatch (transport-agnostic)

Transport (WebSocket, JSON-RPC 2.0 framing, auth handshake) lands when
the mac-agent feature is built.
"""

from core_mcp.types import HelloMessage, Tool, ToolCall, ToolResult
from core_mcp.server import MCPServer, ToolHandler

__all__ = [
    "HelloMessage",
    "Tool",
    "ToolCall",
    "ToolResult",
    "MCPServer",
    "ToolHandler",
]
