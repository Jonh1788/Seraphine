"""Phase 3c, part 1: grants at ``write``, the tools that write, receipts and undo.

Whole path through the fake engine's gateway calls, the way the MCP bridge would make them; the
notes are the assistant's real ``NoteService`` over a temporary SQLite, the reminders a small fake
scheduler, the project tasks the harness's own."""

from __future__ import annotations

import asyncio
import json
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from seraphine.agents import catalog
from seraphine.agents import schema as agents_schema
from seraphine.agents.catalog import Services
from seraphine.agents.engines.fake import FakeEngine, FakeTurn
from seraphine.agents.errors import Conflict, Invalid, NotFound
from seraphine.agents.gateway import DATA_OPEN
from seraphine.agents.prompts import inbox_note
from seraphine.agents.routes import TOKEN_HEADER, router
from seraphine.agents.service import AgentHarnessService
from seraphine.config import Settings

from .conftest import make_settings, setup_agent, wait_run, wait_until
from .test_gateway import events_of, notes, payloads  # noqa: F401  (``notes`` is a fixture)
from .test_inbox import drain, tap

ACTION_KEYS = {"id", "run_id", "agent_id", "project_id", "tool", "group", "label", "created_at", "undo_until",
               "undone_at", "can_undo"}
WRITE_ALL = {"notes": "write", "project_tasks": "write", "reminders": "write"}


class FakeScheduler:
    """Enough of ``ReminderScheduler`` for the reminder tools."""

    def __init__(self) -> None:
        self.jobs: dict[str, dict[str, Any]] = {}

    def add_reminder(self, fire_at: datetime, message: str, reminder_id: str | None = None,
                     recurring: str | None = None) -> str:
        rid = reminder_id or str(uuid.uuid4())
        self.jobs[rid] = {"id": rid, "message": message, "fire_at": str(fire_at), "recurring": recurring,
                          "next_run": str(fire_at)}
        return rid

    def cancel_reminder(self, reminder_id: str) -> bool:
        return self.jobs.pop(reminder_id, None) is not None

    def list_reminders(self) -> list[dict[str, Any]]:
        return [dict(j) for j in self.jobs.values()]


@pytest.fixture
def scheduler() -> FakeScheduler:
    return FakeScheduler()


def wire(svc: AgentHarnessService, fake: FakeEngine, *, notes: Any = None, reminders: Any = None) -> None:
    fake.supports_bridge = True
    fake.gateway = svc.gateway
    svc.gateway.services = Services(notes=notes, reminders=reminders)


async def held(svc, fake, project_dir, *, grants: dict[str, str] | None = WRITE_ALL, **agent_over: Any):
    """A run whose turn is held open at a gate: ``(agent, project, run, token, gate)``."""
    gate = asyncio.Event()
    agent, project = await setup_agent(svc, project_dir, **agent_over)
    if grants:
        await svc.set_grants(agent["id"], grants)
    fake.add(FakeTurn(events=[], gate=gate))
    run = await svc.start_run(agent["id"], project["id"], "trabalhe")
    await wait_until(lambda: bool(fake.bridges) and fake.bridges[-1] is not None)
    return agent, project, run, fake.bridges[-1].token, gate


async def finish(svc, run, gate) -> dict:
    gate.set()
    return await wait_run(svc, run["id"], ("done", "failed", "cancelled"))


def api(svc: AgentHarnessService, *, token: bool = True) -> httpx.AsyncClient:
    app = FastAPI()
    app.include_router(router)
    app.state.agent_harness = svc
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=("127.0.0.1", 50000)),
                             base_url="http://127.0.0.1:8000", headers={TOKEN_HEADER: svc.token} if token else {})


async def rows(svc: AgentHarnessService, sql: str = "SELECT * FROM agent_actions ORDER BY rowid") -> list[dict]:
    def _r(conn: Any) -> list[dict]:
        cur = conn.execute(sql)
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]

    return await svc._db(_r)


# -- grants at ``write`` --------------------------------------------------------------------------


async def test_write_is_accepted_only_on_groups_that_have_a_tool_that_writes(svc, project_dir):
    agent, _ = await setup_agent(svc, project_dir)
    got = await svc.set_grants(agent["id"], {"notes": "write", "project_tasks": "write", "reminders": "write"})
    assert (got["notes"], got["project_tasks"], got["reminders"]) == ("write", "write", "write")
    for group in ("wiki", "memory"):
        with pytest.raises(Invalid, match="não tem ferramentas que escrevem"):
            await svc.set_grants(agent["id"], {group: "write"})
    with pytest.raises(Invalid):
        await svc.set_grants(agent["id"], {"notes": "escrever"})
    assert (await svc.get_grants(agent["id"]))["wiki"] == "read"  # the refused request stored nothing


async def test_nothing_is_write_by_default(svc, project_dir):
    agent, _ = await setup_agent(svc, project_dir)
    assert await svc.get_grants(agent["id"]) == {
        "notes": "read", "wiki": "read", "memory": "none", "project_tasks": "read", "reminders": "none"}
    assert all(g.default != "write" for g in catalog.GROUPS)


