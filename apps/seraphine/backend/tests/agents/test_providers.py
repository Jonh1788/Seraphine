"""Provider catalog, runtime x provider validation, migration, chat runtime, key hygiene."""

from __future__ import annotations

import asyncio
import json
import sqlite3
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from seraphine.agents import providers as providers_mod
from seraphine.agents import schema
from seraphine.agents.engines import get_engines
from seraphine.agents.engines.base import EngineContext, SANDBOX_READ_ONLY
from seraphine.agents.engines.chat import ChatEngine
from seraphine.agents.engines.claude_code import ClaudeCodeEngine
from seraphine.agents.engines.codex import CodexEngine
from seraphine.agents.engines.fake import FakeEngine
from seraphine.agents.errors import Invalid
from seraphine.agents.providers import ProviderRegistry, build_catalog, child_env, read_env
from seraphine.agents.routes import TOKEN_HEADER, router
from seraphine.agents.service import AgentHarnessService
from seraphine.agents.transcripts import SqliteTranscripts

from .conftest import ORIGIN, make_settings, setup_agent, wait_run

SECRET = "sk-test-SECRET-0123456789"
API_KEY_ENVS = ["OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "MOONSHOT_API_KEY", "XAI_API_KEY",
                "GEMINI_API_KEY", "GROQ_API_KEY"]


@pytest.fixture(autouse=True)
def _clean_keys(monkeypatch, tmp_path):
    for name in API_KEY_ENVS + ["MEU_API_KEY"]:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.chdir(tmp_path)  # no stray .env


async def _noop(kind, payload):
    pass


# -- catalog --------------------------------------------------------------------


def test_catalog_builtins():
    cat = build_catalog(make_settings())
    assert {"openai", "anthropic", "ollama", "lmstudio", "openrouter", "deepseek", "moonshot",
            "xai", "gemini", "groq"} <= set(cat)
    assert "zai" not in cat  # docs define no key variable: left to agents_extra_providers
    assert cat["openai"].kind == "plan" and cat["openai"].runtimes == ("codex",)
    assert cat["anthropic"].kind == "plan" and cat["anthropic"].runtimes == ("claude_code",)
    assert set(cat["ollama"].runtimes) == {"chat", "codex"} and cat["ollama"].kind == "local"
    assert set(cat["lmstudio"].runtimes) == {"chat", "codex"}
    assert cat["openrouter"].env_key == "OPENROUTER_API_KEY" and cat["openrouter"].runtimes == ("chat",)
    # every API-key provider is chat-only (Codex custom providers need the Responses API)
    for p in cat.values():
        if p.kind == "api_key":
            assert p.runtimes == ("chat",) and p.base_url and p.env_key
    assert cat["ollama"].base_url == "http://localhost:11434/v1"


def test_extra_providers_setting():
    extra = json.dumps([
        {"id": "meu", "label": "Meu", "kind": "api_key", "base_url": "https://x.test/v1/",
         "env_key": "MEU_API_KEY", "default_model": "m1"},
        {"id": "openai", "base_url": "https://dup.test", "env_key": "A"},          # collides with a built-in
        {"id": "sem-chave", "kind": "api_key", "base_url": "https://y.test"},       # api_key needs env_key
        {"id": "chave-literal", "kind": "api_key", "base_url": "https://z.test",
         "env_key": "sk-abc def"},                                                   # not a variable NAME
        {"id": "ftp", "kind": "api_key", "base_url": "ftp://z", "env_key": "K"},
        "lixo",
    ])
    cat = build_catalog(make_settings(agents_extra_providers=extra))
    assert cat["meu"].base_url == "https://x.test/v1" and cat["meu"].runtimes == ("chat",)
    assert cat["openai"].kind == "plan"
    assert not ({"sem-chave", "chave-literal", "ftp"} & set(cat))
    assert build_catalog(make_settings(agents_extra_providers="{not json")).keys() == build_catalog(make_settings()).keys()


# -- configured -----------------------------------------------------------------


async def test_api_key_configured_follows_env(monkeypatch):
    reg = ProviderRegistry(make_settings())
    ok, reason = await reg.status("openrouter")
    assert not ok and reason == "falta a chave OPENROUTER_API_KEY no .env do backend"
    monkeypatch.setenv("OPENROUTER_API_KEY", SECRET)
    assert await reg.status("openrouter") == (True, "")


