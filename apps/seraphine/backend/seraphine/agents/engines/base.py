"""Engine protocol: how the harness drives an agent CLI / model."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Protocol, runtime_checkable

#: Sandbox tiers. ``read-only`` (edit blocked) / ``workspace-write`` (edit
#: free, limited to the project folder). There is deliberately no tier that
#: lifts the sandbox.
SANDBOX_READ_ONLY = "read-only"
SANDBOX_WORKSPACE_WRITE = "workspace-write"

#: ``on_event(kind, payload)``. ``kind`` is one of the harness event kinds the
#: engine may produce: ``step`` | ``message`` | ``command`` | ``error``.
#:
#: Two INTERNAL kinds (leading underscore) are never stored as run events nor
#: sent to clients; the service consumes them:
#: ``_session`` ``{"session_ref": str}``: the engine session is known (send it as
#: soon as the stream reveals it, so a restart can resume);
#: ``_process`` ``{"pid": int, "created": int | None}``: engine process started.
#:
#: Action steps (command, file change, tool call) carry ``phase``
#: (``started`` | ``completed``) and ``call_id``; an engine whose stream only
#: reports the end of an action emits a single ``completed``.
OnEvent = Callable[[str, dict], Awaitable[None]]


def process_reporter(on_event: OnEvent) -> Callable[[int, int | None], Awaitable[None]]:
    """``on_spawn`` callback for ``procutil.run_lines`` that reports the engine pid."""
    async def _report(pid: int, created: int | None) -> None:
        await on_event("_process", {"pid": pid, "created": created})

    return _report


#: Name of the MCP server the Seraphine bridge is declared as (models see ``mcp__seraphine__<tool>``).
BRIDGE_SERVER = "seraphine"


@dataclass(frozen=True)
class BridgeSpec:
    """How an engine reaches the Seraphine tools in ONE turn (phase 3b). Built by the gateway
    only when the agent has at least one tool besides ``ping``; the engine declares the MCP
    server ``server`` (``python -I -S script``) and hands it three values through ``env``.
    ``token`` is the turn token: never printed, logged or written to disk."""
    server: str
    python: str
    script: str
    url: str
    tools_file: str
    token: str = field(repr=False)

    ENV_URL = "SERAPHINE_BRIDGE_URL"
    ENV_TOKEN = "SERAPHINE_BRIDGE_TOKEN"
    ENV_TOOLS = "SERAPHINE_BRIDGE_TOOLS"

    @property
    def command_args(self) -> list[str]:
        return ["-I", "-S", self.script]

    def env(self) -> dict[str, str]:
        return {self.ENV_URL: self.url, self.ENV_TOKEN: self.token, self.ENV_TOOLS: self.tools_file}


@dataclass
class EngineContext:
    project_path: Path
    prompt: str
    sandbox: str = SANDBOX_WORKSPACE_WRITE
    model: str | None = None
    #: Resolved catalog entry (``providers.Provider``) the runtime thinks with.
    provider: Any = None
    #: ``low`` | ``medium`` | ``high`` | None (runtime default).
    reasoning_effort: str | None = None
    #: Seraphine tools offered in this turn (None: none; the engine changes nothing).
    bridge: BridgeSpec | None = None


@dataclass
class EngineResult:
    final_message: str = ""
    session_ref: str | None = None
    exit_code: int | None = None
    tokens_in: int = 0
    tokens_out: int = 0
    #: Input tokens of the LAST model call of the turn, i.e. how big the session's context is now
    #: (None: the engine does not say). Decides whether a conversation's session is reused.
    last_input_tokens: int | None = None
    cost_usd: float = 0.0
    error: str | None = None
    #: Stable failure slug (``engine_auth``, ``session_not_found``...); None -> ``engine_error``.
    error_code: str | None = None
    #: Phase 1b: the failure is one the owner/time can fix, so the run is parked
    #: instead of failed. ``outage`` | ``plan_limit`` | ``auth`` (``error_code``
    #: ``engine_auth`` also means ``auth``); None -> an ordinary failure.
    wait_kind: str | None = None
    #: ``plan_limit`` only: ISO 8601 UTC instant the limit resets, when known.
    retry_at: str | None = None
    extra: dict = field(default_factory=dict)


@runtime_checkable
class Engine(Protocol):
    name: str
    #: False for engines that cannot touch files/commands (conversation only).
    can_act: bool

    def available(self) -> tuple[bool, str]:
        """``(ok, reason)``: is the engine usable right now, and why not."""
        ...

    async def run(
        self, ctx: EngineContext, on_event: OnEvent, cancel: asyncio.Event,
    ) -> EngineResult:
        ...

    async def resume(
        self, ctx: EngineContext, session_ref: str, message: str,
        on_event: OnEvent, cancel: asyncio.Event,
    ) -> EngineResult:
        ...


SESSION_NOT_FOUND = "session_not_found"


def session_reusable(engine: Any) -> bool:
    """Can a NEW run resume a session this engine kept from an earlier run? (conversation continuity)"""
    return bool(getattr(engine, "resumable_after_restart", False)
                or getattr(engine, "resumable_across_runs", False))


def clip(text: str, limit: int) -> str:
    """Truncate ``text`` to ``limit`` chars with a marker."""
    if len(text) <= limit:
        return text
    return text[:limit] + "\n[... truncado ...]"