async def test_a_stored_write_on_a_group_without_write_tools_counts_as_read(svc, project_dir):
    agent, _ = await setup_agent(svc, project_dir)
    await svc._db(lambda c: c.execute(
        "INSERT INTO agent_grants (agent_id, group_id, level) VALUES (?, 'wiki', 'write')", (agent["id"],)))
    assert (await svc.get_grants(agent["id"]))["wiki"] == "read"


async def test_the_tools_route_says_the_level_of_each_tool_and_the_levels_of_each_group(svc):
    async with api(svc) as c:
        groups = {g["id"]: g for g in (await c.get("/agents/tools")).json()["groups"]}
    assert groups["notes"]["levels"] == ["none", "read", "write"]
    assert groups["project_tasks"]["levels"] == ["none", "read", "write"]
    assert groups["reminders"]["levels"] == ["none", "read", "write"]
    assert groups["wiki"]["levels"] == ["none", "read"] and groups["memory"]["levels"] == ["none", "read"]
    levels = {t["name"]: (t["level"], t["read_only"]) for g in groups.values() for t in g["tools"]}
    assert levels["search_notes"] == ("read", True) and levels["create_note"] == ("write", False)
    assert levels["update_note"] == ("write", False) and levels["list_project_tasks"] == ("read", True)
    assert levels["create_project_task"] == ("write", False) and levels["update_project_task"] == ("write", False)
    assert levels["list_reminders"] == ("read", True) and levels["create_reminder"] == ("write", False)
    assert "ask_owner" not in levels and "ping" not in levels  # the system group stays hidden


async def test_the_grants_routes_accept_write_where_it_exists(svc, project_dir):
    agent, _ = await setup_agent(svc, project_dir)
    url = f"/agents/defs/{agent['id']}/grants"
    async with api(svc) as c:
        r = await c.put(url, json={"grants": {"notes": "write"}})
        assert r.status_code == 200 and r.json()["grants"]["notes"] == "write"
        assert (await c.put(url, json={"grants": {"wiki": "write"}})).status_code == 422
        assert (await c.put(url, json={"grants": {"memory": "write"}})).status_code == 422
        assert (await c.get(url)).json()["grants"]["notes"] == "write"


async def test_a_write_tool_is_refused_at_read_and_is_not_offered_but_works_once_the_owner_grants_it(
        svc, fake, project_dir, notes):
    wire(svc, fake, notes=notes)
    agent, _, run, token, gate = await held(svc, fake, project_dir, grants=None)  # defaults: notes read
    offered = [t["name"] for t in json.loads(Path(fake.bridges[0].tools_file).read_text(encoding="utf-8"))["tools"]]
    assert "search_notes" in offered and "create_note" not in offered and "update_note" not in offered
    refused = await svc.gateway.call(token, "create_note", {"title": "Compras"})
    assert refused["ok"] is False and refused["error"].startswith("Sem acesso") and "só pode ler" in refused["error"]
    assert await notes.list() == []  # nothing was created
    denied = payloads(await events_of(svc, run["id"]), reason="tool_denied")
    assert len(denied) == 1 and denied[0]["tool"] == "create_note" and denied[0]["group"] == "notes"
    assert payloads(await events_of(svc, run["id"]), type="seraphine_tool") == []  # not even an action
    assert await rows(svc) == []
    # the access is read from the database on every call: granting now works on the same turn
    await svc.set_grants(agent["id"], {"notes": "write"})
    assert (await svc.gateway.call(token, "create_note", {"title": "Compras"}))["ok"] is True
    await svc.set_grants(agent["id"], {"notes": "none"})
    assert (await svc.gateway.call(token, "create_note", {"title": "Outra"}))["ok"] is False
    await finish(svc, run, gate)
    assert [n.title for n in await notes.list()] == ["Compras"]


async def test_with_the_group_at_write_the_tools_file_lists_the_write_tools(svc, fake, project_dir, notes, scheduler):
    wire(svc, fake, notes=notes, reminders=scheduler)
    _, _, run, _, gate = await held(svc, fake, project_dir)
    offered = [t["name"] for t in json.loads(Path(fake.bridges[0].tools_file).read_text(encoding="utf-8"))["tools"]]
    assert offered == ["ping", "search_notes", "list_notes", "wiki_search", "wiki_list_pages", "wiki_read_page",
                       "create_note", "update_note", "list_project_tasks", "create_project_task",
                       "update_project_task", "list_reminders", "create_reminder", "ask_owner"]
    await finish(svc, run, gate)


async def test_a_write_tool_works_even_when_the_agent_may_not_edit_files(svc, fake, project_dir, notes):
    wire(svc, fake, notes=notes)
    _, _, run, token, gate = await held(svc, fake, project_dir, perm_edit="blocked")
    assert (await svc.gateway.call(token, "create_note", {"title": "Ideia"}))["ok"] is True
    await finish(svc, run, gate)
    assert [n.title for n in await notes.list()] == ["Ideia"]


# -- each tool against temporary data ------------------------------------------------------------------


