"""Codex Windows sandbox / local providers, Claude Code executable + command line + auth."""

from __future__ import annotations

import asyncio
import json
import os
import stat
import sys
from pathlib import Path

import pytest

from seraphine.agents.engines import claude_code as claude_mod
from seraphine.agents.engines import codex as codex_mod
from seraphine.agents.engines import get_engines
from seraphine.agents.engines.base import EngineContext, SANDBOX_READ_ONLY, SANDBOX_WORKSPACE_WRITE
from seraphine.agents.engines.claude_code import (
    AUTH_MESSAGE as CLAUDE_AUTH, ClaudeCodeEngine, ClaudeStreamParser, resolve_claude_exe,
)
from seraphine.agents.engines.codex import AUTH_MESSAGE as CODEX_AUTH, CodexEngine
from seraphine.agents.providers import ProviderRegistry

from .conftest import make_settings


async def _noop(kind, payload):
    pass


def _script_exe(tmp_path: Path, name: str, body: str) -> str:
    script = tmp_path / f"{name}.py"
    script.write_text(body, encoding="utf-8")
    if os.name == "nt":
        exe = tmp_path / f"{name}.cmd"
        exe.write_text(f'@echo off\r\n"{sys.executable}" "{script}" %*\r\n', encoding="utf-8")
    else:
        exe = tmp_path / name
        exe.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{script}" "$@"\n', encoding="utf-8")
        exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
    return str(exe)


# -- codex ----------------------------------------------------------------------


def test_codex_windows_sandbox_flag_on_run_and_resume(tmp_path: Path, monkeypatch):
    ctx = EngineContext(project_path=tmp_path, prompt="p", sandbox=SANDBOX_WORKSPACE_WRITE)
    monkeypatch.setattr(codex_mod, "_is_windows", lambda: True)
    eng = CodexEngine()
    for args in (eng.build_run_args("codex", ctx), eng.build_resume_args("codex", ctx, "s1")):
        assert args[args.index('windows.sandbox="unelevated"') - 1] == "-c"
        assert "--ignore-user-config" in args  # the owner's MCP/hooks/notify stay out of agents
    assert 'windows.sandbox="elevated"' in CodexEngine(windows_sandbox="elevated").build_run_args("codex", ctx)
    with pytest.raises(ValueError):
        CodexEngine(windows_sandbox="none")
    monkeypatch.setattr(codex_mod, "_is_windows", lambda: False)
    assert not any("windows.sandbox" in a for a in eng.build_run_args("codex", ctx))
    assert not any("windows.sandbox" in a for a in eng.build_resume_args("codex", ctx, "s1"))


def test_settings_validate_windows_sandbox():
    from seraphine.config import Settings

    assert Settings(agents_codex_windows_sandbox="Elevated").agents_codex_windows_sandbox == "elevated"
    assert Settings().agents_codex_windows_sandbox == "unelevated"
    with pytest.raises(Exception):
        Settings(agents_codex_windows_sandbox="off")


