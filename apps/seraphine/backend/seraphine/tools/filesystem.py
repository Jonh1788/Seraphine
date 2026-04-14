from __future__ import annotations

from pathlib import Path
from typing import Any

from seraphine.tools.base import Tool, ToolResult

MAX_READ_BYTES = 256 * 1024


def _check_allowed_root(path: Path, roots: list[Path]) -> bool:
    try:
        resolved = path.resolve()
    except Exception:
        return False
    for r in roots:
        try:
            resolved.relative_to(r.resolve())
            return True
        except ValueError:
            continue
    return False


class ReadFileTool(Tool):
    name = "read_file"
    description = "Read a text file under allowed roots (max 256KB)."
    json_schema = {
        "type": "object",
        "properties": {"path": {"type": "string"}},
        "required": ["path"],
    }
    requires_confirmation = False
    category = "filesystem"

    def __init__(self, allowed_roots: list[Path]) -> None:
        self.allowed_roots = [Path(r) for r in allowed_roots]

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        try:
            path = Path(str(args["path"])).expanduser()
            if not _check_allowed_root(path, self.allowed_roots):
                return ToolResult(ok=False, error="path not allowed")
            data = path.read_bytes()[:MAX_READ_BYTES]
            return ToolResult(ok=True, output=data.decode("utf-8", errors="replace"))
        except Exception as e:
            return ToolResult(ok=False, error=str(e))


class ListDirTool(Tool):
    name = "list_dir"
    description = "List entries in a directory under allowed roots."
    json_schema = {
        "type": "object",
        "properties": {"path": {"type": "string"}},
        "required": ["path"],
    }
    requires_confirmation = False
    category = "filesystem"

    def __init__(self, allowed_roots: list[Path]) -> None:
        self.allowed_roots = [Path(r) for r in allowed_roots]

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        try:
            path = Path(str(args["path"])).expanduser()
            if not _check_allowed_root(path, self.allowed_roots):
                return ToolResult(ok=False, error="path not allowed")
            if not path.is_dir():
                return ToolResult(ok=False, error="not a directory")
            entries = sorted(path.iterdir(), key=lambda p: p.name)
            lines = [f"{p.name}/" if p.is_dir() else p.name for p in entries]
            return ToolResult(ok=True, output="\n".join(lines))
        except Exception as e:
            return ToolResult(ok=False, error=str(e))


class WriteFileTool(Tool):
    name = "write_file"
    description = "Write content to a file under allowed roots."
    json_schema = {
        "type": "object",
        "properties": {
            "path": {"type": "string"},
            "content": {"type": "string"},
        },
        "required": ["path", "content"],
    }
    requires_confirmation = True
    category = "filesystem"

    def __init__(self, allowed_roots: list[Path]) -> None:
        self.allowed_roots = [Path(r) for r in allowed_roots]

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        try:
            path = Path(str(args["path"])).expanduser()
            content = str(args["content"])
            if not _check_allowed_root(path, self.allowed_roots):
                return ToolResult(ok=False, error="path not allowed")
            path.parent.mkdir(parents=True, exist_ok=True)
            data = content.encode("utf-8")
            path.write_bytes(data)
            return ToolResult(ok=True, output=f"wrote {len(data)} bytes")
        except Exception as e:
            return ToolResult(ok=False, error=str(e))
