"""Phase 3b: how the engines declare the bridge (exact command lines, environment), what their
parsers do with the Seraphine server's calls (shapes recorded by the bench in
``contratos/fase-3-bancada.md``), the grants routes, the settings and the migration."""

from __future__ import annotations

import asyncio
import json
import sqlite3
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from seraphine.agents import schema as agents_schema
from seraphine.agents.engines import claude_code as claude_mod
from seraphine.agents.engines import codex as codex_mod
from seraphine.agents.engines.base import (
    BridgeSpec, EngineContext, SANDBOX_READ_ONLY, SANDBOX_WORKSPACE_WRITE,
)
from seraphine.agents.engines.claude_code import ClaudeCodeEngine, ClaudeStreamParser
from seraphine.agents.engines.codex import CodexEngine, CodexEventParser
from seraphine.agents.routes import TOKEN_HEADER, router
from seraphine.agents.service import AgentHarnessService
from seraphine.config import Settings

from .conftest import ORIGIN, setup_agent

TOKEN = "TOKEN-SECRETO-DO-TURNO"
#: What an agent with nothing stored gets (3c added the project tasks and the reminders).
DEFAULTS = {"notes": "read", "wiki": "read", "memory": "none", "project_tasks": "read", "reminders": "none"}


def bridge() -> BridgeSpec:
    return BridgeSpec(server="seraphine", python=r"C:\py\python.exe", script=r"C:\x\mcp_stdio.py",
                      url="http://127.0.0.1:8000", tools_file=r"C:\t\tools.json", token=TOKEN)


# -- Codex command lines -------------------------------------------------------------------------

CODEX_BRIDGE = [
    "-c", r'mcp_servers.seraphine.command="C:\\py\\python.exe"',
    "-c", r'mcp_servers.seraphine.args=["-I","-S","C:\\x\\mcp_stdio.py"]',
    "-c", ('mcp_servers.seraphine.env={SERAPHINE_BRIDGE_URL="http://127.0.0.1:8000",'
           f'SERAPHINE_BRIDGE_TOKEN="{TOKEN}",SERAPHINE_BRIDGE_TOOLS="C:\\\\t\\\\tools.json"}}'),
    "-c", 'mcp_servers.seraphine.default_tools_approval_mode="approve"',
]


@pytest.mark.parametrize("tier", [SANDBOX_READ_ONLY, SANDBOX_WORKSPACE_WRITE])
@pytest.mark.parametrize("with_tools", [False, True])
def test_codex_argv_is_exactly_this(tmp_path: Path, monkeypatch, tier: str, with_tools: bool):
    monkeypatch.setattr(codex_mod, "_is_windows", lambda: False)
    ctx = EngineContext(project_path=tmp_path, prompt="p", sandbox=tier, bridge=bridge() if with_tools else None)
    eng = CodexEngine()
    extra = CODEX_BRIDGE if with_tools else []
    assert eng.build_run_args("codex", ctx) == [
        "codex", "exec", "--json", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check",
        "--color", "never", "--sandbox", tier, "--cd", str(tmp_path),
        "-c", 'approval_policy="never"', *extra, "-"]
    assert eng.build_resume_args("codex", ctx, "sess-1") == [
        "codex", "exec", "resume", "--json", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check",
        "-c", f'sandbox_mode="{tier}"', "-c", 'approval_policy="never"', *extra, "sess-1", "-"]


