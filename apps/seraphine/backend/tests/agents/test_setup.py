"""Phase 6a: first steps (``GET/PUT /agents/setup``), provider ``how``, new agent fields and limits."""

from __future__ import annotations

import json
import sqlite3

import pytest

from seraphine.agents import schema
from seraphine.agents.errors import Invalid

from .conftest import make_api, setup_agent


async def test_setup_defaults(hsvc, tmp_path):
    async with make_api(hsvc) as c:
        r = await c.get("/agents/setup")
    assert r.status_code == 200
    s = r.json()["setup"]
    assert s["areas"] is None and s["areas_skipped"] is False and s["dismissed"] is False
    assert s["default_engine"] is None
    assert s["home_dir"] == str(tmp_path / "casas")
    assert [st["id"] for st in s["steps"]] == ["areas", "engine", "agents", "first_reply"]
    assert s["total"] == 4
    steps = {st["id"]: st["done"] for st in s["steps"]}
    assert steps == {"areas": False, "engine": True, "agents": False, "first_reply": False}
    assert s["done"] == 1


async def test_setup_put_and_validation(hsvc):
    async with make_api(hsvc) as c:
        r = await c.put("/agents/setup", json={"areas": ["estudos", "casa"], "dismissed": True})
        assert r.status_code == 200
        s = r.json()["setup"]
        assert s["areas"] == ["estudos", "casa"] and s["dismissed"] is True
        # partial: the rest stays
        s = (await c.put("/agents/setup", json={"areas_skipped": True})).json()["setup"]
        assert s["areas"] == ["estudos", "casa"] and s["areas_skipped"] is True
        s = (await c.put("/agents/setup", json={"default_engine": {"engine": "claude_code"}})).json()["setup"]
        assert s["default_engine"] == {"engine": "claude_code", "provider": "anthropic", "model": None}
        s = (await c.put("/agents/setup", json={"default_engine": None, "areas": None})).json()["setup"]
        assert s["default_engine"] is None and s["areas"] is None
        # 422s
        for body in ({"nope": 1}, {"areas": ["xx"]}, {"areas": ["casa", "casa"]},
                     {"areas": ["dia_a_dia", "estudos", "trabalho", "programacao", "pesquisa_escrita",
                                "casa", "outra", "casa"]},
                     {"areas_skipped": "sim"}, {"dismissed": None},
                     {"default_engine": {"engine": "desconhecido"}},
                     {"default_engine": {"engine": "claude_code", "provider": "openai"}},
                     {"default_engine": {"engine": "claude_code", "extra": 1}}):
            assert (await c.put("/agents/setup", json=body)).status_code == 422, body
    # stored under the key-value store
    assert json.loads(await hsvc.store.get_kv("agents.setup"))["dismissed"] is True


async def test_setup_steps_follow_the_data(hsvc, project_dir):
    async def steps():
        return {st["id"]: st["done"] for st in (await hsvc.get_setup())["steps"]}

    assert (await steps())["areas"] is False
    await hsvc.update_setup(areas_skipped=True)
    assert (await steps())["areas"] is True
    await hsvc.update_setup(areas_skipped=False, areas=["casa"])
    assert (await steps())["areas"] is True

    # engine: the Claude Code login goes away -> not done; the fake runtime has no catalog provider
    hsvc.cli_state["cli_ok"] = False
    hsvc.providers._cache.clear()
    assert (await steps())["engine"] is False
    hsvc.cli_state["cli_ok"] = True
    hsvc.providers._cache.clear()
    assert (await steps())["engine"] is True

    assert (await steps())["agents"] is False
    agent, project = await setup_agent(hsvc, project_dir)
    assert (await steps())["agents"] is True

    assert (await steps())["first_reply"] is False
    out = await hsvc.post_message(project["id"], "oi", agent_id=agent["id"])
    from .conftest import wait_run
    await wait_run(hsvc, out["run"]["id"], ("done",))
    s = await hsvc.get_setup()
    assert {st["id"]: st["done"] for st in s["steps"]}["first_reply"] is True
    assert s["done"] == 4  # areas, engine, agents, first_reply


async def test_providers_have_how(hsvc):
    async with make_api(hsvc) as c:
        items = (await c.get("/agents/providers")).json()["providers"]
    by = {p["id"]: p for p in items}
    assert all("how" in p for p in items)
    assert by["anthropic"]["configured"] is True and by["anthropic"]["how"] == ""
    assert "OPENROUTER_API_KEY" in by["openrouter"]["how"] and "reinicie" in by["openrouter"]["how"]
    # local server down (mock transport answers 500)
    assert by["ollama"]["configured"] is False and "Ollama" in by["ollama"]["how"]
    for p in items:
        assert "`" not in p["how"] and "sk-" not in p["how"]
    hsvc.cli_state["cli_ok"] = False
    hsvc.providers._cache.clear()
    async with make_api(hsvc) as c:
        by = {p["id"]: p for p in (await c.get("/agents/providers")).json()["providers"]}
    assert "Claude Code" in by["anthropic"]["how"] and "entre" in by["anthropic"]["how"]
    assert "`" not in by["anthropic"]["how"]