async def test_create_note_creates_confirms_with_the_id_and_leaves_a_receipt(svc, fake, project_dir, notes):
    wire(svc, fake, notes=notes)
    agent, project, run, token, gate = await held(svc, fake, project_dir)
    res = await svc.gateway.call(token, "create_note",
                                 {"title": "Compras", "content": "- leite\n- pão", "tags": ["casa", "mercado"]})
    assert res["ok"] is True and "Nota criada: «Compras»" in res["content"]
    (note,) = await notes.list()
    assert note.title == "Compras" and note.content == "- leite\n- pão" and note.tags == ["casa", "mercado"]
    assert f"id {note.id}" in res["content"]
    await finish(svc, run, gate)
    (action,) = await rows(svc)
    assert (action["run_id"], action["agent_id"], action["project_id"]) == (run["id"], agent["id"], project["id"])
    assert (action["tool"], action["group_id"], action["kind"], action["target_type"], action["target_id"]) == (
        "create_note", "notes", "create", "note", note.id)
    assert action["label"] == "Criou a nota «Compras»" and action["before_json"] is None
    assert len(action["fingerprint"]) == 64 and action["undone_at"] is None
    assert action["undo_until"] > action["created_at"]


async def test_create_note_rejects_bad_tags_and_a_missing_service(svc, fake, project_dir, notes):
    wire(svc, fake, notes=notes)
    _, _, run, token, gate = await held(svc, fake, project_dir)
    bad = await svc.gateway.call(token, "create_note", {"title": "x", "tags": [1, 2]})
    assert bad["ok"] is False and "tags" in bad["error"]
    blank = await svc.gateway.call(token, "create_note", {"title": "   "})
    assert blank["ok"] is False and "vazio" in blank["error"]
    svc.gateway.services = Services(notes=None)
    gone = await svc.gateway.call(token, "create_note", {"title": "x"})
    assert gone == {"ok": False, "error": "As notas não estão disponíveis agora."}
    await finish(svc, run, gate)
    assert await rows(svc) == []  # a write that did not happen leaves no receipt


async def test_update_note_keeps_the_previous_values_of_only_the_fields_it_changed(svc, fake, project_dir, notes):
    wire(svc, fake, notes=notes)
    original = await notes.create(title="Plano", content="texto antigo", tags=["a"])
    _, _, run, token, gate = await held(svc, fake, project_dir)
    res = await svc.gateway.call(token, "update_note", {"id": original.id, "title": "Plano B", "tags": ["a", "b"]})
    assert res["ok"] is True and "Nota alterada: «Plano B»" in res["content"]
    now = await notes.get(original.id)
    assert (now.title, now.content, now.tags) == ("Plano B", "texto antigo", ["a", "b"])
    nothing = await svc.gateway.call(token, "update_note", {"id": original.id})
    assert nothing["ok"] is False and "o que mudar" in nothing["error"]
    missing = await svc.gateway.call(token, "update_note", {"id": "nao-existe", "title": "x"})
    assert missing["ok"] is False and "Não achei a nota" in missing["error"]
    await finish(svc, run, gate)
    (action,) = await rows(svc)
    assert action["kind"] == "update" and action["target_id"] == original.id
    assert json.loads(action["before_json"]) == {"title": "Plano", "tags": ["a"]}  # not the untouched content
    assert action["label"] == "Alterou a nota «Plano B»"


async def test_project_task_tools_only_see_the_project_of_the_run(svc, fake, project_dir, tmp_path):
    other_dir = tmp_path / "outro"
    other_dir.mkdir()
    other = await svc.create_project(name="Outro projeto", path=str(other_dir))
    foreign = await svc.create_task(project_id=other["id"], title="Tarefa de fora")
    wire(svc, fake)
    agent, project, run, token, gate = await held(svc, fake, project_dir)
    mine = await svc.create_task(project_id=project["id"], title="Tarefa daqui", description="detalhe", priority="high")
    listed = await svc.gateway.call(token, "list_project_tasks", {})
    assert listed["ok"] is True and "Tarefa daqui" in listed["content"] and mine["id"] in listed["content"]
    assert "Tarefa de fora" not in listed["content"] and foreign["id"] not in listed["content"]
    assert "situação todo" in listed["content"] and "prioridade high" in listed["content"]
    only_done = await svc.gateway.call(token, "list_project_tasks", {"status": "done"})
    assert "Nenhuma tarefa" in only_done["content"]
    # another project's task behaves as "not found": nothing changes, no receipt
    for args in ({"task_id": foreign["id"], "title": "invadida"}, {"task_id": "nao-existe", "status": "done"}):
        res = await svc.gateway.call(token, "update_project_task", args)
        assert res["ok"] is False and "Não achei a tarefa" in res["error"]
    assert (await svc.get_task(foreign["id"]))["title"] == "Tarefa de fora"
    assert await rows(svc) == []
    await finish(svc, run, gate)


