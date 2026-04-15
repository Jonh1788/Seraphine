from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Literal

from pydantic import BaseModel


class ToolResult(BaseModel):
    ok: bool
    output: str | None = None
    error: str | None = None
    metadata: dict[str, Any] = {}


ToolCategory = Literal["filesystem", "shell", "network", "memory", "other"]


class Tool(ABC):
    """Abstract tool. See specs/003-tool-use-with-gate.md."""

    name: str
    description: str
    json_schema: dict[str, Any]
    requires_confirmation: bool = True
    category: ToolCategory = "other"

    @abstractmethod
    async def execute(self, args: dict[str, Any]) -> ToolResult:
        ...

    def declaration(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "json_schema": self.json_schema,
            "requires_confirmation": self.requires_confirmation,
            "category": self.category,
        }
