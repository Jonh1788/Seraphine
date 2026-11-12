"""post_message routing + tools + HTTP CRUD smoke."""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from seraphine.agents.engines.fake import FakeEngine, FakeTurn
from seraphine.agents.routes import TOKEN_HEADER, router
from seraphine.tools.agents import (
    AgentsCreateTaskTool, AgentsDelegateTool, AgentsListTool, AgentsRunStatusTool,
)

from .conftest import ORIGIN, setup_agent, wait_run


async def _two_agents(svc, project_dir: Path):
    project = await svc.create_project(name="Site", path=str(project_dir))
    reviewer = await svc.create_def(
        name="Revisor", role="revisor de código", instructions="Revisa código e acha bugs",
        engine="fake", project_ids=[project["id"]])
    writer = await svc.create_def(
        name="Redatora", role="redatora de documentação", instructions="Escreve docs e artigos",
        engine="fake", project_ids=[project["id"]])
    return project, reviewer, writer


async def test_explicit_agent(svc, fake, project_dir):
    project, reviewer, writer = await _two_agents(svc, project_dir)
    out = await svc.post_message(project["id"], "faça algo", agent_id=writer["id"])
    assert out["error"] is None and out["agent_id"] == writer["id"]
    assert out["run"]["agent_id"] == writer["id"] and out["run"]["goal"] == "faça algo"
    assert out["message"]["author"] == "user"
    await wait_run(svc, out["run"]["id"], ("done",))


async def test_mention_routing(svc, fake, project_dir):
    project, reviewer, writer = await _two_agents(svc, project_dir)
    out = await svc.post_message(project["id"], "@redatora escreva o changelog", agent_id=None)
    assert out["agent_id"] == writer["id"]
    out = await svc.post_message(project["id"], "oi @Revisor olhe isso", agent_id="auto")
    assert out["agent_id"] == reviewer["id"]
    # an e-mail address is not a mention
    out = await svc.post_message(project["id"], "mande para dev@redatora.com a revisão de código")
    assert out["agent_id"] == reviewer["id"]
    # explicit id beats a mention
    out = await svc.post_message(project["id"], "@redatora x", agent_id=reviewer["id"])
    assert out["agent_id"] == reviewer["id"]


async def test_auto_heuristic_is_deterministic(svc, fake, project_dir):
    project, reviewer, writer = await _two_agents(svc, project_dir)
    assert await svc.pick_agent(project["id"], "revise esse código, tem um bug") == reviewer["id"]
    assert await svc.pick_agent(project["id"], "escreva a documentação do módulo") == writer["id"]
    # no signal at all: the first-created agent
    assert await svc.pick_agent(project["id"], "bom dia") == reviewer["id"]
    assert await svc.pick_agent(project["id"], "bom dia") == reviewer["id"]


async def test_single_candidate_and_disabled_agents_skipped(svc, fake, project_dir):
    project, reviewer, writer = await _two_agents(svc, project_dir)
    await svc.update_def(reviewer["id"], enabled=False)
    assert await svc.pick_agent(project["id"], "revise o código") == writer["id"]


async def test_router_hook(svc, fake, project_dir):
    project, reviewer, writer = await _two_agents(svc, project_dir)
    seen = {}

    async def router_hook(project_id, body, candidates):
        seen["n"] = len(candidates)
        return writer["id"]

    svc.router = router_hook
    assert await svc.pick_agent(project["id"], "revise o código, bug") == writer["id"]
    assert seen["n"] == 2

    async def bad(project_id, body, candidates):
        return "ghost"

    svc.router = bad
    assert await svc.pick_agent(project["id"], "revise o código, bug") == reviewer["id"]

    async def boom(project_id, body, candidates):
        raise RuntimeError("x")

    svc.router = boom
    assert await svc.pick_agent(project["id"], "revise o código, bug") == reviewer["id"]


async def test_no_agent_returns_error_payload_not_500(svc, project_dir):
    project = await svc.create_project(name="Vazio", path=str(project_dir))
    out = await svc.post_message(project["id"], "alguém aí?")
    assert out["error"] == "no_agent" and out["run"] is None and out["detail"]
    assert out["message"]["body"] == "alguém aí?"  # still stored
    assert len(await svc.list_messages(project["id"])) == 1


async def test_explicit_unavailable_agent_and_engine_down_payloads(store, project_dir):
    from .conftest import make_settings
    from seraphine.agents.service import AgentHarnessService

    svc = AgentHarnessService(store, make_settings(), engines={"down": FakeEngine("down", ok=False, reason="r")})
    await svc.start()
    try:
        agent, project = await setup_agent(svc, project_dir, engine="down")
        out = await svc.post_message(project["id"], "x", agent_id="ghost")
        assert out["error"] == "agent_not_available"
        out = await svc.post_message(project["id"], "x")
        assert out["error"] == "engine_unavailable" and out["run"] is None
    finally:
        await svc.stop()