def test_codex_effort_and_local_provider(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(codex_mod, "_is_windows", lambda: False)
    reg = ProviderRegistry(make_settings())
    eng = CodexEngine()
    ctx = EngineContext(tmp_path, "p", SANDBOX_READ_ONLY, "qwen3:8b", reg.get("ollama"), "high")
    run = eng.build_run_args("codex", ctx)
    assert run[run.index("--local-provider") + 1] == "ollama" and "--oss" in run
    assert 'model_reasoning_effort="high"' in run
    res = eng.build_resume_args("codex", ctx, "sess")
    assert 'model_provider="ollama"' in res and "--oss" not in res
    plain = eng.build_run_args("codex", EngineContext(tmp_path, "p", SANDBOX_READ_ONLY, None, reg.get("openai")))
    assert "--oss" not in plain and "--local-provider" not in plain
    for args in (run, res, plain):
        assert not any("dangerously" in a or "danger-full-access" in a for a in args)


async def test_codex_local_provider_needs_model(tmp_path: Path):
    reg = ProviderRegistry(make_settings())
    eng = CodexEngine(executable=_script_exe(tmp_path, "fc", "import sys\nsys.exit(0)\n"))
    res = await eng.run(EngineContext(tmp_path, "p", SANDBOX_READ_ONLY, None, reg.get("ollama")),
                        _noop, asyncio.Event())
    assert res.error and "modelo" in res.error


async def test_codex_auth_failure_detected(tmp_path: Path):
    proj = tmp_path / "proj"
    proj.mkdir()
    exe = _script_exe(
        tmp_path, "authfail",
        "import json, sys\nsys.stdin.read()\n"
        "print(json.dumps({'type': 'thread.started', 'thread_id': 't'}), flush=True)\n"
        "print(json.dumps({'type': 'turn.failed', 'error': {'message': '401 Unauthorized: not logged in'}}), flush=True)\n"
        "sys.exit(1)\n")
    res = await CodexEngine(executable=exe).run(
        EngineContext(proj, "x", SANDBOX_READ_ONLY), _noop, asyncio.Event())
    assert res.error == CODEX_AUTH and res.error_code == "engine_auth"


# -- claude: executable resolution ---------------------------------------------


def _bundle(root: Path, version: str, digest: str, mtime: float | None = None) -> Path:
    exe = root / "Claude-Data" / "claude_pkg" / "claude-code" / version / digest / "claude.exe"
    exe.parent.mkdir(parents=True)
    exe.write_bytes(b"")
    if mtime is not None:
        os.utime(exe, (mtime, mtime))
    return exe


def test_claude_exe_resolution_order(monkeypatch, tmp_path: Path):
    local = tmp_path / "local"
    old = _bundle(local, "2.1.9", "aaa")
    new = _bundle(local, "2.1.321", "bbb")  # 2.1.321 > 2.1.9 numerically, not lexically
    assert resolve_claude_exe  # imported
    monkeypatch.setattr(claude_mod, "_is_windows", lambda: True)
    monkeypatch.setenv("LOCALAPPDATA", str(local))
    monkeypatch.setattr(claude_mod.shutil, "which", lambda _: None)
    assert resolve_claude_exe("") == new and old.exists()
    # same version: the newest mtime wins
    newer = _bundle(local, "2.1.321", "ccc", mtime=new.stat().st_mtime + 100)
    assert resolve_claude_exe("") == newer
    # PATH beats the bundled copy
    monkeypatch.setattr(claude_mod.shutil, "which", lambda n: "/usr/bin/claude" if n == "claude" else None)
    assert resolve_claude_exe("") == Path("/usr/bin/claude")
    # the explicit setting beats PATH
    explicit = tmp_path / "mine" / "claude.exe"
    explicit.parent.mkdir()
    explicit.write_bytes(b"")
    assert resolve_claude_exe(str(explicit)) == explicit
    # a setting that points nowhere falls through to the next source
    assert resolve_claude_exe(str(tmp_path / "nope.exe")) == Path("/usr/bin/claude")
    # not found anywhere
    monkeypatch.setattr(claude_mod.shutil, "which", lambda _: None)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "empty"))
    assert resolve_claude_exe("") is None
    ok, reason = ClaudeCodeEngine().available()
    assert not ok and "agents_claude_path" in reason
    # the bundle lookup is Windows-only
    monkeypatch.setattr(claude_mod, "_is_windows", lambda: False)
    monkeypatch.setenv("LOCALAPPDATA", str(local))
    assert resolve_claude_exe("") is None


def test_claude_available_with_bundle(monkeypatch, tmp_path: Path):
    exe = _bundle(tmp_path, "2.1.321", "d0e2")
    monkeypatch.setattr(claude_mod, "_is_windows", lambda: True)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    monkeypatch.setattr(claude_mod.shutil, "which", lambda _: None)
    eng = ClaudeCodeEngine()
    assert eng.available() == (True, "ok") and eng._resolve() == exe


# -- claude: command line ------------------------------------------------------


def test_claude_command_line(tmp_path: Path):
    eng = ClaudeCodeEngine()
    rw = eng.build_args("claude", EngineContext(tmp_path, "p", SANDBOX_WORKSPACE_WRITE, "opus", None, "low"), "sid")
    ro = eng.build_args("claude", EngineContext(tmp_path, "p", SANDBOX_READ_ONLY))
    assert rw[rw.index("--permission-mode") + 1] == "acceptEdits"
    assert ro[ro.index("--permission-mode") + 1] == "plan"
    assert rw[rw.index("--resume") + 1] == "sid" and rw[rw.index("--model") + 1] == "opus"
    assert rw[rw.index("--effort") + 1] == "low" and "--effort" not in ro
    for args in (rw, ro):
        assert args[:2] == ["claude", "-p"]
        assert args[args.index("--output-format") + 1] == "stream-json" and "--verbose" in args
        assert "--restricted" in args and "--strict-mcp-config" in args
        assert "--setting-sources" not in args  # fragile with an empty value; --restricted covers it
        assert args[args.index("--permission-prompts") + 1] == "none"
        assert "Bash" not in args[args.index("--tools") + 1]
        mode = args[args.index("--permission-mode") + 1]
        assert mode in ("plan", "acceptEdits")
        assert not any("bypass" in a.lower() or "dangerously" in a.lower() or a in ("dontAsk", "auto")
                       for a in args)
        assert str(tmp_path) not in args  # cwd is the process cwd; prompt via stdin only
    assert claude_mod.permission_mode_for(SANDBOX_READ_ONLY) == "plan"
    assert claude_mod.permission_mode_for(SANDBOX_WORKSPACE_WRITE) == "acceptEdits"
    assert claude_mod._FORBIDDEN_MODES == {"bypassPermissions", "dontAsk", "auto"}


