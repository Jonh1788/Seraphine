from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from seraphine.tools.base import Tool, ToolResult

MAX_OUTPUT = 8 * 1024


class RunShellTool(Tool):
    name = "run_shell"
    description = "Run a shell command and capture stdout/stderr (60s timeout)."
    json_schema = {
        "type": "object",
        "properties": {
            "command": {"type": "string"},
            "cwd": {"type": "string"},
        },
        "required": ["command"],
    }
    requires_confirmation = True
    category = "shell"
    # 033 — when Mac client is connected, forward to local shell
    # instead of the VPS container.
    proxy_to_client = True

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        command = str(args.get("command", ""))
        cwd = str(args.get("cwd") or Path.home())
        try:
            proc = await asyncio.create_subprocess_shell(
                command,
                cwd=cwd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=60)
            except asyncio.TimeoutError:
                proc.kill()
                return ToolResult(ok=False, error="timeout")
            combined = (stdout or b"") + (stderr or b"")
            text = combined.decode("utf-8", errors="replace")[:MAX_OUTPUT]
            rc = proc.returncode or 0
            if rc != 0:
                return ToolResult(
                    ok=False,
                    error=f"exit {rc}",
                    output=text,
                    metadata={"exit_code": rc},
                )
            return ToolResult(ok=True, output=text, metadata={"exit_code": rc})
        except Exception as e:
            return ToolResult(ok=False, error=str(e))
