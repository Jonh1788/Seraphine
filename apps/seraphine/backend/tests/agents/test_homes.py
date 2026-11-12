"""Phase 6a: the home of an agent (its own project and folder, and the conversation in it)."""

from __future__ import annotations

from pathlib import Path

from .conftest import make_api, wait_run


async def test_home_created_idempotent_and_folder_under_tmp(hsvc, tmp_path):
    agent = await hsvc.create_def(name="Ana", engine="fake")
    async with make_api(hsvc) as c:
        r = await c.post(f"/agents/defs/{agent['id']}/home")
        assert r.status_code == 200
        home = r.json()["project"]
        again = (await c.post(f"/agents/defs/{agent['id']}/home")).json()["project"]
    assert again["id"] == home["id"]
    assert home["kind"] == "home" and home["agent_id"] == agent["id"] and home["name"] == "Ana"
    folder = tmp_path / "casas" / agent["id"]
    assert folder.is_dir() and Path(home["path"]) == folder.resolve()
    fresh = await hsvc.get_def(agent["id"])
    assert fresh["home_project_id"] == home["id"] and home["id"] in fresh["project_ids"]
    homes = [p for p in await hsvc.list_projects() if p["kind"] == "home"]
    assert len(homes) == 1


async def test_home_404_and_unavailable(hsvc, tmp_path):
    async with make_api(hsvc) as c:
        assert (await c.post("/agents/defs/nao-existe/home")).status_code == 404
    agent = await hsvc.create_def(name="Ana", engine="fake")
    blocker = tmp_path / "casas"
    blocker.write_text("sou um arquivo")  # the parent cannot become a folder
    async with make_api(hsvc) as c:
        r = await c.post(f"/agents/defs/{agent['id']}/home")
    assert r.status_code == 422 and r.json()["code"] == "home_unavailable" and r.json()["detail"]


async def test_home_dir_default_is_under_user_folder_and_lazy(store):
    from types import SimpleNamespace

    from seraphine.agents.service import AgentHarnessService

    svc = AgentHarnessService(store, SimpleNamespace(), engines={})
    assert svc.home_dir() == Path.home() / "Seraphine" / "agentes"  # only computed, never created here


async def test_archived_home_is_restored(hsvc):
    agent = await hsvc.create_def(name="Ana", engine="fake")
    home = await hsvc.ensure_home(agent["id"])
    await hsvc._db(lambda c: c.execute("UPDATE agent_projects SET archived = 1 WHERE id = ?", (home["id"],)))
    assert home["id"] not in [p["id"] for p in await hsvc.list_projects()]
    back = await hsvc.ensure_home(agent["id"])
    assert back["id"] == home["id"] and back["archived"] is False


async def test_message_in_a_home_goes_to_its_owner_without_the_router(hsvc):
    calls: list[str] = []

    async def router(project_id, body, cands):
        calls.append(body)
        return cands[-1]["id"]

    hsvc.router = router
    ana = await hsvc.create_def(name="Ana", engine="fake")
    beto = await hsvc.create_def(name="Beto", engine="fake")
    home = await hsvc.ensure_home(ana["id"])
    await hsvc.update_def(beto["id"], project_ids=[home["id"]])  # two agents can reach the home
    out = await hsvc.post_message(home["id"], "olá")
    assert out["error"] is None and out["agent_id"] == ana["id"] and calls == []
    await wait_run(hsvc, out["run"]["id"], ("done",))
    # a mention still addresses the other agent; an explicit choice too
    out = await hsvc.post_message(home["id"], "@beto e você?")
    assert out["agent_id"] == beto["id"]
    await wait_run(hsvc, out["run"]["id"], ("done",))
    out = await hsvc.post_message(home["id"], "oi", agent_id=beto["id"])
    assert out["agent_id"] == beto["id"]
    # an owner that is disabled: no silent re-routing
    await hsvc.update_def(ana["id"], enabled=False)
    out = await hsvc.post_message(home["id"], "oi de novo")
    assert out["error"] == "agent_not_available" and out["run"] is None


async def test_rename_follows_agent_and_delete_archives_home_but_keeps_folder(hsvc, tmp_path):
    agent = await hsvc.create_def(name="Ana", engine="fake")
    home = await hsvc.ensure_home(agent["id"])
    await hsvc.update_def(agent["id"], name="Ana Maria")
    assert (await hsvc.get_project(home["id"]))["name"] == "Ana Maria"
    marker = Path(home["path"]) / "nota.txt"
    marker.write_text("fica")
    async with make_api(hsvc) as c:
        assert (await c.delete(f"/agents/defs/{agent['id']}")).status_code == 200
    after = await hsvc.get_project(home["id"])
    assert after["archived"] is True and after["kind"] == "home"
    assert marker.read_text() == "fica"
    # a later agent with the same id gets a new home, not the old conversation
    again = await hsvc.create_def(name="Ana", engine="fake")
    assert again["id"] == agent["id"]
    fresh = await hsvc.ensure_home(again["id"])
    assert fresh["id"] != home["id"]


async def test_home_managed_refusals(hsvc, project_dir):
    agent = await hsvc.create_def(name="Ana", engine="fake")
    home = await hsvc.ensure_home(agent["id"])
    async with make_api(hsvc) as c:
        for body in ({"name": "Outro"}, {"path": str(project_dir)}, {"archived": True}):
            r = await c.patch(f"/agents/projects/{home['id']}", json=body)
            assert r.status_code == 409 and r.json()["code"] == "home_managed", body
        r = await c.delete(f"/agents/projects/{home['id']}")
        assert r.status_code == 409 and r.json()["code"] == "home_managed"
        r = await c.patch(f"/agents/projects/{home['id']}", json={"description": "conversa"})
        assert r.status_code == 200 and r.json()["project"]["description"] == "conversa"
        # a normal project is untouched, and shows kind/agent_id
        proj = (await c.post("/agents/projects", json={"name": "P", "path": str(project_dir)})).json()["project"]
        assert proj["kind"] == "project" and proj["agent_id"] is None
        listed = (await c.get("/agents/projects")).json()["projects"]
        assert {p["kind"] for p in listed} == {"home", "project"}
        assert (await c.patch(f"/agents/projects/{proj['id']}", json={"name": "Q"})).status_code == 200