# -- claude: auth detection ----------------------------------------------------

# Recorded from the real claude 2.1.321 CLI while logged out (trimmed).
_AUTH_TEXT = ("Failed to authenticate: this login reached its time limit and cannot be renewed. "
              "Run `claude auth login` to sign in again")
REAL_AUTH_STREAM = [
    {"type": "system", "subtype": "init", "session_id": "e0d8", "model": "claude-opus-5-5", "tools": ["Edit", "Read"]},
    {"type": "assistant", "session_id": "e0d8", "error": "authentication_failed", "is_api_error_message": True,
     "message": {"model": "<synthetic>", "role": "assistant", "usage": {"input_tokens": 0, "output_tokens": 0},
                 "content": [{"type": "text", "text": _AUTH_TEXT}]}},
    {"type": "result", "subtype": "success", "is_error": True, "terminal_reason": "api_error",
     "session_id": "e0d8", "total_cost_usd": 0, "usage": {"input_tokens": 0, "output_tokens": 0},
     "result": _AUTH_TEXT},
]


def test_claude_auth_error_stream_shape():
    p = ClaudeStreamParser()
    events = [e for line in REAL_AUTH_STREAM for e in p.feed(json.dumps(line))]
    assert CLAUDE_AUTH == "O Claude Code não está conectado. Rode `claude auth login` no terminal e tente de novo."
    assert p.auth_failed and p.error == CLAUDE_AUTH
    # the raw English text is never shown (the session is reported first, internally)
    assert [e for e in events if not e[0].startswith("_")] == [("error", {"message": CLAUDE_AUTH})]
    assert p.session_ref == "e0d8" and p.final_message == ""


def test_claude_auth_error_result_only_and_synthetic_only():
    only_result = ClaudeStreamParser()
    only_result.feed(json.dumps(REAL_AUTH_STREAM[2]))
    assert only_result.auth_failed
    synthetic = ClaudeStreamParser()
    line = {"type": "assistant", "message": {"model": "<synthetic>", "usage": {"input_tokens": 0, "output_tokens": 0},
                                              "content": [{"type": "text", "text": _AUTH_TEXT}]}}
    assert synthetic.feed(json.dumps(line)) == [("error", {"message": CLAUDE_AUTH})]
    other = ClaudeStreamParser()  # a normal error result is NOT an auth failure
    other.feed(json.dumps({"type": "result", "is_error": True, "result": "rate limited"}))
    assert not other.auth_failed and other.error == "rate limited"


async def test_claude_engine_auth_failure_end_to_end(tmp_path: Path):
    proj = tmp_path / "proj"
    proj.mkdir()
    body = "import sys\nsys.stdin.read()\n" + "".join(
        f"print({json.dumps(x)!r}, flush=True)\n" for x in REAL_AUTH_STREAM) + "sys.exit(1)\n"
    exe = _script_exe(tmp_path, "fakeclaude", body)
    seen = []

    async def on_event(kind, payload):
        seen.append((kind, payload))

    res = await ClaudeCodeEngine(executable=exe).run(
        EngineContext(proj, "oi", SANDBOX_READ_ONLY), on_event, asyncio.Event())
    assert res.error == CLAUDE_AUTH and res.error_code == "engine_auth" and res.exit_code == 1
    assert [e for e in seen if not e[0].startswith("_")] == [("error", {"message": CLAUDE_AUTH})]


def test_claude_parser_user_tool_result_error():
    p = ClaudeStreamParser()
    p.feed(json.dumps({"type": "assistant", "message": {"content": [
        {"type": "tool_use", "id": "tu1", "name": "Read", "input": {"file_path": "x.py"}}]}}))
    ev = p.feed(json.dumps({"type": "user", "message": {"content": [
        {"type": "tool_result", "tool_use_id": "tu1", "is_error": True, "content": "fora da pasta"}]}}))
    assert ev == [
        ("step", {"type": "tool_use", "phase": "completed", "call_id": "tu1", "tool": "Read",
                  "target": "x.py", "read_only": True, "failed": True, "error": "fora da pasta"}),
        ("step", {"type": "note", "text": "Read falhou: fora da pasta"}),
    ]


def test_get_engines_registry():
    engines = get_engines(make_settings())
    assert set(engines) == {"codex", "claude_code", "chat"}
    assert all(callable(e.available) for e in engines.values())
    assert engines["chat"].can_act is False and engines["codex"].can_act and engines["claude_code"].can_act