async def test_create_and_update_project_task_work_inside_the_run_project_only(svc, fake, project_dir):
    wire(svc, fake)
    agent, project, run, token, gate = await held(svc, fake, project_dir)
    made = await svc.gateway.call(token, "create_project_task",
                                  {"title": "Revisar o contrato", "description": "ver cláusula 4", "priority": "high"})
    assert made["ok"] is True and "Tarefa criada: #1 «Revisar o contrato»" in made["content"]
    (task,) = await svc.list_tasks(project["id"])
    assert (task["title"], task["priority"], task["status"], task["created_by"]) == (
        "Revisar o contrato", "high", "todo", "agent")
    assert task["description"] == "ver cláusula 4" and task["project_id"] == project["id"]
    changed = await svc.gateway.call(token, "update_project_task",
                                     {"task_id": task["id"], "status": "doing", "priority": "low"})
    assert changed["ok"] is True and "Tarefa alterada: #1" in changed["content"]
    now = await svc.get_task(task["id"])
    assert (now["status"], now["priority"], now["title"]) == ("doing", "low", "Revisar o contrato")
    for bad in ({"title": ""}, {"title": "x", "priority": "urgente"}):
        assert (await svc.gateway.call(token, "create_project_task", bad))["ok"] is False
    # no tool of this step cancels or deletes: "cancelled" is not a status an agent can set
    cancel = await svc.gateway.call(token, "update_project_task", {"task_id": task["id"], "status": "cancelled"})
    assert cancel["ok"] is False and "status" in cancel["error"]
    await finish(svc, run, gate)
    made_row, changed_row = await rows(svc)
    assert (made_row["kind"], made_row["target_type"], made_row["label"]) == (
        "create", "project_task", "Criou a tarefa #1 «Revisar o contrato»")
    assert changed_row["kind"] == "update"
    assert json.loads(changed_row["before_json"]) == {"status": "todo", "priority": "high"}


async def test_reminder_tools_list_and_create_through_the_assistants_tools(svc, fake, project_dir, scheduler):
    wire(svc, fake, reminders=scheduler)
    _, _, run, token, gate = await held(svc, fake, project_dir)
    assert "Nenhum lembrete" in (await svc.gateway.call(token, "list_reminders", {}))["content"]
    res = await svc.gateway.call(token, "create_reminder",
                                 {"message": "Pagar o condomínio", "time": "2030-11-20T14:00:00-03:00"})
    assert res["ok"] is True and "Lembrete criado para 20/11/2030 14:00" in res["content"]
    (job,) = scheduler.jobs.values()
    assert job["message"] == "Pagar o condomínio" and job["recurring"] is None
    assert job["id"] in res["content"]
    listed = (await svc.gateway.call(token, "list_reminders", {}))["content"]
    assert "Origem: lembretes do dono." in listed and "Pagar o condomínio" in listed
    weekly = await svc.gateway.call(token, "create_reminder",
                                    {"message": "Revisão", "time": "2030-11-21T09:00:00-03:00", "recurring": "weekly"})
    assert weekly["ok"] is True and sorted(j["recurring"] or "" for j in scheduler.jobs.values()) == ["", "weekly"]
    bad = await svc.gateway.call(token, "create_reminder", {"message": "x", "time": "quando der"})
    assert bad["ok"] is False and "horário" in bad["error"]
    assert (await svc.gateway.call(token, "create_reminder", {"message": "x", "time": "1", "recurring": "minutely"}))["ok"] is False
    svc.gateway.services = Services(reminders=None)
    assert (await svc.gateway.call(token, "list_reminders", {}))["error"] == "Os lembretes não estão disponíveis agora."
    await finish(svc, run, gate)
    first, second = await rows(svc)
    assert first["target_type"] == "reminder" and first["kind"] == "create" and first["target_id"] == job["id"]
    assert first["label"] == "Criou o lembrete «Pagar o condomínio» para 20/11/2030 14:00"


async def test_reminders_are_none_by_default_so_their_tools_are_refused(svc, fake, project_dir, scheduler):
    wire(svc, fake, reminders=scheduler)
    _, _, run, token, gate = await held(svc, fake, project_dir, grants=None)
    for tool, args in (("list_reminders", {}), ("create_reminder", {"message": "x", "time": "14:00"})):
        res = await svc.gateway.call(token, tool, args)
        assert res["ok"] is False and "Sem acesso" in res["error"] and "Lembretes" in res["error"]
    assert scheduler.jobs == {}
    await finish(svc, run, gate)


async def test_ask_owner_validates_its_arguments(svc, fake, project_dir):
    wire(svc, fake)
    _, _, run, token, gate = await held(svc, fake, project_dir, grants=None)
    five = await svc.gateway.call(token, "ask_owner", {"pergunta": "?", "opcoes": ["a", "b", "c", "d", "e"]})
    assert five["ok"] is False and "no máximo 4" in five["error"]
    assert (await svc.gateway.call(token, "ask_owner", {"pergunta": "?", "opcoes": ["a", 2]}))["ok"] is False
    assert (await svc.gateway.call(token, "ask_owner", {"pergunta": "  "}))["ok"] is False
    assert (await svc.gateway.call(token, "ask_owner", {}))["error"].startswith("Faltam argumentos")
    assert (await svc.get_run(run["id"]))["question"] is None  # nothing was asked
    await finish(svc, run, gate)


# -- the write step ------------------------------------------------------------------------------------


