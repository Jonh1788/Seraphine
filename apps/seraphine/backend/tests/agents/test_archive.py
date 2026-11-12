"""Phase 6c part 2: pausing and archiving agents (a paused or archived agent does not work, and that is no failure)."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

from seraphine.agents import routines
from seraphine.agents.engines.fake import FakeTurn

from .chat_helpers import DAILY, agent_obj, api, make_agent, p_update_agent, say, send
from .conftest import Brain, draft, wait_run
from .page_helpers import add_run

UTC = timezone.utc
T0 = datetime(2026, 11, 12, 13, 0, tzinfo=UTC)  # Thursday 10:00 local (UTC-3)
EVERY_15 = {"kind": "interval", "every_minutes": 15}


class Clock:
    def __init__(self, svc, start=T0):
        self.t = start
        svc.now = lambda: self.t
        svc.local_time = routines.FixedOffset(-3)

    def advance(self, **kw):
        self.t += timedelta(**kw)


async def lines(hsvc, routine_id):
    return await hsvc.list_routine_runs(routine_id, 100)


# -- archive / unarchive ---------------------------------------------------------------------------------------


async def test_new_fields_are_always_present_and_archive_restores_everything(hsvc):
    a = await make_agent(hsvc)
    assert a["archived"] is False and a["archived_at"] is None
    home = await hsvc.ensure_home(a["id"])
    code, out = await api(hsvc, "POST", f"/agents/defs/{a['id']}/archive")
    assert code == 200 and out["def"]["archived"] is True and out["def"]["archived_at"]
    assert (await hsvc.get_project(home["id"]))["archived"] is True
    stamp = out["def"]["archived_at"]
    code, again = await api(hsvc, "POST", f"/agents/defs/{a['id']}/archive")  # again: nothing changes
    assert code == 200 and again["def"]["archived_at"] == stamp
    code, back = await api(hsvc, "POST", f"/agents/defs/{a['id']}/unarchive")
    assert code == 200 and back["def"]["archived"] is False and back["def"]["archived_at"] is None
    assert (await hsvc.get_project(home["id"]))["archived"] is False
    assert (await api(hsvc, "POST", f"/agents/defs/{a['id']}/unarchive"))[0] == 200  # idempotent
    assert (await api(hsvc, "POST", "/agents/defs/nao-existe/archive"))[0] == 404
    assert (await api(hsvc, "POST", "/agents/defs/nao-existe/unarchive"))[0] == 404


async def test_archiving_changes_neither_grants_nor_engine_nor_commands(hsvc):
    a = await make_agent(hsvc, perm_commands="ask")
    await hsvc.set_grants(a["id"], {"notes": "write", "memory": "read"})
    before = await hsvc.get_def(a["id"])
    await hsvc.archive_def(a["id"])
    await hsvc.unarchive_def(a["id"])
    after = await hsvc.get_def(a["id"])
    for key in ("grants", "engine", "provider", "perm_commands", "perm_edit", "enabled", "project_ids"):
        assert after[key] == before[key]


async def test_listing_with_and_without_archived(hsvc):
    a, b = await make_agent(hsvc, "Ana"), await make_agent(hsvc, "Beto")
    await hsvc.archive_def(a["id"])
    code, out = await api(hsvc, "GET", "/agents/defs")
    assert [d["id"] for d in out["defs"]] == [b["id"]]
    code, out = await api(hsvc, "GET", "/agents/defs?include_archived=true")
    assert [(d["id"], d["archived"]) for d in out["defs"]] == [(a["id"], True), (b["id"], False)]
    assert (await api(hsvc, "GET", f"/agents/defs/{a['id']}"))[1]["def"]["archived"] is True  # still readable


async def test_archive_is_refused_while_a_run_is_in_progress(hsvc):
    a = await make_agent(hsvc)
    home = await hsvc.ensure_home(a["id"])
    gate = asyncio.Event()
    hsvc.engines["fake"].add(FakeTurn(gate=gate))
    posted = await hsvc.post_message(home["id"], "Faça algo")
    await wait_run(hsvc, posted["run"]["id"], ("running",))
    code, out = await api(hsvc, "POST", f"/agents/defs/{a['id']}/archive")
    assert code == 409 and out["code"] == "agent_busy"
    assert (await hsvc.get_def(a["id"]))["archived"] is False
    assert (await hsvc.get_project(home["id"]))["archived"] is False
    gate.set()
    await wait_run(hsvc, posted["run"]["id"], ("done",))
    assert (await api(hsvc, "POST", f"/agents/defs/{a['id']}/archive"))[0] == 200


# -- what an archived agent refuses ----------------------------------------------------------------------------


async def test_a_message_to_an_archived_agent_is_refused_without_a_run_and_without_storing(hsvc):
    a = await make_agent(hsvc)
    home = await hsvc.ensure_home(a["id"])
    await hsvc.archive_def(a["id"])
    code, out = await api(hsvc, "POST", f"/agents/projects/{home['id']}/messages", json={"body": "Oi"})
    assert code == 200 and out["error"] == "agent_archived" and "arquivado" in out["detail"]
    assert out["run"] is None and out["message"] is None and out["agent_id"] == a["id"]
    code, out = await api(hsvc, "POST", f"/agents/projects/{home['id']}/messages",
                          json={"body": "Oi", "agent_id": a["id"]})
    assert out["error"] == "agent_archived"
    assert await hsvc.list_runs(home["id"]) == [] and await hsvc.list_messages(home["id"]) == []
    await hsvc.unarchive_def(a["id"])
    out = await hsvc.post_message(home["id"], "Oi de novo")
    assert out["error"] is None and out["run"] is not None
    await wait_run(hsvc, out["run"]["id"], ("done",))


async def test_a_run_for_an_archived_agent_is_refused_and_a_paused_one_still_is(hsvc, tmp_path):
    a = await make_agent(hsvc)
    project = await hsvc.create_project(name="P", path=str(tmp_path))
    await hsvc.update_def(a["id"], project_ids=[project["id"]])
    await hsvc.archive_def(a["id"])
    code, out = await api(hsvc, "POST", "/agents/runs", json={"agent_id": a["id"], "project_id": project["id"],
                                                               "goal": "x"})
    assert code == 409 and out["code"] == "agent_archived"
    await hsvc.unarchive_def(a["id"])
    await hsvc.update_def(a["id"], enabled=False)
    code, out = await api(hsvc, "POST", "/agents/runs", json={"agent_id": a["id"], "project_id": project["id"],
                                                               "goal": "x"})
    assert code == 409 and out["code"] == "agent_disabled"


async def test_the_router_skips_an_archived_agent(hsvc, tmp_path):
    project = await hsvc.create_project(name="P", path=str(tmp_path))
    a = await make_agent(hsvc, "Redator", role="escreve textos", project_ids=[project["id"]])
    b = await make_agent(hsvc, "Outro", role="faz outra coisa", project_ids=[project["id"]])
    assert [c["id"] for c in await hsvc._candidates(project["id"])] == [a["id"], b["id"]]
    await hsvc.archive_def(a["id"])
    assert [c["id"] for c in await hsvc._candidates(project["id"])] == [b["id"]]
    assert await hsvc.pick_agent(project["id"], "escreva um texto") == b["id"]
    out = await hsvc.post_message(project["id"], "@redator escreva um texto")  # a mention does not reach it either
    assert out["agent_id"] == b["id"]
    await wait_run(hsvc, out["run"]["id"], ("done",))
    out = await hsvc.post_message(project["id"], "oi", agent_id=a["id"], mode="join")
    assert out["error"] == "agent_archived" and out["run"] is None


async def test_the_brain_is_not_given_an_archived_agent_nor_its_routines(hsvc):
    a, b = await make_agent(hsvc, "Arquivada"), await make_agent(hsvc, "Ativa")
    await hsvc.create_routine(agent_id=a["id"], title="RotinaSumida", prompt="p", schedule=DAILY)
    await hsvc.create_routine(agent_id=b["id"], title="RotinaViva", prompt="p", schedule=DAILY)
    await hsvc.archive_def(a["id"])
    brain = Brain(say())
    code, _ = await send(hsvc, None, brain=brain)
    assert code == 200
    sent = " ".join(str(getattr(m, "content", m)) for m in brain.calls[0])
    assert "Ativa" in sent and "RotinaViva" in sent
    assert "Arquivada" not in sent and "RotinaSumida" not in sent
    # a proposal aimed at the archived agent finds nothing to change
    code, out = await send(hsvc, say("Vou mudar.", p_update_agent(a["id"], role="Novo")))
    assert out["proposals"] == []


async def test_patch_ensure_home_and_new_routines_are_refused_for_an_archived_agent(hsvc):
    a = await make_agent(hsvc)
    home = await hsvc.ensure_home(a["id"])
    await hsvc.archive_def(a["id"])
    for body in ({"role": "Novo"}, {"enabled": True}, {"name": "Outro"}):
        code, out = await api(hsvc, "PATCH", f"/agents/defs/{a['id']}", json=body)
        assert code == 409 and out["code"] == "agent_archived"
    code, out = await api(hsvc, "POST", f"/agents/defs/{a['id']}/home")
    assert code == 409 and out["code"] == "agent_archived"
    assert (await hsvc.get_project(home["id"]))["archived"] is True  # the refusal left the home archived
    code, out = await api(hsvc, "POST", "/agents/routines", json={
        "agent_id": a["id"], "title": "T", "prompt": "p", "schedule": DAILY})
    assert code == 409 and out["code"] == "agent_archived"
    await hsvc.unarchive_def(a["id"])
    assert (await api(hsvc, "PATCH", f"/agents/defs/{a['id']}", json={"role": "Novo"}))[0] == 200


async def test_run_now_of_a_routine_of_an_archived_agent_is_refused_and_leaves_no_line(hsvc):
    a = await make_agent(hsvc)
    routine = await hsvc.create_routine(agent_id=a["id"], title="T", prompt="p", schedule=DAILY)
    await hsvc.archive_def(a["id"])
    code, out = await api(hsvc, "POST", f"/agents/routines/{routine['id']}/run")
    assert code == 409 and out["code"] == "agent_archived"
    assert await lines(hsvc, routine["id"]) == []
    await hsvc.unarchive_def(a["id"])
    await hsvc.update_def(a["id"], enabled=False)  # paused: still refused, as in 6b
    code, out = await api(hsvc, "POST", f"/agents/routines/{routine['id']}/run")
    assert code == 409 and out["code"] == "agent_disabled"


async def test_an_archived_name_still_blocks_a_duplicate_and_is_told_to_the_proposal_brain(hsvc):
    a = await make_agent(hsvc, "Ana")
    await hsvc.archive_def(a["id"])
    out = await hsvc.create_team("guide", [draft("ana"), draft("Beto")])
    assert [i["def"]["name"] for i in out["created"]] == ["Beto"]
    assert out["failed"] == [{"name": "ana", "detail": "Já existe um agente com esse nome."}]
    brain = Brain('{"agents": []}')
    hsvc.llm_getter = lambda: brain
    try:
        await hsvc.propose_team("um time")
    except Exception:  # noqa: BLE001 - only what the brain was told matters here
        pass
    assert "Ana" in " ".join(str(getattr(m, "content", m)) for m in brain.calls[0])
    # and an applied proposal named like the archived agent fails the same way
    code, out = await send(hsvc, say("Criar.", {"kind": "create_agents", "agents": [agent_obj("Ana")]}))
    assert code == 200
    code, applied = await api(hsvc, "POST", f"/agents/guide/proposals/{out['proposals'][0]['id']}/apply")
    assert code == 200 and applied["proposal"]["status"] == "failed"
    assert "Já existe um agente com esse nome" in applied["proposal"]["detail"]
    assert [d["name"] for d in await hsvc.list_defs(include_archived=True)] == ["Ana", "Beto"]


async def test_overview_and_active_routine_count_leave_archived_agents_out(hsvc):
    a, b = await make_agent(hsvc, "Ana"), await make_agent(hsvc, "Beto")
    await hsvc.create_routine(agent_id=a["id"], title="T", prompt="p", schedule=DAILY)
    await hsvc.create_routine(agent_id=b["id"], title="T", prompt="p", schedule=DAILY)
    assert (await hsvc.overview())["routines_active"] == 2
    await hsvc.archive_def(a["id"])
    ov = await hsvc.overview()
    assert ov["routines_active"] == 1 and [s["agent_id"] for s in ov["spend_today"]] == [b["id"]]
    assert len(await hsvc.list_routines()) == 2  # the routines themselves are kept, and listed
    await hsvc.unarchive_def(a["id"])
    assert (await hsvc.overview())["routines_active"] == 2


async def test_deleting_an_archived_agent_still_works(hsvc):
    a = await make_agent(hsvc)
    await hsvc.ensure_home(a["id"])
    await hsvc.archive_def(a["id"])
    code, _ = await api(hsvc, "DELETE", f"/agents/defs/{a['id']}")
    assert code == 200 and await hsvc.get_def(a["id"]) is None


# -- routines of a paused or archived agent ---------------------------------------------------------------------


async def test_routine_times_of_a_paused_agent_are_skipped_and_resume_when_it_is_back(hsvc):
    clock = Clock(hsvc)
    a = await make_agent(hsvc)
    routine = await hsvc.create_routine(agent_id=a["id"], title="T", prompt="Liste.", schedule=EVERY_15)
    await hsvc.update_def(a["id"], enabled=False)
    for _ in range(3):
        clock.advance(minutes=15, seconds=1)
        assert await hsvc.tick() == 1
    got = await hsvc.get_routine(routine["id"])
    assert got["consecutive_failures"] == 0 and got["enabled"] is True and got["paused_reason"] is None
    assert [(x["status"], x["detail"]) for x in await lines(hsvc, routine["id"])] == [
        ("skipped", "O agente está pausado.")] * 3
    await hsvc.update_def(a["id"], enabled=True)
    clock.advance(minutes=15, seconds=1)
    assert await hsvc.tick() == 1
    ledger = await lines(hsvc, routine["id"])
    assert ledger[0]["run_id"] is not None
    await wait_run(hsvc, ledger[0]["run_id"], ("done",))


async def test_routine_times_of_an_archived_agent_are_skipped_without_touching_the_failure_counter(hsvc):
    clock = Clock(hsvc)
    a = await make_agent(hsvc)
    on = await hsvc.create_routine(agent_id=a["id"], title="Ligada", prompt="p", schedule=EVERY_15)
    off = await hsvc.create_routine(agent_id=a["id"], title="Pausada", prompt="p", schedule=EVERY_15, enabled=False)
    await hsvc._db(lambda c: c.execute("UPDATE agent_routines SET consecutive_failures = 2 WHERE id = ?", (on["id"],)))
    await hsvc.archive_def(a["id"])
    for _ in range(6):  # more than the pause threshold of 5
        clock.advance(minutes=15, seconds=1)
        assert await hsvc.tick() == 1
    got = await hsvc.get_routine(on["id"])
    assert got["consecutive_failures"] == 2 and got["enabled"] is True and got["paused_reason"] is None
    ledger = await lines(hsvc, on["id"])
    assert len(ledger) == 6 and {(x["status"], x["detail"], x["run_id"]) for x in ledger} == {
        ("skipped", "O agente está arquivado.", None)}
    assert await lines(hsvc, off["id"]) == [] and (await hsvc.get_routine(off["id"]))["enabled"] is False
    assert await hsvc.list_runs() == []
    home_id = (await hsvc.get_def(a["id"]))["home_project_id"]
    assert [m for m in await hsvc.list_messages(home_id) if m["author"] == "system"] == []
    # restored: the routine that was on runs again, the one that was off stays off
    await hsvc.unarchive_def(a["id"])
    clock.advance(minutes=15, seconds=1)
    assert await hsvc.tick() == 1
    ledger = await lines(hsvc, on["id"])
    assert ledger[0]["run_id"] is not None
    await wait_run(hsvc, ledger[0]["run_id"], ("done",))
    assert (await hsvc.get_routine(off["id"]))["enabled"] is False
    assert (await hsvc.get_routine(on["id"]))["paused_reason"] is None


async def test_a_one_shot_whose_time_passes_while_the_agent_is_paused_is_skipped_and_switches_off(hsvc):
    clock = Clock(hsvc)
    a = await make_agent(hsvc)
    when = routines.FixedOffset(-3).to_local(T0 + timedelta(minutes=30)).strftime("%Y-%m-%dT%H:%M")
    routine = await hsvc.create_routine(agent_id=a["id"], title="Uma vez", prompt="p",
                                        schedule={"kind": "once", "at": when})
    await hsvc.update_def(a["id"], enabled=False)
    clock.advance(minutes=31)
    await hsvc.tick()
    got = await hsvc.get_routine(routine["id"])
    assert got["enabled"] is False and got["next_run_at"] is None and got["consecutive_failures"] == 0
    assert got["paused_reason"] is None and got["last_status"] == "skipped"
    assert [(x["status"], x["detail"]) for x in await lines(hsvc, routine["id"])] == [
        ("skipped", "O agente está pausado.")]


async def test_an_agent_paused_after_the_clock_looked_skips_instead_of_failing(hsvc):
    """The race of ``_start_line``: the agent was paused between the look at the clock and the start."""
    a = await make_agent(hsvc)
    routine = await hsvc.create_routine(agent_id=a["id"], title="T", prompt="p", schedule=EVERY_15)
    await hsvc.update_def(a["id"], enabled=False)
    line_id = "linha-1"
    await hsvc._db(lambda c: c.execute(
        "INSERT INTO agent_routine_runs (id, routine_id, scheduled_for, fired_by, status, created_at)"
        " VALUES (?, ?, '2026-11-12T13:00:00+00:00', 'schedule', 'running', '2026-11-12T13:00:00+00:00')",
        (line_id, routine["id"])))
    assert await hsvc._start_line(routine, line_id, "2026-11-12T13:00:00+00:00", "schedule") is None
    got = (await lines(hsvc, routine["id"]))[0]
    assert got["status"] == "skipped" and got["detail"] == "O agente está pausado."
    assert (await hsvc.get_routine(routine["id"]))["consecutive_failures"] == 0


async def test_a_run_row_added_by_hand_does_not_break_archiving(hsvc):
    """A finished run is history: it does not stop an archive (only an active one does)."""
    a = await make_agent(hsvc)
    home = await hsvc.ensure_home(a["id"])
    await add_run(hsvc, a["id"], home["id"], created_at="2026-11-12T10:00:00+00:00", status="done")
    assert (await hsvc.archive_def(a["id"]))["archived"] is True
    await hsvc.unarchive_def(a["id"])
    await add_run(hsvc, a["id"], home["id"], created_at="2026-11-12T11:00:00+00:00", status="parked")
    code, out = await api(hsvc, "POST", f"/agents/defs/{a['id']}/archive")
    assert code == 409 and out["code"] == "agent_busy"
