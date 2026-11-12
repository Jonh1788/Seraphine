"""Engine tests: parsers against recorded-style fixtures, command lines, fake executable."""

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
from seraphine.agents.engines.codex import AUTH_MESSAGE as CODEX_AUTH, CodexEngine, CodexEventParser
from seraphine.agents.providers import ProviderRegistry

from .conftest import make_settings

# thread.started / item.started / item.completed (agent_message, command_execution) /
# turn.completed shapes were verified against real codex-cli 0.153.0 runs
# (reasoning / file_change come from the documented stream).
CODEX_JSONL = "\n".join(json.dumps(e) for e in [
    {"type": "thread.started", "thread_id": "0199aaaa-bbbb-cccc-dddd-eeeeeeeeeeee"},
    {"type": "turn.started"},
    {"type": "item.completed", "item": {"id": "i0", "type": "reasoning", "text": "Vou olhar os arquivos"}},
    {"type": "item.started", "item": {"id": "i1", "type": "command_execution", "command": "ls", "status": "in_progress"}},
    {"type": "item.completed", "item": {"id": "i1", "type": "command_execution", "command": "ls",
                                         "aggregated_output": "a.py\nb.py\n", "exit_code": 0, "status": "completed"}},
    {"type": "item.completed", "item": {"id": "i2", "type": "file_change", "status": "completed",
                                         "changes": [{"path": "a.py", "kind": "update"}]}},
    {"type": "item.completed", "item": {"id": "i3", "type": "agent_message", "text": "Rascunho"}},
    {"type": "item.completed", "item": {"id": "i4", "type": "agent_message", "text": "Pronto, alterei a.py."}},
    {"type": "turn.completed", "usage": {"input_tokens": 1200, "cached_input_tokens": 800, "output_tokens": 90,
                                                    "reasoning_output_tokens": 30}},
])


def test_codex_parser_full_stream():
    p = CodexEventParser()
    events = []
    for line in CODEX_JSONL.splitlines():
        events.extend(p.feed(line))
    assert p.session_ref == "0199aaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    assert p.final_message == "Pronto, alterei a.py."  # the LAST agent_message
    assert (p.tokens_in, p.tokens_out) == (1200, 90) and p.turn_completed and p.error is None
    kinds = [k for k, _ in events]
    assert kinds == ["_session", "step", "step", "command", "step", "message", "message"]
    assert events[0][1] == {"session_ref": "0199aaaa-bbbb-cccc-dddd-eeeeeeeeeeee"}  # known at once
    assert events[1][1] == {"type": "reasoning", "text": "Vou olhar os arquivos"}
    # the command is bracketed by its item id: started step, then the command event
    assert events[2][1] == {"type": "command", "phase": "started", "call_id": "i1",
                            "command": "ls", "by": "agent"}
    done = events[3][1]
    assert done["command"] == "ls" and done["exit_code"] == 0 and done["by"] == "agent"
    assert done["phase"] == "completed" and done["call_id"] == "i1"
    # a file change reported only at its end is a single completed event
    assert events[4][1] == {"type": "file_change", "changes": [{"path": "a.py", "kind": "update"}],
                            "phase": "completed", "call_id": "i2"}


def test_codex_parser_failures_and_garbage():
    p = CodexEventParser()
    assert p.feed("not json") == [] and p.feed("[1,2]") == [] and p.feed('{"type":"unknown.thing"}') == []
    ev = p.feed(json.dumps({"type": "turn.failed", "error": {"message": "limite da conta"}}))
    assert p.error == "limite da conta" and ev == [("error", {"message": "limite da conta"})]
    q = CodexEventParser()
    assert q.feed(json.dumps({"type": "error", "message": "Reconnecting..."}))[0][0] == "error"
    assert q.error is None  # transient stream errors are not terminal