async def test_the_completed_step_of_a_write_carries_the_receipt(svc, fake, project_dir, notes):
    wire(svc, fake, notes=notes)
    _, _, run, token, gate = await held(svc, fake, project_dir)
    await svc.gateway.call(token, "create_note", {"title": "Compras"})
    await svc.gateway.call(token, "update_note", {"id": "nao-existe", "title": "x"})  # a write that failed
    await svc.gateway.call(token, "search_notes", {"query": "compras"})
    await finish(svc, run, gate)
    steps = payloads(await events_of(svc, run["id"]), type="seraphine_tool")
    started, done = steps[0], steps[1]
    assert (started["phase"], started["read_only"], started["label"]) == ("started", False, "Criar a nota «Compras»")
    assert "action_id" not in started and "undo_until" not in started
    (action,) = await svc.list_actions(run["id"])
    assert done["phase"] == "completed" and done["ok"] is True and done["read_only"] is False
    assert done["action_id"] == action["id"] and done["undo_until"] == action["undo_until"]
    # the completed line is what happened (the receipt's words); the started one stays an intention
    assert done["label"] == action["label"] == "Criou a nota «Compras»"
    failed = steps[3]
    assert failed["ok"] is False and failed["read_only"] is False and "action_id" not in failed
    assert failed["label"] == steps[2]["label"] == "Alterar a nota «x»"  # nothing was done: still the intention
    read = steps[5]
    assert read["read_only"] is True and "action_id" not in read
    assert (await svc.get_run(run["id"]))["actions_count"] == 3


async def test_the_undo_window_is_the_setting(store, fake, project_dir, notes):
    s = AgentHarnessService(store, make_settings(agents_undo_window_s=90), engines={"fake": fake})
    await s.start()
    try:
        wire(s, fake, notes=notes)
        _, _, run, token, gate = await held(s, fake, project_dir)
        await s.gateway.call(token, "create_note", {"title": "x"})
        await finish(s, run, gate)
        (a,) = await s.list_actions(run["id"])
        span = datetime.fromisoformat(a["undo_until"]) - datetime.fromisoformat(a["created_at"])
        assert span == timedelta(seconds=90) and a["can_undo"] is True
    finally:
        await s.stop()


async def test_a_write_is_a_non_read_only_action_for_the_loop_detector(svc, fake, project_dir, notes):
    wire(svc, fake, notes=notes)
    agent, project = await setup_agent(svc, project_dir)
    await svc.set_grants(agent["id"], WRITE_ALL)
    # three identical writes are a loop (the limit of a read is six)
    fake.add(FakeTurn(events=[], silent=True, gateway_calls=[("create_note", {"title": "Igual"})] * 4))
    run = await svc.start_run(agent["id"], project["id"], "x")
    failed = await wait_run(svc, run["id"], ("failed",))
    assert failed["error"] == "stuck_loop" and failed["actions_count"] == 3
    assert len(await notes.list()) == 3


async def test_a_write_cut_by_a_restart_is_an_open_action_that_blocks_the_automatic_resume(store, project_dir):
    def started_step(read_only: bool) -> tuple[str, dict]:
        return ("step", {"type": "seraphine_tool", "phase": "started", "call_id": "seraphine-1", "tool": "x",
                         "group": "notes", "label": "Criar a nota «x»", "read_only": read_only})

    async def crashed(read_only: bool):
        s1 = AgentHarnessService(store, make_settings(), engines={"fake": FakeEngine(turns=[
            FakeTurn(events=[started_step(read_only)], gate=asyncio.Event())])})
        await s1.start()
        agent, project = await setup_agent(s1, project_dir)
        run = await s1.start_run(agent["id"], project["id"], "x")
        await wait_run(s1, run["id"], ("running",))
        await wait_until(lambda: s1.engines["fake"].active == 1)
        await asyncio.sleep(0.1)
        s1.shutdown_drain_s = 0
        await s1.stop()  # what a kill leaves: the run is still ``running``, the write has no end
        return run

    write_run = await crashed(False)
    engine2 = FakeEngine()
    s2 = AgentHarnessService(store, make_settings(), engines={"fake": engine2})
    await s2.start()
    try:
        r = await s2.get_run(write_run["id"])
        assert r["status"] == "failed" and r["error"] == "interrupted_mid_action"
        assert engine2.calls == []  # not resumed, not restarted
        assert "ferramenta da Seraphine" in json.dumps(await s2.list_events(write_run["id"]), ensure_ascii=False)
    finally:
        await s2.stop()


async def test_a_read_cut_by_a_restart_still_resumes(store, project_dir):
    s1 = AgentHarnessService(store, make_settings(), engines={"fake": FakeEngine(turns=[FakeTurn(
        events=[("step", {"type": "seraphine_tool", "phase": "started", "call_id": "seraphine-1",
                          "tool": "search_notes", "group": "notes", "label": "x", "read_only": True})],
        gate=asyncio.Event())])})
    await s1.start()
    agent, project = await setup_agent(s1, project_dir)
    run = await s1.start_run(agent["id"], project["id"], "x")
    await wait_run(s1, run["id"], ("running",))
    await wait_until(lambda: s1.engines["fake"].active == 1)
    await asyncio.sleep(0.1)
    s1.shutdown_drain_s = 0
    await s1.stop()
    s2 = AgentHarnessService(store, make_settings(), engines={"fake": FakeEngine()})
    await s2.start()
    try:
        assert (await wait_run(s2, run["id"], ("done", "failed")))["status"] == "done"
    finally:
        await s2.stop()


