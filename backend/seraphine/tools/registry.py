from __future__ import annotations

from pathlib import Path
from typing import Any, Iterator

from seraphine.tools.base import Tool
from seraphine.tools.filesystem import ListDirTool, ReadFileTool, WriteFileTool
from seraphine.tools.meta import RequestSkillTool
from seraphine.tools.shell import RunShellTool
from seraphine.tools.web import WebFetchTool


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, Tool] = {}

    def register(self, tool: Tool) -> None:
        self._tools[tool.name] = tool

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    def list(self) -> list[Tool]:
        return list(self._tools.values())

    def as_ollama_tools(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for t in self._tools.values():
            out.append(
                {
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.json_schema,
                    },
                }
            )
        return out

    def __contains__(self, name: object) -> bool:
        return isinstance(name, str) and name in self._tools

    def __iter__(self) -> Iterator[Tool]:
        return iter(self._tools.values())


def build_default_registry(
    allowed_roots: list[Path],
    *,
    skills_dir: Path | None = None,
) -> ToolRegistry:
    reg = ToolRegistry()
    reg.register(ReadFileTool(allowed_roots))
    reg.register(ListDirTool(allowed_roots))
    reg.register(WriteFileTool(allowed_roots))
    reg.register(RunShellTool())
    reg.register(WebFetchTool())
    if skills_dir is not None:
        reg.register(RequestSkillTool(skills_dir))
    return reg
