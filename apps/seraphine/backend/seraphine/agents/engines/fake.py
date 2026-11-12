"""Deterministic scripted engine for tests (never registered in production)."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Any

from seraphine.agents.engines.base import EngineContext, EngineResult, OnEvent


Events = list[tuple[str, dict[str, Any]]]


def command_events(command: str, *, call_id: str | None = None, exit_code: int = 0,
                   output: str = "", paired: bool = False, **extra: Any) -> Events:
    """One command action: a single ``command`` event, or (``paired``) a started step and its end."""
    if not paired:
        return [("command", {"command": command, "exit_code": exit_code, "output": output,
                             "by": "agent", **({"call_id": call_id} if call_id else {}), **extra})]
    cid = call_id or f"call-{abs(hash((command, exit_code, output))) % 10**8}"
    return [("step", {"type": "command", "phase": "started", "call_id": cid, "command": command,
                      "by": "agent", **extra}),
            ("command", {"command": command, "exit_code": exit_code, "output": output, "by": "agent",
                         "phase": "completed", "call_id": cid, **extra})]


def many_actions(n: int, *, paired: bool = False) -> Events:
    """``n`` different commands (``cmd-1`` ... ``cmd-n``), all succeeding."""
    out: Events = []
    for i in range(1, n + 1):
        out += command_events(f"cmd-{i}", call_id=f"call-{i}", paired=paired)
    return out


def repeated_action(command: str, n: int, *, paired: bool = False) -> Events:
    """The same command ``n`` times in a row, succeeding."""
    out: Events = []
    for i in range(1, n + 1):
        out += command_events(command, call_id=f"rep-{i}", paired=paired)
    return out


def failing_actions(n: int, *, command: str | None = None, error: str = "boom",
                    exit_code: int = 1, paired: bool = False) -> Events:
    """``n`` failing commands. ``command`` given: always that one (same error each time);
    otherwise ``fail-1`` ... ``fail-n`` (different actions)."""
    out: Events = []
    for i in range(1, n + 1):
        out += command_events(command or f"fail-{i}", call_id=f"fail-{i}", exit_code=exit_code,
                              output=error, paired=paired)
    return out


@dataclass
class FakeTurn:
    """One scripted engine turn (a ``run`` or a ``resume`` call)."""

    final_message: str = "Concluído."
    events: list[tuple[str, dict[str, Any]]] = field(default_factory=lambda: [
        ("step", {"type": "reasoning", "text": "analisando"}),
        ("command", {"command": "ls", "exit_code": 0, "output": "a.txt", "by": "agent"}),
    ])
    #: When set, the final message ends with an ``approval-request`` block.
    approval: dict[str, str] | None = None
    #: When set, the turn fails with this error.
    fail: str | None = None
    #: A classified failure (phase 1b): ``outage`` | ``plan_limit`` | ``auth``, with
    #: an optional ISO retry instant; ``fail_code`` is the engine's ``error_code``.
    fail_kind: str | None = None
    fail_retry_at: str | None = None
    fail_code: str | None = None
    cost_usd: float = 0.0
    tokens_in: int = 0
    tokens_out: int = 0
    #: Input tokens of the turn's last model call (None: the engine reports none; the service then
    #: falls back to ``tokens_in``).
    last_input_tokens: int | None = None
    #: Block until this event is set (or cancel) before finishing.
    gate: asyncio.Event | None = None
    #: Only consume this turn when the prompt/message contains this text.
    when: str | None = None
    session_ref: str | None = None
    #: Report the session as soon as the turn starts (what the real engines do).
    #: False: the session is only known when the turn ends.
    emit_session: bool = True
    #: Events played AFTER the gate opens (``events`` come before it). Internal
    #: kinds (``_session``, ``_process``) are allowed in both lists.
    events_after: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    #: A cancel that arrives while the gate is held does not cut the turn: it ends
    #: normally with its full result (an owner interrupt racing the natural end).
    ignore_cancel: bool = False
    #: After its events the turn says nothing more and never ends by itself: only a cancel
    #: (the harness ending it for a limit, an owner stop) cuts it.
    silent: bool = False
    #: Seraphine tool calls the turn makes through the gateway with the turn's own token, as the
    #: MCP bridge would (``(tool, arguments)``): before the gate / after it. Results land in
    #: ``FakeEngine.gateway_results``. Only when the turn was offered a bridge.
    gateway_calls: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    gateway_calls_after: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    #: The bridge says hello (before the calls); False leaves the hello timeout to run.
    hello: bool = False


class FakeEngine:
    can_act = True

    def __init__(self, name: str = "fake", turns: list[FakeTurn] | None = None,
                 ok: bool = True, reason: str = "ok", resumable: bool = True,
                 bridge: bool = False) -> None:
        self.name = name
        #: Offered the Seraphine bridge like Codex / Claude Code (needs ``gateway`` to be used).
        self.supports_bridge = bridge
        #: ``svc.gateway`` (set by the test): where scripted tool calls go, with the turn token.
        self.gateway: Any = None
        #: Every turn's bridge (None when none was offered), and the answers of scripted calls.
        self.bridges: list[Any] = []
        self.gateway_results: list[dict[str, Any]] = []
        #: Can a session survive a backend restart (see ``resumable_after_restart``).
        self.resumable_after_restart = resumable
        self.turns: list[FakeTurn] = list(turns or [])
        self._ok = ok
        self._reason = reason
        self.calls: list[dict[str, Any]] = []
        self.active = 0
        self.max_active = 0
        self.started: list[str] = []
        self._n = 0

    def available(self) -> tuple[bool, str]:
        return self._ok, self._reason

    def add(self, turn: FakeTurn) -> FakeTurn:
        self.turns.append(turn)
        return turn

    def _next(self, text: str) -> FakeTurn:
        for i, turn in enumerate(self.turns):
            if turn.when is None or turn.when in text:
                return self.turns.pop(i)
        return FakeTurn()

    async def run(
        self, ctx: EngineContext, on_event: OnEvent, cancel: asyncio.Event,
    ) -> EngineResult:
        self.calls.append({"op": "run", "ctx": ctx})
        return await self._play(self._next(ctx.prompt), ctx.prompt, None, on_event, cancel, ctx)

    async def resume(
        self, ctx: EngineContext, session_ref: str, message: str,
        on_event: OnEvent, cancel: asyncio.Event,
    ) -> EngineResult:
        self.calls.append({"op": "resume", "ctx": ctx, "session_ref": session_ref, "message": message})
        return await self._play(self._next(message), message, session_ref, on_event, cancel, ctx)

    async def _call_gateway(self, bridge: Any, calls: list[tuple[str, dict[str, Any]]]) -> None:
        for tool, args in calls:
            try:
                self.gateway_results.append(await self.gateway.call(bridge.token, tool, dict(args)))
            except Exception as exc:  # noqa: BLE001  (a refused token, for instance)
                self.gateway_results.append({"raised": type(exc).__name__})

    async def _play(
        self, turn: FakeTurn, text: str, session_ref: str | None,
        on_event: OnEvent, cancel: asyncio.Event, ctx: EngineContext | None = None,
    ) -> EngineResult:
        self.started.append(text)
        bridge = ctx.bridge if ctx is not None else None
        self.bridges.append(bridge)
        self._n += 1
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        try:
            sref = session_ref or turn.session_ref or f"fake-session-{self._n}"
            if turn.emit_session:
                await on_event("_session", {"session_ref": sref})
            for kind, payload in turn.events:
                await on_event(kind, dict(payload))
            if bridge is not None and self.gateway is not None:
                if turn.hello:
                    await self.gateway.hello(bridge.token)
                await self._call_gateway(bridge, turn.gateway_calls)
            if turn.silent and turn.gate is None:
                turn.gate = asyncio.Event()
            if turn.gate is not None:
                gate_wait = asyncio.create_task(turn.gate.wait())
                waits = {gate_wait} if turn.ignore_cancel else {gate_wait, asyncio.create_task(cancel.wait())}
                try:
                    await asyncio.wait(waits, return_when=asyncio.FIRST_COMPLETED)
                finally:
                    for w in waits:
                        w.cancel()
            if cancel.is_set() and not turn.ignore_cancel:
                return EngineResult(session_ref=sref, exit_code=None)
            for kind, payload in turn.events_after:
                await on_event(kind, dict(payload))
            if bridge is not None and self.gateway is not None:
                await self._call_gateway(bridge, turn.gateway_calls_after)
            if turn.fail or turn.fail_kind:
                return EngineResult(
                    session_ref=sref, exit_code=1, error=turn.fail or f"falha simulada ({turn.fail_kind})",
                    error_code=turn.fail_code, wait_kind=turn.fail_kind, retry_at=turn.fail_retry_at)
            final = turn.final_message
            if turn.approval:
                final += "\n\n```approval-request\n" + json.dumps(turn.approval) + "\n```"
            await on_event("message", {"text": final})
            return EngineResult(
                final_message=final, session_ref=sref, exit_code=0,
                tokens_in=turn.tokens_in, tokens_out=turn.tokens_out, cost_usd=turn.cost_usd,
                last_input_tokens=turn.last_input_tokens,
            )
        finally:
            self.active -= 1
