"""Codex runtime: drives ``codex exec --json`` inside the project folder.

Command line (flags verified against ``codex exec --help`` /
``codex exec resume --help`` of codex-cli 0.153.0 and by real runs)::

    codex exec --json --ignore-user-config --ignore-rules --skip-git-repo-check
        --color never --sandbox <read-only|workspace-write> --cd <project>
        -c approval_policy="never" [-c windows.sandbox="unelevated"]
        [-c model_reasoning_effort="<low|medium|high>"]
        [--oss --local-provider <ollama|lmstudio>] [--model M] -

    codex exec resume --json --ignore-user-config --ignore-rules
        --skip-git-repo-check -c sandbox_mode="<tier>"
        -c approval_policy="never" [-c windows.sandbox="unelevated"]
        [-c model_reasoning_effort="..."] [-c model_provider="<ollama|lmstudio>"]
        [--model M] <SESSION_ID> -

The prompt goes through stdin (``-``), never argv. ``resume`` has no
``--sandbox`` / ``--cd`` / ``--oss`` options in this version, so the working
directory is the process cwd, the sandbox is a ``-c`` override and a local
provider is selected with ``-c model_provider`` (``ollama`` / ``lmstudio`` are
the built-in provider ids reserved by Codex). If a CLI version ignored the
sandbox override, Codex's default for a user-config-free exec is ``read-only``
-- the safe direction. ``--dangerously-bypass-approvals-and-sandbox`` is never
used.

Windows (VERIFIED on this machine): on native Windows Codex only enforces a
writable sandbox when its Windows sandbox level is configured. The owner's
``~/.codex/config.toml`` has ``[windows] sandbox = "unelevated"`` but
``--ignore-user-config`` drops it, and Codex then silently falls back to
read-only ("patch rejected: writing is blocked by read-only sandbox").
Passing ``-c windows.sandbox="unelevated"`` (setting
``agents_codex_windows_sandbox``) makes ``workspace-write`` work: writes inside
the project folder succeed and writes to its parent are denied.
``--ignore-user-config`` is kept so the owner's MCP servers, hooks and
``notify`` do not leak into agents.

Sandbox limits to keep in mind (VERIFIED): Codex's ``workspace-write`` sandbox
also allows writes to the system temp folder, and reads are NOT confined to the
project folder.

Local providers (``--oss --local-provider``) come from ``codex exec --help``
and the Codex config documentation; they were not exercised end to end (no
local server was running). API-key providers are NOT routed through Codex:
Codex custom providers (``model_providers.<id>.env_key`` / ``base_url``) are
documented only with ``wire_api = "responses"``, so they stay on the ``chat``
runtime.

JSONL event shapes (VERIFIED against real runs of codex-cli 0.153.0):

- ``{"type":"thread.started","thread_id":"<uuid>"}``
- ``item.started`` / ``item.completed`` with an item of type ``agent_message``
  (text) or ``command_execution`` (id, command, aggregated_output, exit_code,
  status)
- ``{"type":"turn.completed","usage":{"input_tokens","cached_input_tokens",
  "output_tokens","reasoning_output_tokens"}}``
- Other item types handled here (``reasoning``, ``file_change``, ``web_search``,
  ``mcp_tool_call``, ``error``) and ``turn.failed`` / ``error`` come from the
  documented stream / the repo's ``llm_adapters.codex``, not from a recording.

Seraphine tools (phase 3b, VERIFIED by the bench in ``contratos/fase-3-bancada.md``): when the
context carries a ``bridge`` the MCP server is declared with four ``-c`` overrides, on a fresh
run and on ``exec resume`` alike (the server is started again on every resume)::

    -c mcp_servers.seraphine.command="<python>"
    -c mcp_servers.seraphine.args=["-I","-S","<bridge script>"]
    -c mcp_servers.seraphine.env={SERAPHINE_BRIDGE_URL="...",SERAPHINE_BRIDGE_TOKEN="...",SERAPHINE_BRIDGE_TOOLS="..."}
    -c mcp_servers.seraphine.default_tools_approval_mode="approve"

``approve`` is set for that one server only: with ``approval_policy="never"`` Codex refuses
every MCP call, and the gateway checks each call instead. The token goes through the server's
``env`` table, NOT through ``env_vars`` / the engine's own environment (those reach the agent's
shell). Its cost: the value is in the bridge process's command line (the contract accepts it:
the token gives the holder nothing the agent cannot already do through the tools). The sandbox
and the other options do not change. Codex skips an MCP server that takes more than about a
second to answer ``initialize`` WITHOUT telling anyone, so the bridge is a tiny stdlib script and
the harness watches for its "hello". ``mcp_tool_call`` items of the Seraphine server are not
recorded here (the gateway records them); a refused one (``error`` set, e.g. "MCP tool call
requires approval, but approval policy is never") becomes the internal ``_bridge`` failure signal.

Recovery (phase 1a): ``thread.started`` is the first event of the stream, so
the session is reported at once (``_session``). Actions are bracketed by item id:
``item.started`` -> a ``step`` with ``phase: started``; ``item.completed`` -> the
usual event (``command`` for commands, ``step`` for the rest) with
``phase: completed`` and the same ``call_id``. ``item.started`` is verified for
``command_execution``; for ``file_change`` / ``web_search`` / ``mcp_tool_call``
it is handled when present, and a lone ``item.completed`` simply becomes a
single ``completed`` event.

Authentication failures are detected heuristically (``AUTH_RE`` on the
``turn.failed`` / ``error`` message or on stderr); the exact Codex wording was
not recorded.

Park instead of fail (phase 1b): on a failed turn the failure text (``turn.failed``
message, or stderr on a non-zero exit) is classified by ``classify`` (plan limit,
then outage) and a stream that showed ``Reconnecting`` errors before failing counts
as an outage. Nothing else is parked.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
from typing import Any, Callable

from seraphine.agents.engines.base import (
    BRIDGE_SERVER, SESSION_NOT_FOUND, BridgeSpec, EngineContext, EngineResult, OnEvent,
    SANDBOX_READ_ONLY, SANDBOX_WORKSPACE_WRITE, clip, process_reporter,
)
from seraphine.agents.engines.classify import AUTH, OUTAGE, Failure, classify_text
from seraphine.agents.procutil import run_lines

_VALID_SANDBOX = {SANDBOX_READ_ONLY, SANDBOX_WORKSPACE_WRITE}
_VALID_WINDOWS_SANDBOX = ("unelevated", "elevated")
_VALID_EFFORT = ("low", "medium", "high")

AUTH_MESSAGE = "O Codex não está conectado. Rode `codex login` no terminal e tente de novo."
AUTH_RE = re.compile(
    r"not logged in|log ?in again|please (?:log|sign) ?in|\b401\b|unauthori[sz]ed|"
    r"authentication (?:failed|required|error)|invalid (?:api key|token|credentials)|"
    r"refresh token|token (?:expired|has expired)",
    re.IGNORECASE,
)


#: What ``codex exec resume`` says about a thread it cannot find. NOT recorded from a real run (the
#: wording comes from memory of the CLI); the service also restarts a resumed turn that failed
#: before the engine did anything, so a different wording still ends in the same place.
SESSION_MISSING_RE = re.compile(
    r"no rollout found|no saved session|session (?:was )?not found|thread (?:was )?not found|"
    r"no conversation found|could not find (?:a )?(?:session|thread)", re.IGNORECASE)


def _is_windows() -> bool:
    return os.name == "nt"


def looks_like_auth_error(text: str) -> bool:
    return bool(AUTH_RE.search(text or ""))


def _is_bridge_call(item: Any) -> bool:
    return isinstance(item, dict) and item.get("type") == "mcp_tool_call" and item.get("server") == BRIDGE_SERVER


def _toml_str(value: str) -> str:
    """A TOML basic string (JSON strings are valid ones, and escape the Windows backslash)."""
    return json.dumps(value)


def bridge_overrides(bridge: BridgeSpec) -> list[str]:
    """The ``-c`` options that declare the Seraphine MCP server (fresh run and resume)."""
    prefix = f"mcp_servers.{bridge.server}"
    env = ",".join(f"{k}={_toml_str(v)}" for k, v in bridge.env().items())
    return [
        "-c", f"{prefix}.command={_toml_str(bridge.python)}",
        "-c", f"{prefix}.args=[{','.join(_toml_str(a) for a in bridge.command_args)}]",
        "-c", f"{prefix}.env={{{env}}}",
        "-c", f'{prefix}.default_tools_approval_mode="approve"',
    ]


class CodexEventParser:
    """Stateful line-by-line parser of the ``codex exec --json`` stream."""

    def __init__(self) -> None:
        self.session_ref: str | None = None
        self.final_message: str = ""
        self.tokens_in = 0
        self.tokens_out = 0
        #: Input tokens the last ``turn.completed`` reported (the context size, as far as Codex says).
        self.last_input_tokens: int | None = None
        self.error: str | None = None
        self.turn_completed = False
        #: A transient "Reconnecting..." error was seen (the connection to the provider failed).
        self.reconnecting = False
        self._anon = 0

    @staticmethod
    def _action_fields(item: dict[str, Any]) -> tuple[str, dict[str, Any]] | None:
        """``(step type, fields)`` of an action item, or None for other items."""
        itype = item.get("type")
        if itype == "command_execution":
            return "command", {"command": clip(str(item.get("command") or ""), 2000), "by": "agent"}
        if itype == "file_change":
            changes = item.get("changes") or []
            return "file_change", {"changes": [
                {"path": str(c.get("path", "")), "kind": str(c.get("kind", ""))}
                for c in changes if isinstance(c, dict)][:50]}
        if itype == "web_search":
            return "web_search", {"query": str(item.get("query") or ""), "read_only": True}
        if itype == "mcp_tool_call":
            return "tool_call", {"tool": f"{item.get('server', '')}.{item.get('tool', '')}"}
        return None

    def _call_id(self, item: dict[str, Any], started: bool) -> str | None:
        cid = item.get("id")
        if cid:
            return str(cid)
        if started:
            return None  # cannot be paired with its end: wait for the completion
        self._anon += 1
        return f"anon-{self._anon}"

    def feed(self, line: str) -> list[tuple[str, dict[str, Any]]]:
        """Consume one JSONL line; return harness ``(kind, payload)`` events."""
        try:
            event = json.loads(line)
        except (ValueError, TypeError):
            return []
        if not isinstance(event, dict):
            return []
        etype = event.get("type")
        out: list[tuple[str, dict[str, Any]]] = []

        if etype == "thread.started":
            tid = event.get("thread_id")
            if isinstance(tid, str) and tid:
                self.session_ref = tid
                out.append(("_session", {"session_ref": tid}))
        elif etype == "item.started":
            item = event.get("item") or {}
            if _is_bridge_call(item):
                return out  # the gateway records the Seraphine server's calls
            action = self._action_fields(item) if isinstance(item, dict) else None
            cid = self._call_id(item, True) if action else None
            if action and cid:
                out.append(("step", {"type": action[0], "phase": "started", "call_id": cid, **action[1]}))
        elif etype == "turn.completed":
            self.turn_completed = True
            usage = event.get("usage") or {}
            self.tokens_in += int(usage.get("input_tokens") or 0)
            self.tokens_out += int(usage.get("output_tokens") or 0)
            self.last_input_tokens = int(usage.get("input_tokens") or 0) or self.last_input_tokens
        elif etype == "turn.failed":
            err = event.get("error") or {}
            self.error = str(err.get("message") if isinstance(err, dict) else err) or "turn.failed"
            out.append(("error", {"message": self.error}))
        elif etype == "error":
            msg = str(event.get("message") or "erro do Codex")
            # Codex emits transient "Reconnecting..." errors; only turn.failed
            # (or a non-zero exit with no message) is terminal.
            if "reconnecting" in msg.lower():
                self.reconnecting = True
            out.append(("error", {"message": msg}))
        elif etype == "item.completed":
            item = event.get("item") or {}
            itype = item.get("type")
            if itype == "agent_message":
                text = str(item.get("text") or "")
                self.final_message = text
                out.append(("message", {"text": clip(text, 4000)}))
            elif itype == "reasoning":
                text = str(item.get("text") or "").strip()
                if text:
                    out.append(("step", {"type": "reasoning", "text": clip(text, 1000)}))
            elif _is_bridge_call(item):
                error = item.get("error")
                if error:  # the engine refused the call before it reached the gateway
                    msg = str(error.get("message") if isinstance(error, dict) else error)
                    out.append(("_bridge", {"state": "failed", "reason": clip(msg, 300)}))
            elif (action := self._action_fields(item)) is not None:
                done = {"phase": "completed", "call_id": self._call_id(item, False)}
                if itype == "command_execution":
                    out.append(("command", {
                        **action[1], "exit_code": item.get("exit_code"),
                        "output": clip(str(item.get("aggregated_output") or ""), 2000), **done}))
                else:
                    if item.get("status") == "failed":
                        done["failed"] = True
                    out.append(("step", {"type": action[0], **action[1], **done}))
            elif itype == "error":
                out.append(("error", {"message": str(item.get("message") or "")}))
        return out


class CodexEngine:
    name = "codex"
    can_act = True
    #: The Seraphine MCP bridge can be declared (see the module docstring).
    supports_bridge = True
    #: ``codex exec resume <thread>`` works after a backend restart.
    resumable_after_restart = True

    def __init__(
        self, executable: str = "codex", windows_sandbox: str = "unelevated",
        env_factory: Callable[[], dict[str, str]] | None = None,
    ) -> None:
        if windows_sandbox not in _VALID_WINDOWS_SANDBOX:
            raise ValueError(f"windows_sandbox inválido: {windows_sandbox!r}")
        self.executable = executable
        self.windows_sandbox = windows_sandbox
        #: Environment of the child (API keys of other providers removed).
        self.env_factory = env_factory

    def _resolve(self) -> str | None:
        return shutil.which(self.executable)

    def available(self) -> tuple[bool, str]:
        if self._resolve() is None:
            return False, "Codex CLI não encontrado neste computador"
        return True, "ok"

    # -- command lines ------------------------------------------------------

    def _common_overrides(self, ctx: EngineContext) -> list[str]:
        args = ["-c", 'approval_policy="never"']
        if _is_windows():
            args += ["-c", f'windows.sandbox="{self.windows_sandbox}"']
        if ctx.reasoning_effort in _VALID_EFFORT:
            args += ["-c", f'model_reasoning_effort="{ctx.reasoning_effort}"']
        return args

    @staticmethod
    def _local_id(ctx: EngineContext) -> str | None:
        """``ollama`` / ``lmstudio`` when the provider is a local one for Codex."""
        provider = ctx.provider
        return getattr(provider, "codex_local_id", None) if provider is not None else None

    def build_run_args(self, exe: str, ctx: EngineContext) -> list[str]:
        sandbox = _checked_sandbox(ctx.sandbox)
        args = [
            exe, "exec", "--json", "--ignore-user-config", "--ignore-rules",
            "--skip-git-repo-check", "--color", "never",
            "--sandbox", sandbox, "--cd", str(ctx.project_path),
            *self._common_overrides(ctx),
        ]
        if ctx.bridge is not None:
            args += bridge_overrides(ctx.bridge)
        local = self._local_id(ctx)
        if local:
            args += ["--oss", "--local-provider", local]
        if ctx.model:
            args += ["--model", ctx.model]
        args.append("-")
        return args

    def build_resume_args(self, exe: str, ctx: EngineContext, session_ref: str) -> list[str]:
        sandbox = _checked_sandbox(ctx.sandbox)
        args = [
            exe, "exec", "resume", "--json", "--ignore-user-config", "--ignore-rules",
            "--skip-git-repo-check",
            "-c", f'sandbox_mode="{sandbox}"',
            *self._common_overrides(ctx),
        ]
        if ctx.bridge is not None:
            args += bridge_overrides(ctx.bridge)
        local = self._local_id(ctx)
        if local:
            args += ["-c", f'model_provider="{local}"']
        if ctx.model:
            args += ["--model", ctx.model]
        args += [session_ref, "-"]
        return args

    def _check_model(self, ctx: EngineContext) -> str | None:
        if self._local_id(ctx) and not ctx.model:
            return "informe o modelo do servidor local (o Codex precisa saber qual modelo carregar)"
        return None

    # -- execution ----------------------------------------------------------

    async def run(
        self, ctx: EngineContext, on_event: OnEvent, cancel: asyncio.Event,
    ) -> EngineResult:
        exe = self._resolve()
        if exe is None:
            return EngineResult(error="Codex CLI não encontrado")
        if (problem := self._check_model(ctx)):
            return EngineResult(error=problem)
        return await self._drive(self.build_run_args(exe, ctx), ctx, ctx.prompt, on_event, cancel)

    async def resume(
        self, ctx: EngineContext, session_ref: str, message: str,
        on_event: OnEvent, cancel: asyncio.Event,
    ) -> EngineResult:
        exe = self._resolve()
        if exe is None:
            return EngineResult(error="Codex CLI não encontrado")
        if not session_ref:
            return EngineResult(error="sessão do Codex ausente; não é possível retomar")
        if (problem := self._check_model(ctx)):
            return EngineResult(error=problem)
        args = self.build_resume_args(exe, ctx, session_ref)
        result = await self._drive(args, ctx, message, on_event, cancel)
        if result.session_ref is None:
            result.session_ref = session_ref
        if result.error and not result.error_code and not result.wait_kind                 and SESSION_MISSING_RE.search(result.error):
            result.error_code = SESSION_NOT_FOUND
        return result

    async def _drive(
        self, args: list[str], ctx: EngineContext, stdin_text: str,
        on_event: OnEvent, cancel: asyncio.Event,
    ) -> EngineResult:
        parser = CodexEventParser()

        async def _on_line(line: str) -> None:
            for kind, payload in parser.feed(line):
                await on_event(kind, payload)

        try:
            code, stderr_tail, _cancelled = await run_lines(
                args, cwd=str(ctx.project_path), stdin_text=stdin_text,
                on_line=_on_line, cancel=cancel,
                env=self.env_factory() if self.env_factory else None,
                on_spawn=process_reporter(on_event),
            )
        except OSError as exc:
            return EngineResult(error=f"não foi possível iniciar o Codex: {exc}")

        result = EngineResult(
            final_message=parser.final_message, session_ref=parser.session_ref,
            exit_code=code, tokens_in=parser.tokens_in, tokens_out=parser.tokens_out,
            last_input_tokens=parser.last_input_tokens,
        )
        if cancel.is_set():
            return result
        failure_text = None
        if parser.error:
            result.error = failure_text = parser.error
        elif code:
            result.error = f"codex saiu com código {code}: {stderr_tail.strip()[-500:]}"
            failure_text = stderr_tail
        elif not parser.final_message:
            result.error = "o Codex terminou sem enviar uma resposta"
        if failure_text is not None:
            if looks_like_auth_error(failure_text):
                result.error, result.error_code, result.wait_kind = AUTH_MESSAGE, "engine_auth", AUTH
            elif found := classify_text(failure_text) or (
                    Failure(OUTAGE) if parser.reconnecting else None):
                result.wait_kind, result.retry_at = found.kind, found.retry_at
        return result


def _checked_sandbox(value: str) -> str:
    if value not in _VALID_SANDBOX:
        raise ValueError(f"sandbox inválido: {value!r}")
    return value