def test_codex_with_tools_changes_nothing_but_the_four_server_options(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(codex_mod, "_is_windows", lambda: True)  # the Windows sandbox option stays too
    eng = CodexEngine()
    plain = eng.build_run_args("codex", EngineContext(tmp_path, "p", SANDBOX_READ_ONLY))
    withb = eng.build_run_args("codex", EngineContext(tmp_path, "p", SANDBOX_READ_ONLY, bridge=bridge()))
    i = next(n for n, a in enumerate(withb) if a.startswith("mcp_servers.seraphine.command")) - 1
    assert withb[i:i + len(CODEX_BRIDGE)] == CODEX_BRIDGE
    assert withb[:i] + withb[i + len(CODEX_BRIDGE):] == plain  # nothing removed, nothing else added
    assert 'windows.sandbox="unelevated"' in withb and 'approval_policy="never"' in withb
    assert "mcp_servers" not in " ".join(plain)
    assert sum("default_tools_approval_mode" in a for a in withb) == 1  # one server, never global
    assert not any(a.startswith("approval_mode") or a == "--full-auto" for a in withb)
    for args in (plain, withb):
        assert not any("dangerously" in a or "danger-full-access" in a or "bypass" in a for a in args)


# -- Claude Code command lines ---------------------------------------------------------------------

MCP_JSON = json.dumps({"mcpServers": {"seraphine": {
    "command": r"C:\py\python.exe", "args": ["-I", "-S", r"C:\x\mcp_stdio.py"],
    "env": {"SERAPHINE_BRIDGE_URL": "${SERAPHINE_BRIDGE_URL}",
            "SERAPHINE_BRIDGE_TOKEN": "${SERAPHINE_BRIDGE_TOKEN}",
            "SERAPHINE_BRIDGE_TOOLS": "${SERAPHINE_BRIDGE_TOOLS}"}}}}, separators=(",", ":"))
FULL_TOOLS = "Read,Glob,Grep,Edit,Write,NotebookEdit,WebSearch"
READ_TOOLS = "Read,Glob,Grep,WebSearch"


def claude_expected(mode: str, tools: str, *, with_tools: bool, resume: str | None = None) -> list[str]:
    args = ["claude", "-p", "--output-format", "stream-json", "--verbose", "--restricted", "--strict-mcp-config",
            "--permission-mode", mode, "--permission-prompts", "none", "--tools", tools]
    if resume:
        args += ["--resume", resume]
    if with_tools:  # always last: --allowedTools swallows what follows
        args += ["--mcp-config", MCP_JSON, "--allowedTools", "mcp__seraphine"]
    return args


@pytest.mark.parametrize("resume", [None, "sess-9"])
def test_claude_argv_is_exactly_this_in_the_four_cases(tmp_path: Path, resume: str | None):
    eng = ClaudeCodeEngine()

    def build(tier: str, with_tools: bool) -> list[str]:
        ctx = EngineContext(tmp_path, "p", tier, bridge=bridge() if with_tools else None)
        return eng.build_args("claude", ctx, resume)

    # read-only, no tools: exactly what it was (plan, edit tools in the list as before)
    assert build(SANDBOX_READ_ONLY, False) == claude_expected("plan", FULL_TOOLS, with_tools=False, resume=resume)
    # read-only with tools: plan blocks MCP, so manual -- with only the read tools
    assert build(SANDBOX_READ_ONLY, True) == claude_expected("manual", READ_TOOLS, with_tools=True, resume=resume)
    # edit, no tools / with tools: acceptEdits, same native tools, the server allowed
    assert build(SANDBOX_WORKSPACE_WRITE, False) == claude_expected(
        "acceptEdits", FULL_TOOLS, with_tools=False, resume=resume)
    assert build(SANDBOX_WORKSPACE_WRITE, True) == claude_expected(
        "acceptEdits", FULL_TOOLS, with_tools=True, resume=resume)


def test_claude_argv_never_loosens_anything_and_never_carries_the_token(tmp_path: Path):
    eng = ClaudeCodeEngine()
    for tier in (SANDBOX_READ_ONLY, SANDBOX_WORKSPACE_WRITE):
        for with_tools in (False, True):
            args = eng.build_args("claude", EngineContext(tmp_path, "p", tier, bridge=bridge() if with_tools else None))
            assert args[args.index("--permission-mode") + 1] in ("plan", "manual", "acceptEdits")
            assert not any(a in ("bypassPermissions", "dontAsk", "auto", "--dangerously-skip-permissions")
                           for a in args)
            for kept in ("--restricted", "--strict-mcp-config"):
                assert kept in args
            assert args[args.index("--permission-prompts") + 1] == "none"
            assert TOKEN not in " ".join(args)  # the token reaches Claude only through its environment
            if with_tools:
                assert "${SERAPHINE_BRIDGE_TOKEN}" in args[args.index("--mcp-config") + 1]
                assert args.count("--allowedTools") == 1 and args[-1] == "mcp__seraphine"  # not the whole tool set
    assert claude_mod.permission_mode_for(SANDBOX_READ_ONLY) == "plan"  # the one-argument form is unchanged


# -- how the token reaches the bridge ------------------------------------------------------------------


async def _drive_capture(monkeypatch, module, engine, ctx: EngineContext, resume: bool = False) -> dict[str, Any]:
    seen: dict[str, Any] = {}

    async def fake_run_lines(args, **kw):
        seen["args"], seen["env"] = args, kw.get("env")
        return 0, "", False

    monkeypatch.setattr(module, "run_lines", fake_run_lines)
    on_event = lambda kind, payload: asyncio.sleep(0)  # noqa: E731
    if resume:
        await engine.resume(ctx, "sess-1", "msg", on_event, asyncio.Event())
    else:
        await engine.run(ctx, on_event, asyncio.Event())
    return seen


async def test_claude_gets_the_three_values_in_its_own_environment_only(tmp_path: Path, monkeypatch):
    eng = ClaudeCodeEngine(env_factory=lambda: {"PATH": "p", "OPENROUTER_API_KEY_REMOVED": "no"})
    monkeypatch.setattr(eng, "_resolve", lambda: Path("claude"))
    ctx = EngineContext(tmp_path, "p", SANDBOX_WORKSPACE_WRITE, bridge=bridge())
    seen = await _drive_capture(monkeypatch, claude_mod, eng, ctx)
    assert seen["env"]["SERAPHINE_BRIDGE_TOKEN"] == TOKEN
    assert seen["env"]["SERAPHINE_BRIDGE_URL"] == "http://127.0.0.1:8000"
    assert seen["env"]["SERAPHINE_BRIDGE_TOOLS"] == r"C:\t\tools.json" and seen["env"]["PATH"] == "p"
    assert TOKEN not in " ".join(seen["args"])
    plain = await _drive_capture(monkeypatch, claude_mod, eng, EngineContext(tmp_path, "p", SANDBOX_WORKSPACE_WRITE))
    assert not any(k.startswith("SERAPHINE_BRIDGE") for k in plain["env"])


async def test_codex_never_puts_the_token_in_the_engines_environment(tmp_path: Path, monkeypatch):
    """Codex's shell inherits the engine's environment (bench cx17): the value goes through the
    server's ``env`` table, i.e. the bridge process's command line, and nowhere else."""
    eng = CodexEngine(env_factory=lambda: {"PATH": "p"})
    monkeypatch.setattr(eng, "_resolve", lambda: "codex")
    ctx = EngineContext(tmp_path, "p", SANDBOX_WORKSPACE_WRITE, bridge=bridge())
    for resume in (False, True):
        seen = await _drive_capture(monkeypatch, codex_mod, eng, ctx, resume=resume)
        assert seen["env"] == {"PATH": "p"}
        assert sum(TOKEN in a for a in seen["args"]) == 1  # only the bridge's env table


# -- parsers: the bridge's calls are not recorded twice ---------------------------------------------------


def feed_all(parser: Any, lines: list[dict]) -> list[tuple[str, dict]]:
    out: list[tuple[str, dict]] = []
    for line in lines:
        out += parser.feed(json.dumps(line))
    return out


CODEX_OK = [
    {"type": "item.started", "item": {"id": "item_0", "type": "mcp_tool_call", "server": "seraphine", "tool": "search_notes",
                                       "arguments": {"query": "x"}, "result": None, "error": None, "status": "in_progress"}},
    {"type": "item.completed", "item": {"id": "item_0", "type": "mcp_tool_call", "server": "seraphine", "tool": "search_notes",
                                         "arguments": {"query": "x"}, "status": "completed", "error": None,
                                         "result": {"content": [{"type": "text", "text": "ok"}], "structured_content": None}}},
]
CODEX_TOOL_ERROR = [  # the tool returned isError: status failed, error null, text inside result (bench: falha)
    {"type": "item.completed", "item": {"id": "item_1", "type": "mcp_tool_call", "server": "seraphine", "tool": "wiki_search",
                                         "arguments": {}, "status": "failed", "error": None,
                                         "result": {"content": [{"type": "text", "text": "Sem acesso"}], "structured_content": None}}},
]
CODEX_REFUSED = [  # bench cx01
    {"type": "item.started", "item": {"id": "item_0", "type": "mcp_tool_call", "server": "seraphine", "tool": "ping",
                                       "arguments": {"texto": "oi"}, "result": None, "error": None, "status": "in_progress"}},
    {"type": "item.completed", "item": {"id": "item_0", "type": "mcp_tool_call", "server": "seraphine", "tool": "ping",
                                         "arguments": {"texto": "oi"}, "result": None, "status": "failed",
                                         "error": {"message": "MCP tool call requires approval, but approval policy is never"}}},
]


def test_codex_parser_leaves_the_seraphine_servers_calls_to_the_gateway():
    assert feed_all(CodexEventParser(), CODEX_OK) == []
    assert feed_all(CodexEventParser(), CODEX_TOOL_ERROR) == []


def test_codex_parser_reads_the_engines_refusal_as_the_bridge_failure_signal():
    out = feed_all(CodexEventParser(), CODEX_REFUSED)
    assert out == [("_bridge", {"state": "failed", "reason": "MCP tool call requires approval, but approval policy is never"})]


def test_codex_parser_still_records_other_servers_tool_calls():
    other = [{**CODEX_OK[0], "item": {**CODEX_OK[0]["item"], "server": "bancada", "tool": "ping"}},
             {**CODEX_OK[1], "item": {**CODEX_OK[1]["item"], "server": "bancada", "tool": "ping"}}]
    out = feed_all(CodexEventParser(), other)
    assert [(k, p["type"], p["phase"], p["tool"]) for k, p in out] == [
        ("step", "tool_call", "started", "bancada.ping"), ("step", "tool_call", "completed", "bancada.ping")]


CLAUDE_INIT_FAILED = {"type": "system", "subtype": "init", "session_id": "s1", "tools": [],
                      "mcp_servers": [{"name": "seraphine", "status": "failed", "source": "dynamic"}]}
CLAUDE_INIT_OK = {"type": "system", "subtype": "init", "session_id": "s1",
                  "mcp_servers": [{"name": "seraphine", "status": "connected", "source": "dynamic"}]}
CLAUDE_CALL = [
    {"type": "assistant", "message": {"role": "assistant", "content": [
        {"type": "tool_use", "id": "toolu_1", "name": "mcp__seraphine__search_notes", "input": {"query": "x"}}]}},
    {"type": "user", "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "toolu_1", "content": [{"type": "text", "text": "ok"}]}]}},
    {"type": "assistant", "message": {"role": "assistant", "content": [
        {"type": "tool_use", "id": "toolu_2", "name": "mcp__seraphine__wiki_search", "input": {}}]}},
    {"type": "user", "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "toolu_2", "is_error": True,
         "content": "Sem acesso: este agente não pode usar o grupo «Wiki»."}]}},
]