def test_read_env_falls_back_to_dotenv(tmp_path: Path, monkeypatch):
    (tmp_path / ".env").write_text("GROQ_API_KEY=from-dotenv-123456\n", encoding="utf-8")
    assert read_env("GROQ_API_KEY") == "from-dotenv-123456"
    monkeypatch.setenv("GROQ_API_KEY", "from-process-env")
    assert read_env("GROQ_API_KEY") == "from-process-env"  # process env wins
    assert read_env("NOPE_NOT_SET") == "" and read_env(None) == ""


async def test_local_probe_is_cached_30s():
    now = [1000.0]
    hits: list[str] = []
    up = [True]

    def handler(request: httpx.Request) -> httpx.Response:
        hits.append(str(request.url))
        return httpx.Response(200 if up[0] else 503, json={})

    reg = ProviderRegistry(make_settings(), transport=httpx.MockTransport(handler), clock=lambda: now[0])
    assert await reg.status("ollama") == (True, "")
    assert hits == ["http://localhost:11434/api/tags"]
    up[0] = False
    assert (await reg.status("ollama"))[0] is True and len(hits) == 1  # cached
    now[0] += 31
    ok, reason = await reg.status("ollama")
    assert not ok and "503" in reason and len(hits) == 2
    assert (await reg.status("lmstudio"))[0] is False
    assert hits[-1] == "http://localhost:1234/v1/models"


async def test_local_probe_unreachable():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    reg = ProviderRegistry(make_settings(), transport=httpx.MockTransport(handler))
    ok, reason = await reg.status("ollama")
    assert not ok and "não está respondendo" in reason


async def test_plan_providers_use_cheap_cli_probe_not_a_model_call():
    calls: list[str] = []

    async def probe(which: str):
        calls.append(which)
        return (False, "Claude Code não está conectado") if which == "claude" else (True, "")

    reg = ProviderRegistry(make_settings(), cli_probe=probe)
    assert await reg.status("openai") == (True, "")
    assert await reg.status("anthropic") == (False, "Claude Code não está conectado")
    assert calls == ["codex", "claude"]

    async def unknown(which: str):
        return None, ""  # could not tell: never block on a guess

    assert (await ProviderRegistry(make_settings(), cli_probe=unknown).status("anthropic"))[0] is True


async def test_info_has_no_secrets_or_urls(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", SECRET)

    async def probe(which: str):
        return True, ""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={})

    reg = ProviderRegistry(make_settings(), transport=httpx.MockTransport(handler), cli_probe=probe)
    info = await reg.info()
    text = json.dumps(info)
    assert SECRET not in text and "http" not in text and "OPENROUTER_API_KEY" not in text.replace(
        "falta a chave", "")  # configured -> no env-var hint either
    assert set(info[0]) == {"id", "label", "kind", "runtimes", "configured", "reason", "default_model", "notes",
                           "how"}
    by = {p["id"]: p for p in info}
    assert by["openrouter"]["configured"] is True and by["deepseek"]["configured"] is False


# -- validation through the service ----------------------------------------------


async def test_runtime_provider_validation(svc: AgentHarnessService, project_dir: Path):
    svc.engines.update({"codex": FakeEngine("codex"), "claude_code": FakeEngine("claude_code"),
                        "chat": FakeEngine("chat")})
    base = dict(name="A", instructions="x")
    with pytest.raises(Invalid) as e1:
        await svc.create_def(engine="codex", provider="openrouter", **base)
    assert "OpenRouter" in str(e1.value) and "Só conversa" in str(e1.value)
    with pytest.raises(Invalid):
        await svc.create_def(engine="claude_code", provider="openai", **base)
    with pytest.raises(Invalid):
        await svc.create_def(engine="chat", provider="anthropic", **base)
    with pytest.raises(Invalid) as e2:
        await svc.create_def(engine="chat", provider="inexistente", **base)
    assert "desconhecido" in str(e2.value)
    with pytest.raises(Invalid):
        await svc.create_def(engine="chat", provider="openrouter", reasoning_effort="max", **base)
    with pytest.raises(Invalid) as e3:
        await svc.create_def(engine="codex", fallback_engine="chat", fallback_provider="openai", **base)
    assert e3.value.status == 422 and str(e3.value).startswith("reserva:")
    ok = await svc.create_def(engine="chat", provider="openrouter", model="x/y", reasoning_effort="low",
                              fallback_engine="codex", fallback_model="gpt-z", **base)
    assert (ok["engine"], ok["provider"], ok["model"], ok["reasoning_effort"]) == ("chat", "openrouter", "x/y", "low")
    assert (ok["fallback_engine"], ok["fallback_provider"], ok["fallback_model"]) == ("codex", "openai", "gpt-z")


