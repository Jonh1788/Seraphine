from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from pydantic import BaseModel


class ToolResult(BaseModel):
    ok: bool
    output: str | None = None
    error: str | None = None
    metadata: dict[str, Any] = {}


class Tool(ABC):
    """Abstract tool. See specs/003-tool-use-with-gate.md."""

    name: str
    description: str
    json_schema: dict[str, Any]
    requires_confirmation: bool = True

    @abstractmethod
    async def execute(self, args: dict[str, Any]) -> ToolResult:
        ...
        # TODO(phase 4): concrete tools (read_file, list_dir, run_shell, write_file).