def test_claude_parser_leaves_the_seraphine_servers_calls_and_their_errors_to_the_gateway():
    out = feed_all(ClaudeStreamParser(), CLAUDE_CALL)
    assert [k for k, _ in out] == []  # no step, and no "falhou" note for the gateway's own errors


def test_claude_parser_still_records_other_tools_and_failures():
    other = [{"type": "assistant", "message": {"content": [
        {"type": "tool_use", "id": "t9", "name": "mcp__bancada__ping", "input": {"texto": "oi"}}]}},
             {"type": "user", "message": {"content": [
                 {"type": "tool_result", "tool_use_id": "t9", "is_error": True, "content": "falhou"}]}}]
    out = feed_all(ClaudeStreamParser(), other)
    assert [p.get("phase") for k, p in out if k == "step" and p["type"] == "tool_use"] == ["started", "completed"]


def test_claude_parser_reads_the_server_status_in_system_init():
    assert feed_all(ClaudeStreamParser(), [CLAUDE_INIT_FAILED]) == [
        ("_session", {"session_ref": "s1"}), ("_bridge", {"state": "failed", "reason": "status failed"})]
    assert feed_all(ClaudeStreamParser(), [CLAUDE_INIT_OK]) == [("_session", {"session_ref": "s1"})]
    other = {**CLAUDE_INIT_FAILED, "mcp_servers": [{"name": "outro", "status": "failed"}]}
    assert [k for k, _ in feed_all(ClaudeStreamParser(), [other])] == ["_session"]  # not ours


