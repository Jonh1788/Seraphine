from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel


class ChatMessage(BaseModel):
    role: Literal["system", "user", "assistant", "tool"]
    content: str | list[dict[str, Any]]


class Token(BaseModel):
    text: str
    done: bool = False
    tool_calls: list[dict[str, Any]] | None = None


class LLMUnavailableError(Exception):
    pass