async def test_message_pagination(svc, fake, project_dir):
    project = await svc.create_project(name="P", path=str(project_dir))
    for i in range(5):
        await svc.post_message(project["id"], f"m{i}")  # no agent: stored only
    msgs = await svc.list_messages(project["id"], limit=3)
    assert [m["body"] for m in msgs] == ["m2", "m3", "m4"]  # latest 3, in order
    after = await svc.list_messages(project["id"], after=msgs[0]["id"])
    assert [m["body"] for m in after] == ["m3", "m4"]


# -- tools -------------------------------------------------------------------


async def test_tool_flags(svc):
    for cls in (AgentsListTool, AgentsDelegateTool, AgentsRunStatusTool, AgentsCreateTaskTool):
        tool = cls(svc)
        # Only delegation starts a (file-editing) agent: the owner confirms it, since the
        # assistant reads untrusted content (WhatsApp, e-mail, web).
        assert tool.requires_confirmation is (cls is AgentsDelegateTool)
        assert tool.proxy_to_client is False
        assert tool.json_schema["type"] == "object" and tool.name.startswith("agents_")
    delegate = AgentsDelegateTool(svc)
    assert "confirma" in delegate.description and "objetivo" in delegate.description
    assert delegate.declaration()["requires_confirmation"] is True
    assert set(delegate.json_schema["required"]) == {"agent_id", "project_id", "goal"}


async def test_tools_delegate_and_status(svc, fake, project_dir):
    project, reviewer, writer = await _two_agents(svc, project_dir)
    fake.add(FakeTurn(final_message="feito", approval={"title": "Push", "command": "git push", "reason": "r"}))
    res = await AgentsDelegateTool(svc).execute(
        {"agent_id": "auto", "project_id": project["id"], "goal": "revise o código"})
    assert res.ok, res.error
    run_id = res.metadata["run_id"]
    assert res.metadata["agent_id"] == reviewer["id"]
    assert (await svc.get_run(run_id))["requested_by"] == "seraphine"
    await wait_run(svc, run_id, ("waiting_approval",))
    st = await AgentsRunStatusTool(svc).execute({"run_id": run_id})
    assert st.ok and st.metadata["status"] == "waiting_approval"
    assert st.metadata["pending_approval"]["command"] == "git push"
    assert st.metadata["last_events"]
    ls = await AgentsListTool(svc).execute({})
    assert ls.ok and {a["id"] for a in ls.metadata["agents"]} == {reviewer["id"], writer["id"]}
    assert [r["id"] for r in ls.metadata["active_runs"]] == [run_id]
    task = await AgentsCreateTaskTool(svc).execute(
        {"project_id": project["id"], "title": "Nova", "acceptance": ["a"]})
    assert task.ok and task.metadata["task"]["created_by"] == "seraphine"
    bad = await AgentsDelegateTool(svc).execute({"agent_id": "ghost", "project_id": project["id"], "goal": "x"})
    assert not bad.ok
    nf = await AgentsRunStatusTool(svc).execute({"run_id": "nope"})
    assert not nf.ok


async def test_registry_registers_tools_only_when_harness_given(svc):
    from seraphine.tools.registry import build_default_registry

    without = build_default_registry(allowed_roots=[])
    assert not any(t.name.startswith("agents_") for t in without)
    with_h = build_default_registry(allowed_roots=[], agent_harness=svc)
    names = {t.name for t in with_h if t.name.startswith("agents_")}
    assert names == {"agents_list", "agents_delegate", "agents_run_status", "agents_create_task"}
    assert with_h.get("agents_delegate").requires_confirmation is True
    for name in ("agents_list", "agents_run_status", "agents_create_task"):
        assert with_h.get(name).requires_confirmation is False


# -- HTTP CRUD smoke ---------------------------------------------------------


@pytest.fixture
def app(svc):
    a = FastAPI()
    a.include_router(router)
    a.state.agent_harness = svc
    return a


def _client(app, svc):
    transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 5000))
    return httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8000",
                             headers={TOKEN_HEADER: svc.token, "Origin": ORIGIN})