# -- undo ---------------------------------------------------------------------------------------------


async def test_undoing_a_creation_removes_the_item_and_tells_everybody(svc, fake, project_dir, notes):
    wire(svc, fake, notes=notes)
    agent, project, run, token, gate = await held(svc, fake, project_dir)
    await svc.gateway.call(token, "create_note", {"title": "Compras"})
    (action,) = await svc.list_actions(run["id"])
    assert set(action) == ACTION_KEYS and action["can_undo"] is True and action["undone_at"] is None
    assert action["tool"] == "create_note" and action["group"] == "notes"
    q = tap(svc)
    undone = await svc.undo_action(action["id"])
    assert await notes.list() == []
    assert set(undone) == ACTION_KEYS and undone["undone_at"] and undone["can_undo"] is False
    frames = [f for f in drain(q) if f["type"] == "action_update"]
    assert len(frames) == 1 and frames[0]["action"] == undone
    note = payloads(await events_of(svc, run["id"]), reason="action_undone")
    assert len(note) == 1 and note[0]["type"] == "note" and note[0]["action_id"] == action["id"]
    assert note[0]["text"] == "O dono desfez esta ação: Criou a nota «Compras»."
    assert (await svc.list_actions(run["id"]))[0]["undone_at"] == undone["undone_at"]
    await finish(svc, run, gate)


async def test_undoing_a_change_puts_the_previous_values_back(svc, fake, project_dir, notes):
    wire(svc, fake, notes=notes)
    original = await notes.create(title="Plano", content="texto antigo", tags=["a"])
    _, project, run, token, gate = await held(svc, fake, project_dir)
    task = await svc.create_task(project_id=project["id"], title="Ligar", description="de manhã", priority="low")
    await svc.gateway.call(token, "update_note", {"id": original.id, "title": "Novo", "content": "novo", "tags": []})
    await svc.gateway.call(token, "update_project_task",
                           {"task_id": task["id"], "title": "Ligar para o banco", "status": "doing", "priority": "high"})
    note_action, task_action = await svc.list_actions(run["id"])
    await svc.undo_action(note_action["id"])
    back = await notes.get(original.id)
    assert (back.title, back.content, back.tags) == ("Plano", "texto antigo", ["a"])
    await svc.undo_action(task_action["id"])
    back_task = await svc.get_task(task["id"])
    assert (back_task["title"], back_task["status"], back_task["priority"], back_task["description"]) == (
        "Ligar", "todo", "low", "de manhã")
    await finish(svc, run, gate)


async def test_undoing_creations_of_a_task_and_a_reminder(svc, fake, project_dir, scheduler):
    wire(svc, fake, reminders=scheduler)
    _, project, run, token, gate = await held(svc, fake, project_dir)
    await svc.gateway.call(token, "create_project_task", {"title": "Nova"})
    await svc.gateway.call(token, "create_reminder", {"message": "Avisar", "time": "2030-11-20T14:00:00-03:00"})
    task_action, reminder_action = await svc.list_actions(run["id"])
    assert len(await svc.list_tasks(project["id"])) == 1 and len(scheduler.jobs) == 1
    await svc.undo_action(task_action["id"])
    await svc.undo_action(reminder_action["id"])
    assert await svc.list_tasks(project["id"]) == [] and scheduler.jobs == {}
    await finish(svc, run, gate)


async def test_undoing_a_creation_that_is_already_gone_is_fine(svc, fake, project_dir, notes):
    wire(svc, fake, notes=notes)
    _, _, run, token, gate = await held(svc, fake, project_dir)
    await svc.gateway.call(token, "create_note", {"title": "Efêmera"})
    (action,) = await svc.list_actions(run["id"])
    await notes.delete((await notes.list())[0].id)  # the owner removed it by hand
    assert (await svc.undo_action(action["id"]))["undone_at"]
    await finish(svc, run, gate)


async def test_undo_expired_after_the_window_and_nothing_changes(svc, fake, project_dir, notes):
    wire(svc, fake, notes=notes)
    _, _, run, token, gate = await held(svc, fake, project_dir)
    await svc.gateway.call(token, "create_note", {"title": "Fica"})
    (action,) = await svc.list_actions(run["id"])
    svc.now = lambda: datetime.now(timezone.utc) + timedelta(seconds=svc.undo_window_s + 1)
    assert (await svc.list_actions(run["id"]))[0]["can_undo"] is False
    with pytest.raises(Conflict) as exc:
        await svc.undo_action(action["id"])
    assert exc.value.code == "undo_expired"
    assert [n.title for n in await notes.list()] == ["Fica"]
    assert (await svc.list_actions(run["id"]))[0]["undone_at"] is None
    await finish(svc, run, gate)


async def test_already_undone(svc, fake, project_dir, notes):
    wire(svc, fake, notes=notes)
    _, _, run, token, gate = await held(svc, fake, project_dir)
    await svc.gateway.call(token, "create_note", {"title": "x"})
    (action,) = await svc.list_actions(run["id"])
    await svc.undo_action(action["id"])
    with pytest.raises(Conflict) as exc:
        await svc.undo_action(action["id"])
    assert exc.value.code == "already_undone"
    await finish(svc, run, gate)