def test_claude_parser_reads_a_permission_denial_of_a_seraphine_tool_as_the_failure_signal():
    denied = {"type": "system", "subtype": "permission_denied", "tool_name": "mcp__seraphine__ping"}
    assert feed_all(ClaudeStreamParser(), [denied]) == [("_bridge", {"state": "failed", "reason": "permission_denied"})]
    assert feed_all(ClaudeStreamParser(), [{**denied, "tool_name": "Write"}]) == []


# -- grants routes ------------------------------------------------------------------------------------------


@pytest.fixture
def app(svc: AgentHarnessService) -> FastAPI:
    a = FastAPI()
    a.include_router(router)
    a.state.agent_harness = svc
    return a


def api(app: FastAPI) -> httpx.AsyncClient:
    transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 50000))
    return httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8000")


async def test_grants_default_to_read_for_notes_wiki_and_tasks_and_none_for_memory_and_reminders(
        app, svc, project_dir):
    agent, _ = await setup_agent(svc, project_dir)
    async with api(app) as c:
        h = {TOKEN_HEADER: svc.token}
        r = await c.get(f"/agents/defs/{agent['id']}/grants", headers=h)
        assert r.status_code == 200 and r.json() == {"grants": DEFAULTS}
        assert (await c.get("/agents/defs/nao-existe/grants", headers=h)).status_code == 404


