"""036 — Dev sidekick tools.

Structured wrappers around common developer workflows. All
proxy_to_client=True so they execute on the user's Mac (not the VPS).
Implementation: the tool just declares the contract; the real work
happens via the frontend proxy handler which in turn shells out
locally.

Tools:
- git_status
- git_diff
- edit_file      — patch-style, exact-match replace
- run_tests      — auto-detects framework
- search_code    — ripgrep wrapper
"""

from __future__ import annotations

from typing import Any

from seraphine.tools.base import Tool, ToolResult


class GitStatusTool(Tool):
    name = "git_status"
    description = (
        "Return git status for a repo. Pass 'path' to a directory "
        "inside the repo (default: cwd). Outputs plain text (git "
        "status --short --branch)."
    )
    json_schema = {
        "type": "object",
        "properties": {"path": {"type": "string"}},
    }
    requires_confirmation = False
    category = "other"
    proxy_to_client = True

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        return ToolResult(ok=False, error="must be proxied to Mac client")


class GitDiffTool(Tool):
    name = "git_diff"
    description = (
        "Show git diff for a repo. 'staged' (bool) toggles --cached. "
        "'path' optional inside-repo directory."
    )
    json_schema = {
        "type": "object",
        "properties": {
            "path": {"type": "string"},
            "staged": {"type": "boolean"},
        },
    }
    requires_confirmation = False
    category = "other"
    proxy_to_client = True

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        return ToolResult(ok=False, error="must be proxied to Mac client")


class EditFileTool(Tool):
    name = "edit_file"
    description = (
        "Patch-style file edit: replace EXACTLY ONE occurrence of "
        "'old' with 'new' in the file at 'path'. Fails if 'old' is "
        "missing or appears more than once. Use this instead of "
        "rewriting the whole file."
    )
    json_schema = {
        "type": "object",
        "properties": {
            "path": {"type": "string"},
            "old": {"type": "string"},
            "new": {"type": "string"},
        },
        "required": ["path", "old", "new"],
    }
    requires_confirmation = True
    category = "filesystem"
    proxy_to_client = True

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        return ToolResult(ok=False, error="must be proxied to Mac client")


class RunTestsTool(Tool):
    name = "run_tests"
    description = (
        "Detect the test framework (pytest/jest/cargo/go) in 'path' "
        "(or cwd) and run it. Returns captured stdout/stderr with "
        "5min timeout."
    )
    json_schema = {
        "type": "object",
        "properties": {
            "path": {"type": "string"},
            "filter": {"type": "string", "description": "test name filter"},
        },
    }
    requires_confirmation = False
    category = "other"
    proxy_to_client = True

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        return ToolResult(ok=False, error="must be proxied to Mac client")


class SearchCodeTool(Tool):
    name = "search_code"
    description = (
        "Search text across files using ripgrep. 'query' is a regex. "
        "'path' optional (defaults to cwd). 'file_type' optional "
        "(ex: py, ts, rust)."
    )
    json_schema = {
        "type": "object",
        "properties": {
            "query": {"type": "string"},
            "path": {"type": "string"},
            "file_type": {"type": "string"},
        },
        "required": ["query"],
    }
    requires_confirmation = False
    category = "other"
    proxy_to_client = True

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        return ToolResult(ok=False, error="must be proxied to Mac client")