# -- new agent fields and limits -------------------------------------------------------------------------


async def test_new_agent_fields_defaults_and_edit(hsvc):
    a = await hsvc.create_def(name="Zé", engine="fake")
    assert a["description"] == "" and a["suggestions"] == [] and a["origin"] == "manual"
    assert a["home_project_id"] is None
    async with make_api(hsvc) as c:
        r = await c.post("/agents/defs", json={"name": "Ana", "engine": "fake", "description": "Faz coisas",
                                               "suggestions": ["a", "b", " "]})
        assert r.status_code == 200
        d = r.json()["def"]
        assert d["description"] == "Faz coisas" and d["suggestions"] == ["a", "b"] and d["origin"] == "manual"
        r = await c.patch(f"/agents/defs/{d['id']}", json={"description": "Novo", "suggestions": ["x"]})
        assert r.json()["def"]["description"] == "Novo" and r.json()["def"]["suggestions"] == ["x"]
        # origin and home_project_id are not editable
        assert (await c.patch(f"/agents/defs/{d['id']}", json={"origin": "guide"})).status_code == 422
        assert (await c.patch(f"/agents/defs/{d['id']}", json={"home_project_id": "x"})).status_code == 422
        listed = (await c.get("/agents/defs")).json()["defs"]
        assert all({"description", "suggestions", "home_project_id", "origin"} <= set(x) for x in listed)


async def test_limits_422_on_create_and_patch(hsvc):
    base = dict(engine="fake")
    bad = [dict(name="x" * 81), dict(name="  "), dict(name="A", role="r" * 201),
           dict(name="A", description="d" * 301), dict(name="A", instructions="i" * 20_001),
           dict(name="A", color="vermelho"), dict(name="A", color="#fff"),
           dict(name="A", suggestions=["a", "b", "c", "d"]), dict(name="A", suggestions=["s" * 121])]
    for fields in bad:
        with pytest.raises(Invalid):
            await hsvc.create_def(**base, **fields)
    ok = await hsvc.create_def(**base, name="x" * 80, role="r" * 200, description="d" * 300,
                               instructions="i" * 20_000, color="#AABBCC", suggestions=["s" * 120] * 3)
    assert len(ok["name"]) == 80
    async with make_api(hsvc) as c:
        for body in ({"description": "d" * 301}, {"color": "azul"}, {"role": "r" * 201}, {"name": "n" * 81}):
            r = await c.patch(f"/agents/defs/{ok['id']}", json=body)
            assert r.status_code == 422 and r.json()["code"] == "invalid"


async def test_old_rows_read_with_defaults(tmp_path):
    db = tmp_path / "old.sqlite"
    conn = sqlite3.connect(db)
    conn.executescript(
        "CREATE TABLE agent_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,"
        " description TEXT NOT NULL DEFAULT '', archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);"
        "CREATE TABLE agent_defs (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT '',"
        " instructions TEXT NOT NULL DEFAULT '', engine TEXT NOT NULL, model TEXT, fallback_engine TEXT,"
        " color TEXT NOT NULL DEFAULT '#7c8cff', perm_edit TEXT NOT NULL DEFAULT 'free',"
        " perm_commands TEXT NOT NULL DEFAULT 'ask', daily_budget_usd REAL, enabled INTEGER NOT NULL DEFAULT 1,"
        " created_at TEXT NOT NULL, updated_at TEXT NOT NULL);"
        "INSERT INTO agent_projects (id, name, path, created_at) VALUES ('p', 'P', 'C:/x', 't');"
        "INSERT INTO agent_defs (id, name, engine, created_at, updated_at) VALUES ('a', 'A', 'fake', 't', 't');")
    conn.commit()
    schema.migrate(conn)
    conn.row_factory = sqlite3.Row
    p = dict(conn.execute("SELECT * FROM agent_projects").fetchone())
    a = dict(conn.execute("SELECT * FROM agent_defs").fetchone())
    conn.close()
    assert p["kind"] == "project" and p["agent_id"] is None
    assert a["description"] == "" and a["suggestions"] == "[]" and a["origin"] == "manual"
    from seraphine.agents.service import _def_dict, _project_dict
    assert _project_dict(p)["kind"] == "project"
    d = _def_dict(a, [], {})
    assert d["suggestions"] == [] and d["origin"] == "manual" and d["home_project_id"] is None
