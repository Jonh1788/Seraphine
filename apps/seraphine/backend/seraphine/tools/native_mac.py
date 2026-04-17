"""034 — Native Mac tools (proxied to Tauri client).

Server-side stubs: the real work happens in the .app via
`mac_tools.rs`. Here we just declare the tool contract so the LLM
sees it in the registry.
"""

from __future__ import annotations

from typing import Any

from seraphine.tools.base import Tool, ToolResult


class OsascriptTool(Tool):
    name = "osascript"
    description = (
        "Run arbitrary AppleScript on the user's Mac. Powerful: can "
        "control any scriptable app (iMessage send, Spotify play, "
        "Notes.app create, etc). Pass the full script in 'script'. "
        "15s timeout. Requires confirmation."
    )
    json_schema = {
        "type": "object",
        "properties": {"script": {"type": "string"}},
        "required": ["script"],
    }
    requires_confirmation = True
    category = "other"
    proxy_to_client = True

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        return ToolResult(ok=False, error="must be proxied to Mac client")


class ShortcutsRunTool(Tool):
    name = "shortcuts_run"
    description = (
        "Run a Shortcut by name from the macOS Shortcuts.app. The user "
        "creates shortcuts once in that app and you invoke them here. "
        "Optional 'input' is piped to the shortcut stdin."
    )
    json_schema = {
        "type": "object",
        "properties": {
            "name": {"type": "string"},
            "input": {"type": "string"},
        },
        "required": ["name"],
    }
    requires_confirmation = True
    category = "other"
    proxy_to_client = True

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        return ToolResult(ok=False, error="must be proxied to Mac client")


class OpenPathTool(Tool):
    name = "open_path"
    description = (
        "Open a file, folder, or URL on the Mac with the default app. "
        "Equivalent to `open <target>` in shell. For URLs, make sure "
        "they start with http(s)://."
    )
    json_schema = {
        "type": "object",
        "properties": {"target": {"type": "string"}},
        "required": ["target"],
    }
    requires_confirmation = False
    category = "other"
    proxy_to_client = True

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        return ToolResult(ok=False, error="must be proxied to Mac client")


class ActiveAppTool(Tool):
    name = "active_app"
    description = (
        "Get the currently focused macOS app (name and, if accessible, "
        "window title). Useful to adapt suggestions to the user's "
        "current context."
    )
    json_schema = {"type": "object", "properties": {}}
    requires_confirmation = False
    category = "other"
    proxy_to_client = True

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        return ToolResult(ok=False, error="must be proxied to Mac client")