def test_codex_command_lines(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(codex_mod, "_is_windows", lambda: False)
    eng = CodexEngine()
    ctx = EngineContext(project_path=tmp_path, prompt="p", sandbox=SANDBOX_WORKSPACE_WRITE, model="gpt-x")
    run = eng.build_run_args("codex", ctx)
    assert run[:3] == ["codex", "exec", "--json"]
    assert run[run.index("--sandbox") + 1] == "workspace-write"
    assert run[run.index("--cd") + 1] == str(tmp_path)
    assert run[run.index("--model") + 1] == "gpt-x"
    assert run[-1] == "-" and "--skip-git-repo-check" in run and "--ignore-user-config" in run
    ro = eng.build_run_args("codex", EngineContext(tmp_path, "p", SANDBOX_READ_ONLY))
    assert ro[ro.index("--sandbox") + 1] == "read-only" and "--model" not in ro
    res = eng.build_resume_args("codex", ctx, "sess-1")
    assert res[:4] == ["codex", "exec", "resume", "--json"]
    assert res[-2:] == ["sess-1", "-"]
    assert 'sandbox_mode="workspace-write"' in res
    assert "--sandbox" not in res and "--cd" not in res  # not accepted by `exec resume`
    for args in (run, ro, res):
        assert not any("dangerously" in a or "danger-full-access" in a or "bypass" in a for a in args)
    with pytest.raises(ValueError):
        eng.build_run_args("codex", EngineContext(tmp_path, "p", "danger-full-access"))


def test_codex_available_reflects_which(monkeypatch):
    monkeypatch.setattr("seraphine.agents.engines.codex.shutil.which", lambda _: None)
    ok, reason = CodexEngine().available()
    assert not ok and "Codex" in reason
    monkeypatch.setattr("seraphine.agents.engines.codex.shutil.which", lambda _: "/bin/codex")
    assert CodexEngine().available() == (True, "ok")


# -- fake executable: exercises the real subprocess plumbing --------------------


def _fake_codex(tmp_path: Path, *, behaviour: str = "ok") -> str:
    """A fake `codex`: records argv + stdin, prints JSONL, honours resume."""
    script = tmp_path / "fake_codex.py"
    script.write_text(
        "import json, sys, time\n"
        "argv = sys.argv[1:]\n"
        "prompt = sys.stdin.read()\n"
        f"open(r'{tmp_path / 'argv.json'}', 'w').write(json.dumps({{'argv': argv, 'stdin': prompt}}))\n"
        f"behaviour = {behaviour!r}\n"
        "if behaviour == 'hang':\n"
        "    print(json.dumps({'type': 'thread.started', 'thread_id': 'hung'}), flush=True)\n"
        "    time.sleep(60)\n"
        "sid = argv[-2] if 'resume' in argv else 'new-session'\n"
        "print(json.dumps({'type': 'thread.started', 'thread_id': sid}), flush=True)\n"
        "print(json.dumps({'type': 'item.completed', 'item': {'type': 'agent_message', 'text': 'ola ' + prompt.strip()}}), flush=True)\n"
        "print(json.dumps({'type': 'turn.completed', 'usage': {'input_tokens': 5, 'output_tokens': 2}}), flush=True)\n"
        "sys.exit(7 if behaviour == 'exit7' else 0)\n",
        encoding="utf-8",
    )
    if os.name == "nt":
        wrapper = tmp_path / "fakecodex.cmd"
        wrapper.write_text(f'@echo off\r\n"{sys.executable}" "{script}" %*\r\n', encoding="utf-8")
    else:
        wrapper = tmp_path / "fakecodex"
        wrapper.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{script}" "$@"\n', encoding="utf-8")
        wrapper.chmod(wrapper.stat().st_mode | stat.S_IEXEC)
    return str(wrapper)


async def _noop(kind, payload):
    pass


async def test_codex_engine_end_to_end_with_fake_executable(tmp_path: Path):
    proj = tmp_path / "proj"
    proj.mkdir()
    eng = CodexEngine(executable=_fake_codex(tmp_path))
    assert eng.available()[0]
    seen = []

    async def on_event(kind, payload):
        seen.append(kind)

    ctx = EngineContext(project_path=proj, prompt="mundo", sandbox=SANDBOX_READ_ONLY)
    res = await eng.run(ctx, on_event, asyncio.Event())
    assert res.error is None and res.final_message == "ola mundo"
    assert res.session_ref == "new-session" and (res.tokens_in, res.tokens_out) == (5, 2)
    # the process id and the session are reported early through internal kinds
    assert seen[0] == "_process" and "_session" in seen and seen[-1] == "message"
    assert [k for k in seen if not k.startswith("_")] == ["message"]
    rec = json.loads((tmp_path / "argv.json").read_text())
    assert rec["stdin"] == "mundo"  # prompt via stdin, never argv
    assert "mundo" not in rec["argv"] and "read-only" in rec["argv"]

    res2 = await eng.resume(ctx, "sess-abcdef", "continue", on_event, asyncio.Event())
    assert res2.session_ref == "sess-abcdef" and res2.final_message == "ola continue"
    rec = json.loads((tmp_path / "argv.json").read_text())
    assert rec["argv"][:2] == ["exec", "resume"] and "sess-abcdef" in rec["argv"]


async def test_codex_engine_nonzero_exit_is_error(tmp_path: Path):
    proj = tmp_path / "proj"
    proj.mkdir()
    eng = CodexEngine(executable=_fake_codex(tmp_path, behaviour="exit7"))
    res = await eng.run(EngineContext(proj, "x", SANDBOX_READ_ONLY), _noop, asyncio.Event())
    assert res.exit_code == 7 and res.error and "7" in res.error


async def test_codex_engine_cancel_kills_process(tmp_path: Path):
    proj = tmp_path / "proj"
    proj.mkdir()
    eng = CodexEngine(executable=_fake_codex(tmp_path, behaviour="hang"))
    cancel = asyncio.Event()
    task = asyncio.create_task(eng.run(EngineContext(proj, "x", SANDBOX_READ_ONLY), _noop, cancel))
    await asyncio.sleep(1.0)
    cancel.set()
    res = await asyncio.wait_for(task, 20)
    assert res.error is None and res.final_message == ""  # cancelled, not failed


# -- claude -------------------------------------------------------------------

# Written from Maestro's recorded fixture (src-tauri/tests/fixtures/agent/basic_run.jsonl)
# plus an assistant tool_use / permission-denial shape. NOT seen from a logged-in 2.1.321 CLI
# (only init and the auth-failure shapes were recorded; see test_runtimes.py).
CLAUDE_JSONL = "\n".join(json.dumps(e) for e in [
    {"type": "system", "subtype": "init", "session_id": "e6ce309f-b7f6-4ff7-a4b0-f2afaa4ce3bb", "model": "claude-x"},
    {"type": "rate_limit_event", "rate_limit_info": {"status": "allowed"}},
    {"type": "assistant", "session_id": "e6ce309f-b7f6-4ff7-a4b0-f2afaa4ce3bb",
     "message": {"content": [{"type": "text", "text": "Vou listar."},
                             {"type": "tool_use", "name": "Bash", "input": {"command": "ls"}},
                             {"type": "tool_use", "name": "Read", "input": {"file_path": "a.py"}}]}},
    {"type": "assistant", "message": {"content": [{"type": "text", "text": "pong"}]}},
    {"type": "result", "subtype": "success", "is_error": False, "result": "pong",
     "session_id": "e6ce309f-b7f6-4ff7-a4b0-f2afaa4ce3bb", "total_cost_usd": 0.045884,
     "usage": {"input_tokens": 2488, "cache_creation_input_tokens": 2496, "output_tokens": 4},
     "permission_denials": [{"tool_name": "Bash", "tool_input": {"command": "git push"}}]},
])


def test_claude_parser():
    p = ClaudeStreamParser()
    events = []
    for line in CLAUDE_JSONL.splitlines():
        events.extend(p.feed(line))
    assert p.session_ref == "e6ce309f-b7f6-4ff7-a4b0-f2afaa4ce3bb"
    assert p.final_message == "pong" and p.error is None
    assert (p.tokens_in, p.tokens_out) == (2488, 4) and abs(p.cost_usd - 0.045884) < 1e-9
    assert p.denials == ["Bash"]
    assert [k for k, _ in events] == ["_session", "message", "step", "step", "message"]
    assert events[0][1] == {"session_ref": "e6ce309f-b7f6-4ff7-a4b0-f2afaa4ce3bb"}
    # Bash is not even available under --restricted; if it shows up it is only a step.
    # These blocks have no id, so they cannot be paired: a single completed event each.
    assert events[2][1] == {"type": "tool_use", "phase": "completed", "call_id": "anon-1",
                            "tool": "Bash", "target": "ls"}
    assert events[3][1] == {"type": "tool_use", "phase": "completed", "call_id": "anon-2",
                            "tool": "Read", "target": "a.py", "read_only": True}


def test_claude_parser_brackets_tool_calls_by_id():
    p = ClaudeStreamParser()
    lines = [
        {"type": "assistant", "session_id": "s1", "message": {"content": [
            {"type": "tool_use", "id": "tu1", "name": "Edit", "input": {"file_path": "a.py"}}]}},
        {"type": "user", "session_id": "s1", "message": {"content": [
            {"type": "tool_result", "tool_use_id": "tu1", "content": "ok"}]}},
        {"type": "assistant", "session_id": "s1", "message": {"content": [
            {"type": "tool_use", "id": "tu2", "name": "Write", "input": {"file_path": "b.py"}}]}},
        {"type": "user", "session_id": "s1", "message": {"content": [
            {"type": "tool_result", "tool_use_id": "tu2", "is_error": True, "content": "negado"}]}},
    ]
    events = [e for line in lines for e in p.feed(json.dumps(line))]
    assert [k for k, _ in events] == ["_session", "step", "step", "step", "step", "step"]
    assert events[1][1] == {"type": "tool_use", "phase": "started", "call_id": "tu1",
                            "tool": "Edit", "target": "a.py"}
    assert events[2][1]["phase"] == "completed" and events[2][1]["call_id"] == "tu1"
    assert events[4][1]["phase"] == "completed" and events[4][1]["call_id"] == "tu2"
    assert events[5][1] == {"type": "note", "text": "Write falhou: negado"}  # the old error note stays


def test_claude_parser_error_result():
    p = ClaudeStreamParser()
    ev = p.feed(json.dumps({"type": "result", "subtype": "error_during_execution", "is_error": True,
                            "result": "falhou", "session_id": "s"}))
    assert p.error == "falhou" and [k for k, _ in ev if not k.startswith("_")] == ["error"]
    assert p.feed("garbage") == []