async def test_defaults_and_legacy_alias(svc: AgentHarnessService):
    svc.engines.update({"codex": FakeEngine("codex"), "claude_code": FakeEngine("claude_code"),
                        "chat": FakeEngine("chat")})
    base = dict(name="A", instructions="x")
    assert (await svc.create_def(engine="codex", **base))["provider"] == "openai"
    assert (await svc.create_def(engine="claude_code", **base))["provider"] == "anthropic"
    legacy = await svc.create_def(engine="ollama", **base)  # legacy alias accepted by the API
    assert (legacy["engine"], legacy["provider"]) == ("chat", "ollama")
    # changing only the runtime keeps a still-valid provider and resets an invalid one
    chat_or = await svc.create_def(engine="chat", provider="openrouter", **base)
    assert (await svc.update_def(chat_or["id"], engine="codex"))["provider"] == "openai"
    kept = await svc.update_def(legacy["id"], engine="codex", provider="lmstudio", model="m")
    assert (kept["engine"], kept["provider"]) == ("codex", "lmstudio")
    again = await svc.update_def(kept["id"], model="outro")
    assert again["provider"] == "lmstudio"
    cleared = await svc.update_def(kept["id"], fallback_engine=None)
    assert cleared["fallback_provider"] is None and cleared["fallback_model"] is None


# -- migration --------------------------------------------------------------------

OLD_DEFS = """CREATE TABLE agent_defs (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '', engine TEXT NOT NULL, model TEXT, fallback_engine TEXT,
  color TEXT NOT NULL DEFAULT '#7c8cff', perm_edit TEXT NOT NULL DEFAULT 'free',
  perm_commands TEXT NOT NULL DEFAULT 'ask', daily_budget_usd REAL, enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"""
OLD_RUNS = """CREATE TABLE agent_runs (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, project_id TEXT NOT NULL,
  task_id TEXT, goal TEXT NOT NULL, status TEXT NOT NULL, engine TEXT NOT NULL, model TEXT, session_ref TEXT,
  requested_by TEXT NOT NULL DEFAULT 'user', result_summary TEXT, error TEXT, exit_code INTEGER,
  tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
  approvals_used INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT)"""


def test_migration_from_old_columns_is_idempotent():
    conn = sqlite3.connect(":memory:")
    conn.execute(OLD_DEFS)
    conn.execute(OLD_RUNS)
    for i, (eng, fb) in enumerate([("codex", None), ("claude_code", "ollama"), ("ollama", "codex")]):
        conn.execute("INSERT INTO agent_defs (id, name, engine, model, fallback_engine, created_at, updated_at)"
                     " VALUES (?, 'n', ?, 'mm', ?, 't', 't')", (f"a{i}", eng, fb))
        conn.execute("INSERT INTO agent_runs (id, agent_id, project_id, goal, status, engine, created_at)"
                     " VALUES (?, 'a', 'p', 'g', 'done', ?, 't')", (f"r{i}", eng))
    schema.migrate(conn)
    schema.migrate(conn)
    rows = {r[0]: r[1:] for r in conn.execute(
        "SELECT id, engine, provider, fallback_provider, model, reasoning_effort, fallback_model FROM agent_defs")}
    assert rows["a0"] == ("codex", "openai", None, "mm", None, None)
    assert rows["a1"] == ("claude_code", "anthropic", "ollama", "mm", None, None)
    assert rows["a2"] == ("ollama", "ollama", "openai", "mm", None, None)  # stored row untouched
    runs = {r[0]: r[1:] for r in conn.execute("SELECT id, engine, provider, reasoning_effort FROM agent_runs")}
    assert runs["r0"] == ("codex", "openai", None) and runs["r2"] == ("ollama", "ollama", None)
    names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert "agent_chat_transcripts" in names
    # an explicit provider is never overwritten by a later migrate
    conn.execute("UPDATE agent_defs SET provider = 'lmstudio' WHERE id = 'a2'")
    schema.migrate(conn)
    assert conn.execute("SELECT provider FROM agent_defs WHERE id = 'a2'").fetchone()[0] == "lmstudio"


async def test_service_reads_legacy_ollama_rows(store, svc: AgentHarnessService, project_dir: Path):
    agent, _ = await setup_agent(svc, project_dir)
    await svc._db(lambda c: c.execute(
        "UPDATE agent_defs SET engine = 'ollama', provider = NULL WHERE id = ?", (agent["id"],)))
    got = await svc.get_def(agent["id"])
    assert (got["engine"], got["provider"]) == ("chat", "ollama")


