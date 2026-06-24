"""Inference-engine abstraction (OpenJarvis #4). ADDITIVE — existing clients
already satisfy `InferenceEngine` structurally; this adds a typed surface +
capability introspection without changing any client (Aura-safe)."""
from __future__ import annotations
from dataclasses import dataclass
from typing import Any, AsyncIterator, Protocol, runtime_checkable

from llm_adapters.types import ChatMessage, Token


@runtime_checkable
class InferenceEngine(Protocol):
    async def chat(self, messages: list[ChatMessage], *, model: str | None = None,
                   temperature: float = 0.7, audio: bytes | None = None,
                   tools: list[dict[str, Any]] | None = None,
                   think: bool = False) -> AsyncIterator[Token]: ...

    async def aclose(self) -> None: ...


@dataclass(frozen=True)
class EngineInfo:
    name: str
    backend: str
    model: str
    is_local: bool
    is_flat_cost: bool
    supports_tools: bool
    supports_vision: bool


_LOCAL_HINTS = ("127.0.0.1", "localhost", "0.0.0.0", "::1")


def describe_engine(*, backend: str, model: str, base_url: str = "") -> EngineInfo:
    """Pure introspection of an engine's capabilities from its config."""
    b = (backend or "").lower()
    bu = (base_url or "").lower()
    is_cliproxy = b in ("anthropic", "claude_max") and any(h in bu for h in ("cliproxy", *_LOCAL_HINTS))
    local = b in ("openai", "ollama", "apple_fm") or any(h in bu for h in _LOCAL_HINTS)
    flat = b in ("claude_max", "openai", "ollama", "apple_fm") or is_cliproxy
    tools = b in ("anthropic", "claude_max", "openai", "ollama")
    vision = b in ("anthropic", "claude_max")
    if b in ("anthropic", "claude_max"):
        name = "Claude (cliproxy)" if is_cliproxy else ("Claude Max" if b == "claude_max" else "Claude")
    elif b == "openai":
        name = "Local (MLX/LM Studio)"
    elif b == "ollama":
        name = "Ollama"
    elif b == "apple_fm":
        name = "Apple FM"
    else:
        name = backend or "unknown"
    return EngineInfo(name=name, backend=("cliproxy" if is_cliproxy else b), model=model,
                      is_local=local, is_flat_cost=flat, supports_tools=tools, supports_vision=vision)
