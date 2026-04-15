"""MCP (Model Context Protocol) message types — minimal subset.

Wire format mirrors the public MCP spec (JSON-RPC 2.0 over a transport).
This is a stub: the full spec covers many more message kinds. We add
them here only when an actual mac-agent / mobile-agent feature requires
one — premature completeness is just dead code.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class Tool:
    """Server-advertised tool: name, description, JSON schema for args."""

    name: str
    description: str
    input_schema: dict[str, Any]


@dataclass
class ToolCall:
    """Client-issued invocation."""

    name: str
    arguments: dict[str, Any]
    request_id: str


@dataclass
class ToolResult:
    """Server response. ``ok=False`` → ``error`` carries human-readable detail."""

    request_id: str
    ok: bool
    output: Any = None
    error: str | None = None


@dataclass
class HelloMessage:
    """First frame on connect — server announces tools, client presents
    auth token. Bidirectional handshake."""

    role: str  # "server" | "client"
    auth_token: str | None = None
    tools: list[Tool] = field(default_factory=list)
    name: str = ""
    version: str = "0.1.0"