# -- chat runtime ------------------------------------------------------------------


def _sse(chunks: list[str], usage: dict | None = None) -> bytes:
    lines = [f"data: {json.dumps({'choices': [{'delta': {'content': c}}]})}\n\n" for c in chunks]
    if usage:
        lines.append(f"data: {json.dumps({'choices': [], 'usage': usage})}\n\n")
    lines.append("data: [DONE]\n\n")
    return "".join(lines).encode()


def _patch_http(monkeypatch, handler):
    real = httpx.AsyncClient

    def factory(**kw):
        kw["transport"] = httpx.MockTransport(handler)
        return real(**kw)

    monkeypatch.setattr(httpx, "AsyncClient", factory)


async def test_chat_streams_persists_transcript_and_resumes_after_restart(monkeypatch, store, tmp_path: Path):
    monkeypatch.setenv("OPENROUTER_API_KEY", SECRET)
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        n = len(seen)
        return httpx.Response(200, content=_sse(["Olá", " mundo"] if n == 1 else ["tudo bem"],
                                                {"prompt_tokens": 11, "completion_tokens": 3}),
                              headers={"content-type": "text/event-stream"})

    _patch_http(monkeypatch, handler)
    reg = ProviderRegistry(make_settings())
    ctx = EngineContext(tmp_path, "oi", SANDBOX_READ_ONLY, "x/model", reg.get("openrouter"))
    eng = ChatEngine(SqliteTranscripts(store))
    events: list[tuple[str, dict]] = []

    async def on_event(kind, payload):
        events.append((kind, payload))

    res = await eng.run(ctx, on_event, asyncio.Event())
    assert res.final_message == "Olá mundo" and (res.tokens_in, res.tokens_out) == (11, 3) and res.error is None
    req = seen[0]
    assert str(req.url) == "https://openrouter.ai/api/v1/chat/completions"
    assert req.headers["authorization"] == f"Bearer {SECRET}"
    body = json.loads(req.content)
    assert body["model"] == "x/model" and body["stream"] is True and SECRET not in req.content.decode()
    assert eng.can_act is False and events[0][0] == "_session" and events[0][1]["session_ref"]
    assert events[1:] == [("message", {"text": "Olá mundo"})]

    # a NEW engine (backend restart) resumes from the database
    eng2 = ChatEngine(SqliteTranscripts(store))
    res2 = await eng2.resume(ctx, res.session_ref, "e agora?", on_event, asyncio.Event())
    assert res2.final_message == "tudo bem"
    assert [m["role"] for m in json.loads(seen[1].content)["messages"]] == ["user", "assistant", "user"]
    stored = await SqliteTranscripts(store).load(res.session_ref)
    assert [m["role"] for m in stored] == ["user", "assistant", "user", "assistant"]
    assert (await eng2.resume(ctx, "nao-existe", "x", on_event, asyncio.Event())).error
    assert SECRET not in json.dumps(stored) and SECRET not in json.dumps(events)