async def test_put_grants_accepts_partial_updates_and_returns_the_full_map(app, svc, project_dir):
    agent, _ = await setup_agent(svc, project_dir)
    url = f"/agents/defs/{agent['id']}/grants"
    async with api(app) as c:
        h = {TOKEN_HEADER: svc.token}
        r = await c.put(url, json={"grants": {"memory": "read"}}, headers=h)
        assert r.status_code == 200 and r.json() == {"grants": {**DEFAULTS, "memory": "read"}}
        r = await c.put(url, json={"grants": {"notes": "none", "memory": "none"}}, headers=h)
        assert r.json() == {"grants": {**DEFAULTS, "notes": "none"}}
        assert (await c.get(url, headers=h)).json() == r.json()
        # a stored value overrides the default; another agent keeps the defaults
        other, _ = await setup_agent(svc, project_dir, name="Outro")
        assert (await c.get(f"/agents/defs/{other['id']}/grants", headers=h)).json()["grants"]["notes"] == "read"


@pytest.mark.parametrize("body", [
    {"grants": {"memory": "write"}},          # no tool of that group writes
    {"grants": {"wiki": "write"}},
    {"grants": {"tarefas": "read"}},          # unknown group
    {"grants": {"system": "none"}},           # the system group is not configurable
    {"grants": {"notes": "tudo"}},            # invalid level
    {"grants": {"notes": 1}},
    {"grants": ["notes"]},
    {},
])
async def test_put_grants_refuses_write_unknown_groups_and_bad_levels_with_422(app, svc, project_dir, body):
    agent, _ = await setup_agent(svc, project_dir)
    async with api(app) as c:
        h = {TOKEN_HEADER: svc.token}
        r = await c.put(f"/agents/defs/{agent['id']}/grants", json=body, headers=h)
        assert r.status_code == 422
        # nothing was stored by the refused request
        assert (await c.get(f"/agents/defs/{agent['id']}/grants", headers=h)).json()["grants"] == DEFAULTS


async def test_a_refused_partial_update_does_not_apply_its_valid_part(app, svc, project_dir):
    agent, _ = await setup_agent(svc, project_dir)
    async with api(app) as c:
        h = {TOKEN_HEADER: svc.token}
        r = await c.put(f"/agents/defs/{agent['id']}/grants", json={"grants": {"memory": "read", "wiki": "write"}},
                        headers=h)
        assert r.status_code == 422
        assert (await c.get(f"/agents/defs/{agent['id']}/grants", headers=h)).json()["grants"]["memory"] == "none"


async def test_grants_routes_need_the_owner_token_and_an_allowed_origin(app, svc, project_dir):
    agent, _ = await setup_agent(svc, project_dir)
    async with api(app) as c:
        url = f"/agents/defs/{agent['id']}/grants"
        assert (await c.get(url)).status_code == 401
        assert (await c.put(url, json={"grants": {}})).status_code == 401
        assert (await c.get("/agents/tools")).status_code == 401
        assert (await c.get(url, headers={TOKEN_HEADER: svc.token, "Origin": "http://evil.example"})).status_code == 403
        assert (await c.get(url, headers={TOKEN_HEADER: svc.token, "Origin": ORIGIN})).status_code == 200


async def test_the_agent_object_carries_grants_everywhere_it_is_returned(app, svc, project_dir):
    default = DEFAULTS
    async with api(app) as c:
        h = {TOKEN_HEADER: svc.token}
        project = (await c.post("/agents/projects", json={"name": "P", "path": str(project_dir)}, headers=h)).json()["project"]
        made = (await c.post("/agents/defs", json={"name": "Novo", "engine": "fake", "project_ids": [project["id"]]},
                             headers=h)).json()["def"]
        assert made["grants"] == default
        await c.put(f"/agents/defs/{made['id']}/grants", json={"grants": {"memory": "read"}}, headers=h)
        listed = (await c.get("/agents/defs", headers=h)).json()["defs"]
        assert [d["grants"]["memory"] for d in listed if d["id"] == made["id"]] == ["read"]
        assert (await c.get(f"/agents/defs/{made['id']}", headers=h)).json()["def"]["grants"]["memory"] == "read"
        patched = (await c.patch(f"/agents/defs/{made['id']}", json={"role": "x"}, headers=h)).json()["def"]
        assert patched["grants"] == {**DEFAULTS, "memory": "read"}
        # deleting the agent removes its grants
        assert (await c.delete(f"/agents/defs/{made['id']}", headers=h)).status_code == 200
    left = await svc._db(lambda conn: conn.execute("SELECT COUNT(*) FROM agent_grants").fetchone()[0])
    assert left == 0


