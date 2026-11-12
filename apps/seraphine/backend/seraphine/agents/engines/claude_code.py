"""Claude Code runtime (headless ``claude -p`` with stream-json output).

Executable resolution (``resolve_claude_exe``), in order: the
``agents_claude_path`` setting; ``shutil.which("claude")``; on Windows the
newest copy bundled with the Claude desktop app,
``%LOCALAPPDATA%\\Claude-Data\\*\\claude-code\\<version>\\<hash>\\claude.exe``
(newest = highest version tuple, then mtime).

Command line (every flag checked against ``claude --help`` of 2.1.321, and the
whole line was accepted by that CLI in a real, unauthenticated run)::

    <exe> -p --output-format stream-json --verbose --restricted
        --strict-mcp-config --permission-mode <plan|acceptEdits>
        --permission-prompts none
        --tools Read,Glob,Grep,Edit,Write,NotebookEdit,WebSearch
        [--model M] [--effort low|medium|high] [--resume <session>]

The prompt goes through stdin; cwd is the project folder.

- ``--restricted`` removes Bash/PowerShell and the other code-running tools and
  WebFetch, ignores user/project/local settings, and confines the file tools to
  the working directory. ``--strict-mcp-config`` skips MCP servers.
- ``--tools`` narrows the built-in set further (a real run listed exactly
  those tools): no Artifact publishing, no sub-agents, no messaging tools.
- ``--permission-prompts none``: anything that would prompt is denied
  automatically instead of waiting for a host that does not exist.
- ``plan`` when edits are blocked, ``acceptEdits`` when they are free. Never
  ``bypassPermissions`` / ``dontAsk`` / ``auto``.

Seraphine tools (phase 3b, VERIFIED by the bench in ``contratos/fase-3-bancada.md``): when the
context carries a ``bridge`` the line gains, LAST (``--allowedTools`` swallows what follows)::

    --mcp-config <inline JSON: {"mcpServers": {"seraphine": {"command": "<python>",
        "args": ["-I", "-S", "<script>"], "env": {"SERAPHINE_BRIDGE_URL": "${SERAPHINE_BRIDGE_URL}",
        ...the same for the token and the tools file...}}}}>
    --allowedTools mcp__seraphine

The JSON is inline (no file) and every value is a ``${VAR}`` reference that Claude Code fills from
its OWN environment, where the harness puts the three values: the token is on no command line and
on no disk. ``--strict-mcp-config`` (already there) makes it the only MCP server. ``plan`` blocks
MCP even when allowed, so the read-only tier uses ``--permission-mode manual`` with the read tools
only (``Read,Glob,Grep,WebSearch``, the line the bench ran): with ``--permission-prompts none`` and
``--restricted`` nothing that asks for approval runs, and the missing edit tools are the second
fence. Without tools to offer, the line is exactly what it was. Tool calls of the Seraphine server
are not recorded from the stream (the gateway records them); ``system/init`` with that server not
``connected`` and a ``permission_denied`` of one of its tools become the internal ``_bridge``
failure signal.

Stream shapes. VERIFIED from a real run (logged-out CLI): ``system/init``
(``session_id``, ``tools``, ``model``) and the authentication failure, which is
an ``assistant`` message with model ``<synthetic>``, zero usage,
``error: "authentication_failed"`` and the text "Failed to authenticate...",
followed by a ``result`` with ``is_error: true``, ``terminal_reason:
"api_error"`` and the same text (exit code 1).

Recovery (phase 1a): every line carries ``session_id`` and the first one is
``system/init``, so the session is reported at once (``_session``). An action is
an assistant ``tool_use`` block (``phase: started``, ``call_id`` = its ``id``) and
ends with the ``tool_result`` block of a later ``user`` message that has the
same ``tool_use_id`` (``phase: completed``). The remaining shapes (assistant
text / ``tool_use`` / ``thinking`` blocks, ``user`` ``tool_result`` errors, the
success ``result`` with ``total_cost_usd`` and ``usage``) follow the documented
format and have NOT been seen from a logged-in CLI.

Park instead of fail (phase 1b). A failed turn is classified from: the assistant
error field (``rate_limit`` -> plan limit, ``server_error`` -> outage; the values
of the Agent SDK's documented error enum, next to the recorded
``authentication_failed``), a ``rate_limit_event`` whose ``rate_limit_info.status``
is ``rejected`` (only ``allowed`` was recorded; ``resetsAt`` there, in epoch
seconds, is the reset instant) and the failure text (``result`` / stderr) through
``classify``. Nothing else is parked.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
from pathlib import Path
from typing import Any, Callable

from seraphine.agents.engines.base import (
    BRIDGE_SERVER, SESSION_NOT_FOUND, BridgeSpec, EngineContext, EngineResult, OnEvent,
    SANDBOX_READ_ONLY, clip, process_reporter,
)
from seraphine.agents.engines.classify import (
    AUTH, OUTAGE, PLAN_LIMIT, Failure, classify_text, epoch_to_iso, reset_hint,
)
from seraphine.agents.procutil import run_lines

_FORBIDDEN_MODES = {"bypassPermissions", "dontAsk", "auto"}
_VALID_EFFORT = ("low", "medium", "high")
ALLOWED_TOOLS = "Read,Glob,Grep,Edit,Write,NotebookEdit,WebSearch"
#: Read-only tier with the bridge: ``manual`` mode, so the edit tools are left out of ``--tools``.
READ_ONLY_BRIDGE_TOOLS = "Read,Glob,Grep,WebSearch"
BRIDGE_TOOL_PREFIX = f"mcp__{BRIDGE_SERVER}__"

AUTH_MESSAGE = "O Claude Code não está conectado. Rode `claude auth login` no terminal e tente de novo."
_AUTH_TEXT_RE = re.compile(
    r"failed to authenticate|claude auth login|not logged in|invalid api key|"
    r"authentication_failed|please run /login", re.IGNORECASE)
_SYNTHETIC_MODEL = "<synthetic>"
#: What ``claude -p --resume <id>`` prints for a session it cannot find ("No conversation found with
#: session ID: ..."). NOT recorded from a real run here; the service also restarts a resumed turn that
#: failed before the engine did anything, so a different wording still ends in the same place.
_SESSION_MISSING_RE = re.compile(
    r"no conversation found|session (?:id )?not found|no (?:such )?session", re.IGNORECASE)


# -- executable resolution ------------------------------------------------------


def _is_windows() -> bool:
    return os.name == "nt"


def _version_key(text: str) -> tuple[int, ...]:
    nums = re.findall(r"\d+", text)
    return tuple(int(n) for n in nums) if nums else (0,)


def bundled_claude_candidates() -> list[Path]:
    """Claude desktop app copies, newest first (Windows only)."""
    if not _is_windows():
        return []
    base = os.environ.get("LOCALAPPDATA")
    if not base:
        return []
    root = Path(base) / "Claude-Data"
    found: list[tuple[tuple[int, ...], float, Path]] = []
    try:
        for exe in root.glob("*/claude-code/*/*/claude.exe"):
            try:
                mtime = exe.stat().st_mtime
            except OSError:
                continue
            found.append((_version_key(exe.parent.parent.name), mtime, exe))
    except OSError:
        return []
    found.sort(key=lambda t: (t[0], t[1]), reverse=True)
    return [t[2] for t in found]


def resolve_claude_exe(configured: str | None = None) -> Path | None:
    """Path of the Claude Code CLI, or None."""
    configured = (configured or "").strip()
    if configured:
        p = Path(configured)
        if p.is_file():
            return p
        found = shutil.which(configured)
        if found:
            return Path(found)
    found = shutil.which("claude")
    if found:
        return Path(found)
    cands = bundled_claude_candidates()
    return cands[0] if cands else None


def permission_mode_for(sandbox: str, bridge: bool = False) -> str:
    """``plan`` blocks MCP tools, so a read-only agent that is offered Seraphine tools gets ``manual``."""
    if sandbox == SANDBOX_READ_ONLY:
        return "manual" if bridge else "plan"
    return "acceptEdits"


def mcp_config(bridge: BridgeSpec) -> str:
    """Inline ``--mcp-config`` JSON; the values are ``${VAR}`` references, never the values."""
    server = {"command": bridge.python, "args": bridge.command_args,
              "env": {name: "${" + name + "}" for name in bridge.env()}}
    return json.dumps({"mcpServers": {bridge.server: server}}, separators=(",", ":"))


# -- parser ---------------------------------------------------------------------


#: Tools that only read or search: cutting one leaves nothing half done (phase 1d).
_READ_ONLY_TOOLS = frozenset({"Read", "Glob", "Grep", "WebSearch"})


def _flags(tool: str) -> dict[str, Any]:
    return {"read_only": True} if tool in _READ_ONLY_TOOLS else {}


def _short_target(tinput: Any) -> str:
    if not isinstance(tinput, dict):
        return ""
    for key in ("file_path", "path", "notebook_path", "pattern", "query", "url", "command"):
        value = tinput.get(key)
        if value:
            return clip(str(value), 200)
    return ""


class ClaudeStreamParser:
    """Stateful parser of ``claude -p --output-format stream-json`` lines."""

    def __init__(self) -> None:
        self.session_ref: str | None = None
        self.final_message: str = ""
        self.tokens_in = 0
        self.tokens_out = 0
        #: Size of the context at the last model call (input + cached input), from the last
        #: ``assistant`` message's usage; the ``result`` usage is a sum over the whole turn.
        self.last_input_tokens: int | None = None
        self.cost_usd = 0.0
        self.error: str | None = None
        self.auth_failed = False
        self.denials: list[str] = []
        #: What the stream said about the failure: ``plan_limit`` | ``outage`` | None.
        self.failure_hint: str | None = None
        self.limit_reset: str | None = None
        self._tools: dict[str, tuple[str, str]] = {}
        #: ``tool_use`` ids of the Seraphine server's tools: the gateway records those calls.
        self._bridge_ids: set[str] = set()
        self._anon = 0

    def failure(self, extra_text: str = "") -> Failure | None:
        """Plan limit / outage behind a failed turn, from the stream and the failure text."""
        if self.failure_hint == PLAN_LIMIT:
            return Failure(PLAN_LIMIT, self.limit_reset or reset_hint(f"{self.error or ''} {extra_text}"))
        if self.failure_hint == OUTAGE:
            return Failure(OUTAGE)
        return classify_text(f"{self.error or ''} {extra_text}")

    def _fail_auth(self, out: list[tuple[str, dict[str, Any]]]) -> None:
        if not self.auth_failed:
            self.auth_failed = True
            self.error = AUTH_MESSAGE
            out.append(("error", {"message": AUTH_MESSAGE}))

    def feed(self, line: str) -> list[tuple[str, dict[str, Any]]]:
        try:
            event = json.loads(line)
        except (ValueError, TypeError):
            return []
        if not isinstance(event, dict):
            return []
        etype = event.get("type")
        out: list[tuple[str, dict[str, Any]]] = []
        sid = event.get("session_id")
        if isinstance(sid, str) and sid:
            if sid != self.session_ref:
                out.append(("_session", {"session_ref": sid}))
            self.session_ref = sid

        if etype == "assistant":
            message = event.get("message") or {}
            text_all = " ".join(
                str(b.get("text") or "") for b in (message.get("content") or [])
                if isinstance(b, dict) and b.get("type") == "text")
            usage = message.get("usage") or {}
            synthetic = (message.get("model") == _SYNTHETIC_MODEL
                         and not int(usage.get("input_tokens") or 0)
                         and not int(usage.get("output_tokens") or 0))
            if not synthetic:
                context = sum(int(usage.get(k) or 0) for k in (
                    "input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"))
                self.last_input_tokens = context or self.last_input_tokens
            if event.get("error") == "authentication_failed" or (
                    synthetic and _AUTH_TEXT_RE.search(text_all)):
                self._fail_auth(out)
                return out
            api_error = event.get("error")
            if api_error in ("rate_limit", "server_error"):
                # Synthetic error message: shown as an error, never as the agent's words.
                self.failure_hint = PLAN_LIMIT if api_error == "rate_limit" else OUTAGE
                out.append(("error", {"message": "O provedor do Claude Code devolveu um erro temporário."}))
                return out
            for block in message.get("content") or []:
                if not isinstance(block, dict):
                    continue
                btype = block.get("type")
                if btype == "text":
                    text = str(block.get("text") or "")
                    if text.strip():
                        out.append(("message", {"text": clip(text, 4000)}))
                elif btype == "thinking":
                    text = str(block.get("thinking") or "").strip()
                    if text:
                        out.append(("step", {"type": "reasoning", "text": clip(text, 1000)}))
                elif btype == "tool_use":
                    name = str(block.get("name") or "")
                    if name.startswith(BRIDGE_TOOL_PREFIX):
                        if block.get("id"):
                            self._bridge_ids.add(str(block["id"]))
                        continue
                    target = _short_target(block.get("input"))
                    if block.get("id"):
                        cid, phase = str(block["id"]), "started"
                        self._tools[cid] = (name, target)
                    else:  # no id to pair a result with: single completed event
                        self._anon += 1
                        cid, phase = f"anon-{self._anon}", "completed"
                    out.append(("step", {
                        "type": "tool_use", "phase": phase, "call_id": cid,
                        "tool": name, "target": target, **_flags(name)}))
        elif etype == "user":
            message = event.get("message") or {}
            content = message.get("content")
            for block in content if isinstance(content, list) else []:
                if not (isinstance(block, dict) and block.get("type") == "tool_result"):
                    continue
                use_id = str(block.get("tool_use_id") or "")
                if use_id in self._bridge_ids:
                    continue
                known = self._tools.pop(use_id, None)
                detail = block.get("content")
                if isinstance(detail, list):
                    detail = " ".join(str(b.get("text", "")) for b in detail if isinstance(b, dict))
                if known is not None:
                    failure = ({"failed": True, "error": clip(str(detail or "").strip(), 300)}
                               if block.get("is_error") else {})
                    out.append(("step", {
                        "type": "tool_use", "phase": "completed", "call_id": use_id,
                        "tool": known[0], "target": known[1], **_flags(known[0]), **failure}))
                if block.get("is_error"):
                    name = known[0] if known else "ferramenta"
                    out.append(("step", {
                        "type": "note", "text": f"{name} falhou: {clip(str(detail or '').strip(), 300)}"}))
        elif etype == "system":
            subtype = event.get("subtype")
            if subtype == "init":
                for server in event.get("mcp_servers") or []:
                    if (isinstance(server, dict) and server.get("name") == BRIDGE_SERVER
                            and server.get("status") not in ("connected", "pending")):
                        out.append(("_bridge", {"state": "failed", "reason": f"status {server.get('status')}"}))
            elif subtype == "permission_denied" and str(event.get("tool_name") or "").startswith(BRIDGE_TOOL_PREFIX):
                out.append(("_bridge", {"state": "failed", "reason": "permission_denied"}))
        elif etype == "rate_limit_event":
            info = event.get("rate_limit_info")
            if isinstance(info, dict) and info.get("status") == "rejected":
                self.failure_hint = PLAN_LIMIT
                resets = info.get("resetsAt")
                if isinstance(resets, (int, float)) and not isinstance(resets, bool):
                    self.limit_reset = epoch_to_iso(float(resets))
        elif etype == "result":
            result = event.get("result")
            usage = event.get("usage") or {}
            self.cost_usd = float(event.get("total_cost_usd") or 0.0)
            self.tokens_in = int(usage.get("input_tokens") or 0)
            self.tokens_out = int(usage.get("output_tokens") or 0)
            for denial in event.get("permission_denials") or []:
                if isinstance(denial, dict):
                    self.denials.append(str(denial.get("tool_name") or ""))
            is_error = bool(event.get("is_error")) or str(event.get("subtype") or "").startswith("error")
            if is_error and (self.auth_failed or _AUTH_TEXT_RE.search(str(result or ""))):
                self._fail_auth(out)
            elif is_error:
                self.error = str(result or event.get("subtype") or "erro do Claude Code")
                out.append(("error", {"message": self.error}))
            elif isinstance(result, str):
                self.final_message = result
        return out


# -- engine ---------------------------------------------------------------------


class ClaudeCodeEngine:
    name = "claude_code"
    can_act = True
    #: The Seraphine MCP bridge can be declared (see the module docstring).
    supports_bridge = True
    #: ``claude -p --resume <session>`` works after a backend restart.
    resumable_after_restart = True

    def __init__(
        self, executable: str = "", env_factory: Callable[[], dict[str, str]] | None = None,
    ) -> None:
        #: Value of ``agents_claude_path`` ("" = auto-detect).
        self.executable = executable
        self.env_factory = env_factory

    def _resolve(self) -> Path | None:
        return resolve_claude_exe(self.executable)

    def available(self) -> tuple[bool, str]:
        if self._resolve() is None:
            return False, ("Claude Code (claude) não encontrado neste computador; instale o app do "
                           "Claude ou informe agents_claude_path")
        return True, "ok"

    def build_args(
        self, exe: str, ctx: EngineContext, session_ref: str | None = None,
    ) -> list[str]:
        bridge = ctx.bridge
        mode = permission_mode_for(ctx.sandbox, bridge is not None)
        assert mode not in _FORBIDDEN_MODES
        read_only_bridge = bridge is not None and ctx.sandbox == SANDBOX_READ_ONLY
        args = [
            str(exe), "-p", "--output-format", "stream-json", "--verbose",
            "--restricted", "--strict-mcp-config",
            "--permission-mode", mode, "--permission-prompts", "none",
            "--tools", READ_ONLY_BRIDGE_TOOLS if read_only_bridge else ALLOWED_TOOLS,
        ]
        if ctx.model:
            args += ["--model", ctx.model]
        if ctx.reasoning_effort in _VALID_EFFORT:
            args += ["--effort", ctx.reasoning_effort]
        if session_ref:
            args += ["--resume", session_ref]
        if bridge is not None:  # last: --allowedTools takes every argument that follows it
            args += ["--mcp-config", mcp_config(bridge), "--allowedTools", f"mcp__{bridge.server}"]
        return args

    async def run(
        self, ctx: EngineContext, on_event: OnEvent, cancel: asyncio.Event,
    ) -> EngineResult:
        exe = self._resolve()
        if exe is None:
            return EngineResult(error="Claude Code (claude) não encontrado")
        return await self._drive(self.build_args(str(exe), ctx), ctx, ctx.prompt, on_event, cancel)

    async def resume(
        self, ctx: EngineContext, session_ref: str, message: str,
        on_event: OnEvent, cancel: asyncio.Event,
    ) -> EngineResult:
        exe = self._resolve()
        if exe is None:
            return EngineResult(error="Claude Code (claude) não encontrado")
        result = await self._drive(
            self.build_args(str(exe), ctx, session_ref), ctx, message, on_event, cancel,
        )
        if result.error and not result.error_code and not result.wait_kind                 and _SESSION_MISSING_RE.search(result.error):
            result.error_code = SESSION_NOT_FOUND
        return result

    async def _drive(
        self, args: list[str], ctx: EngineContext, stdin_text: str,
        on_event: OnEvent, cancel: asyncio.Event,
    ) -> EngineResult:
        parser = ClaudeStreamParser()

        async def _on_line(line: str) -> None:
            for kind, payload in parser.feed(line):
                await on_event(kind, payload)

        env = self.env_factory() if self.env_factory else None
        if ctx.bridge is not None:  # the ${VAR} references of --mcp-config are filled from here
            env = {**(env if env is not None else os.environ), **ctx.bridge.env()}
        try:
            code, stderr_tail, _ = await run_lines(
                args, cwd=str(ctx.project_path), stdin_text=stdin_text,
                on_line=_on_line, cancel=cancel,
                env=env,
                on_spawn=process_reporter(on_event),
            )
        except OSError as exc:
            return EngineResult(error=f"não foi possível iniciar o claude: {exc}")
        result = EngineResult(
            final_message=parser.final_message, session_ref=parser.session_ref,
            exit_code=code, tokens_in=parser.tokens_in, tokens_out=parser.tokens_out,
            cost_usd=parser.cost_usd, last_input_tokens=parser.last_input_tokens,
        )
        if cancel.is_set():
            return result
        if parser.auth_failed:
            result.error, result.error_code, result.wait_kind = AUTH_MESSAGE, "engine_auth", AUTH
            return result
        extra = ""
        if parser.error:
            result.error = parser.error
        elif code:
            result.error = f"claude saiu com código {code}: {stderr_tail.strip()[-500:]}"
            extra = stderr_tail
        elif not parser.final_message:
            result.error = "o Claude Code terminou sem enviar uma resposta"
        if result.error and (found := parser.failure(extra)):
            result.wait_kind, result.retry_at = found.kind, found.retry_at
        return result