async def test_chat_errors_never_leak_the_key(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("OPENROUTER_API_KEY", SECRET)
    reg = ProviderRegistry(make_settings())
    ctx = EngineContext(tmp_path, "oi", SANDBOX_READ_ONLY, "m", reg.get("openrouter"))
    eng = ChatEngine()

    _patch_http(monkeypatch, lambda r: httpx.Response(401, text=f"bad key {SECRET}"))
    res = await eng.run(ctx, _noop, asyncio.Event())
    assert res.error_code == "engine_auth" and SECRET not in (res.error or "") and "401" in res.error

    _patch_http(monkeypatch, lambda r: httpx.Response(500, text=f"boom {SECRET} boom"))
    res = await eng.run(ctx, _noop, asyncio.Event())
    assert res.error and SECRET not in res.error

    def boom(request):
        raise httpx.ConnectError(f"cannot reach with {SECRET}")

    _patch_http(monkeypatch, boom)
    res = await eng.run(ctx, _noop, asyncio.Event())
    assert res.error and SECRET not in res.error

    monkeypatch.delenv("OPENROUTER_API_KEY")
    res = await eng.run(ctx, _noop, asyncio.Event())
    assert res.error_code == "provider_unavailable" and "OPENROUTER_API_KEY" in res.error
    nomodel = await eng.run(EngineContext(tmp_path, "oi", SANDBOX_READ_ONLY, None, reg.get("openrouter")),
                            _noop, asyncio.Event())
    assert nomodel.error and "modelo" in nomodel.error


async def test_chat_local_provider_sends_no_auth_and_retries_without_usage(monkeypatch, tmp_path: Path):
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if "stream_options" in json.loads(request.content):
            return httpx.Response(400, text="unknown field stream_options")
        return httpx.Response(200, content=_sse(["ok"]))

    _patch_http(monkeypatch, handler)
    reg = ProviderRegistry(make_settings())
    res = await ChatEngine().run(EngineContext(tmp_path, "oi", SANDBOX_READ_ONLY, "llama3", reg.get("ollama")),
                                 _noop, asyncio.Event())
    assert res.final_message == "ok" and len(seen) == 2
    assert str(seen[1].url) == "http://localhost:11434/v1/chat/completions"
    assert "authorization" not in seen[1].headers


# -- keys never in argv / events / API / DB ----------------------------------------


def test_keys_not_in_argv_and_stripped_from_child_env(monkeypatch, tmp_path: Path):
    for name in API_KEY_ENVS:
        monkeypatch.setenv(name, SECRET)
    monkeypatch.setenv("HARMLESS_VAR", "keep")
    reg = ProviderRegistry(make_settings())
    for provider in ("openai", "ollama", "openrouter"):
        ctx = EngineContext(tmp_path, "p", SANDBOX_READ_ONLY, "m", reg.get(provider), "low")
        for args in (CodexEngine().build_run_args("codex", ctx), CodexEngine().build_resume_args("codex", ctx, "s"),
                     ClaudeCodeEngine().build_args("claude", ctx, "s")):
            assert not any(SECRET in a for a in args)
    env = child_env(reg.catalog)
    assert not any(SECRET == v for v in env.values()) and env["HARMLESS_VAR"] == "keep"
    for name in ("codex", "claude_code"):
        assert SECRET not in "".join(get_engines(make_settings())[name].env_factory().values())


async def _http_app(svc: AgentHarnessService) -> FastAPI:
    app = FastAPI()
    app.include_router(router)
    app.state.agent_harness = svc
    return app


def _client(app: FastAPI) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=("127.0.0.1", 50000)),
                             base_url="http://127.0.0.1:8000")


async def test_providers_route_and_422_and_no_secret(monkeypatch, store, project_dir: Path):
    monkeypatch.setenv("OPENROUTER_API_KEY", SECRET)

    async def probe(which: str):
        return True, ""

    reg = ProviderRegistry(make_settings(), cli_probe=probe,
                           transport=httpx.MockTransport(lambda r: httpx.Response(200, json={})))
    svc = AgentHarnessService(store, make_settings(), engines={
        "codex": FakeEngine("codex"), "chat": ChatEngine(SqliteTranscripts(store))}, providers=reg)
    await svc.start()
    try:
        app = await _http_app(svc)
        h = {TOKEN_HEADER: svc.token or "", "Origin": ORIGIN}
        async with _client(app) as c:
            r = await c.get("/agents/providers", headers=h)
            assert r.status_code == 200
            assert SECRET not in r.text and "http://" not in r.text and "https://" not in r.text
            by = {p["id"]: p for p in r.json()["providers"]}
            assert by["openrouter"]["configured"] and by["deepseek"]["reason"].startswith("falta a chave DEEPSEEK_API_KEY")
            eng = (await c.get("/agents/engines", headers=h)).json()["engines"]
            assert {e["name"]: e["can_act"] for e in eng} == {"codex": True, "chat": False}
            bad = await c.post("/agents/defs", headers=h, json={
                "name": "X", "instructions": "y", "engine": "codex", "provider": "openrouter"})
            assert bad.status_code == 422 and "OpenRouter" in bad.json()["detail"]
            good = await c.post("/agents/defs", headers=h, json={
                "name": "X", "instructions": "y", "engine": "chat", "provider": "openrouter",
                "model": "m", "reasoning_effort": "high"})
            assert good.status_code == 200
            d = good.json()["def"]
            assert (d["provider"], d["reasoning_effort"], d["fallback_provider"]) == ("openrouter", "high", None)
            patched = await c.patch(f"/agents/defs/{d['id']}", headers=h, json={"provider": "codex-nope"})
            assert patched.status_code == 422
    finally:
        await svc.stop()