async def test_unknown_action_is_not_found(svc):
    with pytest.raises(NotFound):
        await svc.undo_action("nao-existe")


async def test_undo_conflict_when_the_owner_edited_the_item_after_the_agent_and_nothing_changes(
        svc, fake, project_dir, notes):
    wire(svc, fake, notes=notes)
    original = await notes.create(title="Plano", content="antigo")
    _, project, run, token, gate = await held(svc, fake, project_dir)
    await svc.gateway.call(token, "update_note", {"id": original.id, "title": "Plano do agente"})
    await svc.gateway.call(token, "create_note", {"title": "Criada pelo agente"})
    await svc.gateway.call(token, "update_project_task", {"task_id": "x", "status": "doing"})  # failed: no receipt
    task = await svc.create_task(project_id=project["id"], title="T")
    await svc.gateway.call(token, "update_project_task", {"task_id": task["id"], "status": "doing"})
    changed, created, task_change = await svc.list_actions(run["id"])
    # edits by another route after the agent's writes
    await notes.update(original.id, content="editado pelo dono")
    created_note = next(n for n in await notes.list() if n.title == "Criada pelo agente")
    await notes.update(created_note.id, tags=["dono"])
    await svc.update_task(task["id"], description="o dono mexeu")
    for action in (changed, created, task_change):
        with pytest.raises(Conflict) as exc:
            await svc.undo_action(action["id"])
        assert exc.value.code == "undo_conflict"
    kept = await notes.get(original.id)
    assert (kept.title, kept.content) == ("Plano do agente", "editado pelo dono")  # the owner's edit survived
    assert (await notes.get(created_note.id)).tags == ["dono"]
    assert (await svc.get_task(task["id"]))["status"] == "doing"
    assert all(a["undone_at"] is None for a in await svc.list_actions(run["id"]))
    assert payloads(await events_of(svc, run["id"]), reason="action_undone") == []
    await finish(svc, run, gate)


async def test_undo_routes_and_their_codes(svc, fake, project_dir, notes):
    wire(svc, fake, notes=notes)
    _, _, run, token, gate = await held(svc, fake, project_dir)
    await svc.gateway.call(token, "create_note", {"title": "a"})
    await svc.gateway.call(token, "create_note", {"title": "b"})
    first, second = await svc.list_actions(run["id"])
    async with api(svc) as c:
        listed = (await c.get("/agents/actions", params={"run_id": run["id"]})).json()["actions"]
        assert [a["id"] for a in listed] == [first["id"], second["id"]] and set(listed[0]) == ACTION_KEYS
        assert (await c.get("/agents/actions", params={"run_id": "outra"})).json() == {"actions": []}
        ok = await c.post(f"/agents/actions/{first['id']}/undo")
        assert ok.status_code == 200 and ok.json()["action"]["undone_at"] and set(ok.json()) == {"action"}
        again = await c.post(f"/agents/actions/{first['id']}/undo")
        assert again.status_code == 409 and again.json()["code"] == "already_undone"
        assert (await c.post("/agents/actions/nao-existe/undo")).status_code == 404
        svc.now = lambda: datetime.now(timezone.utc) + timedelta(hours=1)
        late = await c.post(f"/agents/actions/{second['id']}/undo")
        assert late.status_code == 409 and late.json()["code"] == "undo_expired"
        svc.now = lambda: datetime.now(timezone.utc)
        (n,) = await notes.list()
        await notes.update(n.id, content="mudou")
        clash = await c.post(f"/agents/actions/{second['id']}/undo")
        assert clash.status_code == 409 and clash.json()["code"] == "undo_conflict"
    async with api(svc, token=False) as anon:  # no owner token
        assert (await anon.get("/agents/actions")).status_code == 401
        assert (await anon.post(f"/agents/actions/{second['id']}/undo")).status_code == 401
    await finish(svc, run, gate)


# -- the agent learns about an undo only at its next pause --------------------------------------------


async def test_an_undo_during_an_active_run_leaves_a_system_notice_in_its_inbox(svc, fake, project_dir, notes):
    wire(svc, fake, notes=notes)
    agent, project, run, token, gate = await held(svc, fake, project_dir)
    await svc.gateway.call(token, "create_note", {"title": "Compras"})
    (action,) = await svc.list_actions(run["id"])
    q = tap(svc)
    await svc.undo_action(action["id"])
    (notice,) = [m for m in await svc.list_messages(project["id"]) if m["author"] == "system"]
    assert notice["run_id"] == run["id"] and notice["delivery"] == "pending"
    assert "desfez uma ação sua: Criou a nota «Compras»" in notice["body"] and "foi removido" in notice["body"]
    assert (await svc.get_run(run["id"]))["inbox_count"] == 1
    assert any(f["type"] == "message" and f["message"]["author"] == "system" for f in drain(q))
    # not told in the middle of the turn: only the next pause delivers it, in the same session
    assert len(fake.calls) == 1
    fake.add(FakeTurn(events=[], final_message="Entendi."))
    done = await finish(svc, run, gate)
    assert done["status"] == "done" and [c["op"] for c in fake.calls] == ["run", "resume"]
    message = fake.calls[1]["message"]
    assert "Aviso do sistema" in message and "Criou a nota «Compras»" in message
    assert "o dono mandou" not in message  # it was not a message of the owner
    (delivered,) = [m for m in await svc.list_messages(project["id"]) if m["author"] == "system"]
    assert delivered["delivery"] == "delivered"