async def test_http_crud_and_run_flow(app, svc, fake, project_dir: Path, tmp_path: Path):
    async with _client(app, svc) as c:
        # project path validation -> 422
        bad = await c.post("/agents/projects", json={"name": "x", "path": str(tmp_path / "nope")})
        assert bad.status_code == 422
        root = await c.post("/agents/projects", json={"name": "x", "path": tmp_path.resolve().anchor})
        assert root.status_code == 422
        rel = await c.post("/agents/projects", json={"name": "x", "path": "relative/dir"})
        assert rel.status_code == 422

        r = await c.post("/agents/projects", json={"name": "Meu Projeto", "path": str(project_dir)})
        assert r.status_code == 200
        project = r.json()["project"]
        assert project["id"] == "meu-projeto" and project["archived"] is False

        r = await c.post("/agents/defs", json={"name": "Dev", "engine": "fake",
                                               "project_ids": [project["id"]], "daily_budget_usd": 1.5})
        assert r.status_code == 200
        agent = r.json()["def"]
        assert agent["project_ids"] == [project["id"]] and agent["perm_commands"] == "ask"
        assert (await c.post("/agents/defs", json={"name": "Z", "engine": "nope"})).status_code == 422
        r = await c.patch(f"/agents/defs/{agent['id']}", json={"perm_edit": "blocked", "project_ids": []})
        assert r.json()["def"]["perm_edit"] == "blocked" and r.json()["def"]["project_ids"] == []
        await c.patch(f"/agents/defs/{agent['id']}", json={"perm_edit": "free", "project_ids": [project["id"]]})
        assert (await c.get("/agents/defs/ghost")).status_code == 404
        assert len((await c.get("/agents/defs")).json()["defs"]) == 1

        r = await c.post("/agents/tasks", json={"project_id": project["id"], "title": "T1"})
        task = r.json()["task"]
        r2 = await c.post("/agents/tasks", json={"project_id": project["id"], "title": "T2"})
        assert (task["number"], r2.json()["task"]["number"]) == (1, 2)
        r = await c.patch(f"/agents/tasks/{task['id']}", json={"priority": "high", "status": "todo"})
        assert r.json()["task"]["priority"] == "high"
        assert (await c.get(f"/agents/tasks?project_id={project['id']}&status=todo")).json()["tasks"].__len__() == 2

        fake.add(FakeTurn(final_message="pronto"))
        r = await c.post(f"/agents/tasks/{task['id']}/run", json={"agent_id": agent["id"]})
        run = r.json()["run"]
        await wait_run(svc, run["id"], ("done",))
        r = await c.get(f"/agents/runs/{run['id']}")
        assert r.json()["run"]["status"] == "done"
        ev = (await c.get(f"/agents/runs/{run['id']}/events")).json()["events"]
        assert ev[-1]["payload"] == {"status": "done"}
        after = (await c.get(f"/agents/runs/{run['id']}/events?after={ev[1]['id']}")).json()["events"]
        assert [e["id"] for e in after] == [e["id"] for e in ev[2:]]
        assert (await c.get(f"/agents/runs?project_id={project['id']}&status=done")).json()["runs"].__len__() == 1
        assert (await c.get("/agents/runs/ghost")).status_code == 404

        # NDJSON stream of a finished run: replay + end
        s = await c.get(f"/agents/runs/{run['id']}/stream")
        assert s.headers["content-type"].startswith("application/x-ndjson")
        lines = [__import__("json").loads(x) for x in s.text.splitlines()]
        assert lines[-1]["type"] == "end" and lines[0]["type"] == "event"

        msgs = (await c.get(f"/agents/projects/{project['id']}/messages")).json()["messages"]
        assert msgs[-1]["body"] == "pronto"
        r = await c.post(f"/agents/projects/{project['id']}/messages", json={"body": "e agora?", "agent_id": "auto"})
        assert r.json()["run"]["agent_id"] == agent["id"]
        assert (await c.get(f"/agents/tasks/{task['id']}/messages")).json()["messages"][0]["body"] == "pronto"

        assert (await c.get("/agents/approvals")).json() == {"approvals": []}
        bad = await c.post("/agents/approvals/x/decide", json={"decision": "maybe"})
        assert bad.status_code == 422
        assert (await c.post("/agents/approvals/x/decide", json={"decision": "approve", "digest": "x"})).status_code == 404
        assert (await c.get("/agents/overview")).status_code == 200

        # archive (DELETE) hides the project from the default listing
        r = await c.delete(f"/agents/projects/{project['id']}")
        assert r.json()["project"]["archived"] is True
        assert (await c.get("/agents/projects")).json()["projects"] == []
        assert len((await c.get("/agents/projects?include_archived=true")).json()["projects"]) == 1
        # and runs can no longer be started in it
        r = await c.post("/agents/runs", json={"agent_id": agent["id"], "project_id": project["id"], "goal": "x"})
        assert r.status_code == 409