async def test_chat_run_end_to_end_with_fallback_and_no_key_anywhere(monkeypatch, store, project_dir: Path):
    monkeypatch.setenv("OPENROUTER_API_KEY", SECRET)
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, content=_sse(["feito"], {"prompt_tokens": 5, "completion_tokens": 1}))

    _patch_http(monkeypatch, handler)
    fake = FakeEngine()
    svc = AgentHarnessService(store, make_settings(), engines={"chat": ChatEngine(SqliteTranscripts(store)),
                                                               "fake": fake})
    await svc.start()
    try:
        agent, project = await setup_agent(svc, project_dir, engine="chat", provider="openrouter", model="m/x")
        run = await svc.start_run(agent["id"], project["id"], "diga oi")
        assert (run["engine"], run["provider"], run["model"]) == ("chat", "openrouter", "m/x")
        done = await wait_run(svc, run["id"], ("done", "failed"))
        assert done["status"] == "done" and (done["tokens_in"], done["tokens_out"]) == (5, 1)
        assert seen[0].headers["authorization"] == f"Bearer {SECRET}"
        events = await svc.list_events(run["id"])
        # chat is conversation only: the harness told the model so
        sent = json.loads(seen[0].content)["messages"][0]["content"]
        assert "só conversa" in sent.lower()

        # primary provider has no key -> clear failure; with a fallback it switches
        monkeypatch.delenv("OPENROUTER_API_KEY")
        # (a missing key is a login-type reason: the run is created parked, not refused)
        blocked = await svc.start_run(agent["id"], project["id"], "de novo")
        assert blocked["status"] == "parked" and blocked["wait_kind"] == "auth"
        assert "OPENROUTER_API_KEY" in blocked["wait_detail"]
        await svc.cancel_run(blocked["id"])  # a parked run keeps its agent busy
        await svc.update_def(agent["id"], fallback_engine="fake", fallback_model="fb-model")
        run2 = await svc.start_run(agent["id"], project["id"], "de novo")
        assert (run2["engine"], run2["model"]) == ("fake", "fb-model")
        await wait_run(svc, run2["id"], ("done", "failed"))

        # the key is nowhere: not in events, runs, messages, nor any table
        monkeypatch.setenv("OPENROUTER_API_KEY", SECRET)
        dump = json.dumps(events, default=str)
        for table in [r[0] for r in await svc._db(lambda c: c.execute(
                "SELECT name FROM sqlite_master WHERE type='table'").fetchall())]:
            rows = await svc._db(lambda c, t=table: c.execute(f"SELECT * FROM {t}").fetchall())
            dump += json.dumps([list(map(str, r)) for r in rows])
        assert SECRET not in dump
    finally:
        await svc.stop()


async def test_run_auth_error_code_is_stored(monkeypatch, store, project_dir: Path):
    """engine_auth parks the run (phase 1b) and the channel says what to do; the code
    reaches the row when the wait expires (see test_parking.py)."""
    class AuthFail(FakeEngine):
        async def run(self, ctx, on_event, cancel):
            from seraphine.agents.engines.base import EngineResult
            return EngineResult(error="O Claude Code não está conectado. Rode `claude auth login` no terminal e tente de novo.",
                                error_code="engine_auth", exit_code=1)

    svc = AgentHarnessService(store, make_settings(), engines={"fake": AuthFail()})
    await svc.start()
    try:
        agent, project = await setup_agent(svc, project_dir)
        run = await svc.start_run(agent["id"], project["id"], "oi")
        parked = await wait_run(svc, run["id"], ("parked",))
        assert parked["wait_kind"] == "auth" and parked["wait_until"] is None and parked["error"] is None
        msgs = await svc.list_messages(project["id"])
        assert any("login" in m["body"] and "em espera" in m["body"] for m in msgs)
    finally:
        await svc.stop()


async def test_agents_list_tool_includes_runtime_provider_model(svc: AgentHarnessService, project_dir: Path):
    from seraphine.tools.agents import AgentsListTool

    svc.engines["chat"] = FakeEngine("chat")
    agent, _ = await setup_agent(svc, project_dir, engine="chat", provider="groq", model="llama-x",
                                 reasoning_effort="medium")
    res = await AgentsListTool(svc).execute({})
    item = next(a for a in res.metadata["agents"] if a["id"] == agent["id"])
    assert (item["runtime"], item["provider"], item["model"], item["can_act"]) == ("chat", "groq", "llama-x", False)
    assert item["reasoning_effort"] == "medium"
    assert providers_mod  # module import used for monkeypatching elsewhere