async def test_an_undo_after_the_run_ended_leaves_no_notice(svc, fake, project_dir, notes):
    wire(svc, fake, notes=notes)
    _, project, run, token, gate = await held(svc, fake, project_dir)
    await svc.gateway.call(token, "create_note", {"title": "x"})
    await finish(svc, run, gate)
    (action,) = await svc.list_actions(run["id"])
    await svc.undo_action(action["id"])
    assert [m for m in await svc.list_messages(project["id"]) if m["author"] == "system"] == []
    assert len(payloads(await events_of(svc, run["id"]), reason="action_undone")) == 1  # the note still lands
    assert (await svc.get_run(run["id"]))["inbox_count"] == 0


def test_a_notice_of_the_system_reads_differently_from_a_message_of_the_owner():
    system = {"author": "system", "body": "O dono desfez uma ação sua.", "created_at": "2026-11-11T12:00:00+00:00"}
    owner = {"author": "user", "body": "oi", "created_at": "2026-11-11T12:00:00+00:00"}
    only = inbox_note([system])
    assert only.startswith("AVISO DO SISTEMA: aconteceu algo") and "Aviso do sistema" in only and "o dono mandou" not in only
    mixed = inbox_note([system, owner])
    assert "o dono mandou 2 mensagens novas" in mixed and "Aviso do sistema" in mixed and "Mensagem 2" in mixed


# -- ask_owner's reply and the catalogue's guarantees -------------------------------------------------


async def test_the_reply_of_ask_owner_is_an_instruction_not_wrapped_as_data(svc, fake, project_dir):
    wire(svc, fake)
    _, _, run, token, gate = await held(svc, fake, project_dir, grants=None)
    res = await svc.gateway.call(token, "ask_owner", {"pergunta": "Qual cor?"})
    assert res["ok"] is True and DATA_OPEN not in res["content"] and "ENCERRE O SEU TURNO AGORA" in res["content"]
    assert "Qual cor?" not in res["content"]  # the question is not echoed back
    gate.set()
    await wait_run(svc, run["id"], ("parked",))  # the turn ended with a question open
    await svc.cancel_run(run["id"])


def test_no_tool_of_the_catalogue_deletes_cancels_sends_or_spends():
    writers = [t for t in catalog.TOOLS if t.level == "write"]
    assert [t.name for t in writers] == ["create_note", "update_note", "create_project_task",
                                         "update_project_task", "create_reminder"]
    status_enum = catalog.TOOL_BY_NAME["update_project_task"].input_schema["properties"]["status"]["enum"]
    assert "cancelled" not in status_enum
    assert all(t.contextual for t in writers)


def test_the_three_settings_and_their_defaults():
    s = Settings(_env_file=None)
    assert (s.agents_undo_window_s, s.agents_owner_answer_max_s, s.agents_bridge_test_timeout_s) == (300, 86400, 60)


def test_the_migration_is_idempotent_and_upgrades_an_older_database():
    conn = sqlite3.connect(":memory:")
    agents_schema.migrate(conn)
    conn.execute("DROP TABLE agent_actions")  # a database from before phase 3c
    conn.execute("ALTER TABLE agent_runs DROP COLUMN question")
    conn.execute("ALTER TABLE agent_runs DROP COLUMN questions_asked")
    conn.execute("INSERT INTO agent_runs (id, agent_id, project_id, goal, status, engine, created_at)"
                 " VALUES ('r', 'a', 'p', 'g', 'done', 'fake', 'n')")
    for _ in range(2):
        agents_schema.migrate(conn)
    cols = {r[1] for r in conn.execute("PRAGMA table_info(agent_runs)")}
    assert {"question", "questions_asked"} <= cols
    assert {r[1] for r in conn.execute("PRAGMA table_info(agent_actions)")} == {
        "id", "run_id", "agent_id", "project_id", "tool", "group_id", "label", "kind", "target_type",
        "target_id", "before_json", "fingerprint", "created_at", "undo_until", "undone_at"}
    assert conn.execute("SELECT id, questions_asked, question FROM agent_runs").fetchall() == [("r", 0, None)]
    conn.execute("INSERT INTO agent_actions (id, run_id, agent_id, project_id, tool, group_id, label, kind,"
                 " target_type, target_id, fingerprint, created_at, undo_until)"
                 " VALUES ('x', 'r', 'a', 'p', 't', 'notes', 'l', 'create', 'note', 'n', 'f', 'c', 'u')")
    agents_schema.migrate(conn)
    assert conn.execute("SELECT id FROM agent_actions").fetchall() == [("x",)]  # data survives a re-run


async def test_the_run_object_always_has_the_question_field(svc, fake, project_dir):
    agent, project = await setup_agent(svc, project_dir)
    run = await svc.start_run(agent["id"], project["id"], "x")
    assert "question" in run and run["question"] is None
    done = await wait_run(svc, run["id"], ("done",))
    assert done["question"] is None and "questions_asked" not in done