async def test_the_tools_route_lists_the_groups_without_the_system_group(app, svc):
    async with api(app) as c:
        r = await c.get("/agents/tools", headers={TOKEN_HEADER: svc.token})
    groups = r.json()["groups"]
    assert [g["id"] for g in groups] == ["notes", "wiki", "memory", "project_tasks", "reminders"]
    assert [(g["default"], g["sensitive"]) for g in groups] == [
        ("read", False), ("read", False), ("none", True), ("read", False), ("none", False)]
    for g in groups:
        assert set(g) == {"id", "label", "description", "default", "sensitive", "levels", "tools"}
        assert g["label"] and g["description"]
        for t in g["tools"]:
            assert set(t) == {"name", "label", "description", "read_only", "level"}
            assert t["read_only"] is (t["level"] == "read")
    assert [t["name"] for t in groups[0]["tools"]] == ["search_notes", "list_notes", "create_note", "update_note"]
    assert [t["name"] for t in groups[1]["tools"]] == ["wiki_search", "wiki_list_pages", "wiki_read_page"]
    assert [t["name"] for t in groups[2]["tools"]] == ["memory_search"]
    assert "ping" not in json.dumps(groups) and "ask_owner" not in json.dumps(groups)


# -- settings and migration ---------------------------------------------------------------------------------


def test_the_four_new_settings_and_their_defaults():
    s = Settings(_env_file=None)
    assert s.agents_bridge_base_url == "http://127.0.0.1:8000"
    assert (s.agents_bridge_call_timeout_s, s.agents_bridge_hello_timeout_s,
            s.agents_bridge_result_max_chars) == (30, 10, 50000)


@pytest.mark.parametrize("url", ["http://example.com:8000", "http://192.168.0.5:8000", "http://0.0.0.0:8000", ""])
def test_the_bridge_address_must_be_loopback(url: str):
    with pytest.raises(ValueError):
        Settings(_env_file=None, agents_bridge_base_url=url)


@pytest.mark.parametrize("url", ["http://127.0.0.1:9000", "http://localhost:8765/", "http://[::1]:8000"])
def test_loopback_bridge_addresses_are_accepted(url: str):
    assert Settings(_env_file=None, agents_bridge_base_url=url).agents_bridge_base_url == url.rstrip("/")


async def test_a_service_with_a_non_loopback_bridge_address_offers_no_tools(store, project_dir):
    from seraphine.agents.engines.fake import FakeEngine
    from .conftest import make_settings
    engine = FakeEngine(bridge=True)
    s = AgentHarnessService(store, make_settings(agents_bridge_base_url="http://10.1.2.3:8000"),
                            engines={"fake": engine})
    assert await s.gateway.offers_tools("qualquer", engine) is False


def test_the_migration_is_idempotent_and_adds_the_new_tables_to_an_older_database():
    conn = sqlite3.connect(":memory:")
    agents_schema.migrate(conn)
    conn.execute("DROP TABLE agent_grants")  # a database from before phase 3b
    conn.execute("DROP TABLE agent_bridge_tokens")
    conn.execute("INSERT INTO agent_defs (id, name, engine, created_at, updated_at) VALUES ('a', 'A', 'fake', 'n', 'n')")
    for _ in range(2):
        agents_schema.migrate(conn)
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert {"agent_grants", "agent_bridge_tokens"} <= tables
    assert conn.execute("SELECT id FROM agent_defs").fetchall() == [("a",)]
    conn.execute("INSERT INTO agent_grants (agent_id, group_id, level) VALUES ('a', 'memory', 'read')")
    agents_schema.migrate(conn)
    assert conn.execute("SELECT level FROM agent_grants").fetchall() == [("read",)]  # data survives a re-run
    cols = {r[1] for r in conn.execute("PRAGMA table_info(agent_bridge_tokens)")}
    assert cols == {"token_hash", "run_id", "agent_id", "created_at"}  # a hash, never the token
