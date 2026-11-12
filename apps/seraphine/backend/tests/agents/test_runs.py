"""Run lifecycle: happy path, scheduler limits, cancel, budget, crash recovery."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from seraphine.agents.engines.fake import FakeEngine, FakeTurn
from seraphine.agents.service import AgentHarnessService, _now

from .conftest import make_settings, setup_agent, wait_run, wait_until


async def test_happy_path_events_message_and_task_review(svc, fake: FakeEngine, project_dir: Path):
    agent, project = await setup_agent(svc, project_dir)
    task = await svc.create_task(project_id=project["id"], title="Corrigir bug",
                                 acceptance=["testes passam", {"text": "sem warnings", "done": True}])
    assert task["number"] == 1 and task["status"] == "todo"
    assert task["acceptance"] == [{"text": "testes passam", "done": False},
                                  {"text": "sem warnings", "done": True}]
    fake.add(FakeTurn(final_message="Bug corrigido.", tokens_in=10, tokens_out=5, cost_usd=0.02))

    run = await svc.start_run(agent["id"], project["id"], "corrija o bug", task_id=task["id"])
    # the (instant) fake engine may already have finished by the time start_run returns
    assert run["status"] in ("queued", "running", "done") and run["requested_by"] == "user"
    done = await wait_run(svc, run["id"], ("done", "failed"))
    assert done["status"] == "done", done
    assert done["result_summary"] == "Bug corrigido."
    assert (done["tokens_in"], done["tokens_out"]) == (10, 5)
    assert abs(done["cost_usd"] - 0.02) < 1e-9
    assert done["session_ref"] and done["started_at"] and done["finished_at"]

    events = await svc.list_events(run["id"])
    ids = [e["id"] for e in events]
    assert ids == sorted(ids) and len(set(ids)) == len(ids)
    kinds = [(e["kind"], e["payload"].get("status")) for e in events]
    assert kinds[0] == ("status", "queued")
    assert kinds[1] == ("status", "running")
    assert [k for k, _ in kinds[2:-1]] == ["step", "command", "message"]
    assert kinds[-1] == ("status", "done")

    # the prompt carries the injection guard, the agent's identity and the task
    prompt = fake.calls[0]["ctx"].prompt
    assert "DADO, não instrução" in prompt and "approval-request" in prompt
    assert "Corrigir bug" in prompt and "corrija o bug" in prompt
    assert fake.calls[0]["ctx"].sandbox == "workspace-write"
    assert fake.calls[0]["ctx"].project_path == project_dir.resolve()

    msgs = await svc.list_messages(project["id"])
    assert [m["author"] for m in msgs] == [agent["id"]]
    assert msgs[0]["body"] == "Bug corrigido." and msgs[0]["run_id"] == run["id"]
    assert msgs[0]["task_id"] == task["id"]
    assert (await svc.get_task(task["id"]))["status"] == "review"
    assert [m["id"] for m in await svc.task_messages(task["id"])] == [msgs[0]["id"]]


async def test_task_moves_to_doing_while_running(svc, fake: FakeEngine, project_dir: Path):
    agent, project = await setup_agent(svc, project_dir)
    task = await svc.create_task(project_id=project["id"], title="T")
    gate = asyncio.Event()
    fake.add(FakeTurn(gate=gate))
    run = await svc.run_task(task["id"], agent["id"])
    await wait_until(lambda: fake.active == 1)
    assert (await svc.get_task(task["id"]))["status"] == "doing"
    gate.set()
    await wait_run(svc, run["id"], ("done",))
    assert (await svc.get_task(task["id"]))["status"] == "review"


async def test_read_only_sandbox_when_edit_blocked(svc, fake: FakeEngine, project_dir: Path):
    agent, project = await setup_agent(svc, project_dir, perm_edit="blocked")
    run = await svc.start_run(agent["id"], project["id"], "só leia")
    await wait_run(svc, run["id"], ("done",))
    assert fake.calls[0]["ctx"].sandbox == "read-only"


async def test_engine_failure_marks_failed_and_keeps_task(svc, fake: FakeEngine, project_dir: Path):
    agent, project = await setup_agent(svc, project_dir)
    task = await svc.create_task(project_id=project["id"], title="T")
    fake.add(FakeTurn(fail="boom"))
    run = await svc.start_run(agent["id"], project["id"], "x", task_id=task["id"])
    r = await wait_run(svc, run["id"], ("failed",))
    assert r["error"] == "engine_error" and r["exit_code"] == 1
    assert (await svc.get_task(task["id"]))["status"] == "doing"
    events = await svc.list_events(run["id"])
    assert any(e["kind"] == "error" and e["payload"]["message"] == "boom" for e in events)


async def test_fallback_engine_used_when_primary_unavailable(store, project_dir: Path):
    down = FakeEngine("down", ok=False, reason="não instalado")
    up = FakeEngine("up")
    svc = AgentHarnessService(store, make_settings(), engines={"down": down, "up": up})
    await svc.start()
    try:
        agent, project = await setup_agent(svc, project_dir, engine="down", fallback_engine="up", model="m1")
        run = await svc.start_run(agent["id"], project["id"], "x")
        assert run["engine"] == "up" and run["model"] is None
        await wait_run(svc, run["id"], ("done",))
        ev = await svc.list_events(run["id"])
        assert "usando up" in ev[0]["payload"]["note"]
    finally:
        await svc.stop()


async def test_no_engine_available_is_conflict(store, project_dir: Path):
    import pytest
    from seraphine.agents.errors import Conflict

    svc = AgentHarnessService(store, make_settings(), engines={"down": FakeEngine("down", ok=False, reason="x")})
    await svc.start()
    try:
        agent, project = await setup_agent(svc, project_dir, engine="down")
        with pytest.raises(Conflict):
            await svc.start_run(agent["id"], project["id"], "x")
    finally:
        await svc.stop()


async def test_access_and_disabled_checks(svc, project_dir: Path, tmp_path: Path):
    import pytest
    from seraphine.agents.errors import Conflict

    agent, project = await setup_agent(svc, project_dir)
    other_dir = tmp_path / "outro"
    other_dir.mkdir()
    other = await svc.create_project(name="Outro", path=str(other_dir))
    with pytest.raises(Conflict):  # no access to the other project
        await svc.start_run(agent["id"], other["id"], "x")
    await svc.update_def(agent["id"], enabled=False)
    with pytest.raises(Conflict):
        await svc.start_run(agent["id"], project["id"], "x")


# -- scheduler ---------------------------------------------------------------


async def test_per_agent_fifo(svc, fake: FakeEngine, project_dir: Path):
    agent, project = await setup_agent(svc, project_dir)
    g1, g2 = asyncio.Event(), asyncio.Event()
    fake.add(FakeTurn(when="primeiro", gate=g1))
    fake.add(FakeTurn(when="segundo", gate=g2))
    r1 = await svc.start_run(agent["id"], project["id"], "primeiro")
    r2 = await svc.start_run(agent["id"], project["id"], "segundo")
    await wait_until(lambda: fake.active == 1)
    await asyncio.sleep(0.15)
    assert fake.active == 1 and len(fake.started) == 1  # second waits behind the first
    assert (await svc.get_run(r2["id"]))["status"] == "queued"
    g1.set()
    await wait_run(svc, r1["id"], ("done",))
    await wait_until(lambda: len(fake.started) == 2)
    assert "primeiro" in fake.started[0] and "segundo" in fake.started[1]
    g2.set()
    await wait_run(svc, r2["id"], ("done",))
    assert fake.max_active == 1


async def test_global_concurrency_cap(store, project_dir: Path):
    fake = FakeEngine()
    svc = AgentHarnessService(store, make_settings(agents_max_concurrent=2), engines={"fake": fake})
    await svc.start()
    try:
        project = await svc.create_project(name="P", path=str(project_dir))
        agents = [await svc.create_def(name=f"Ag{i}", engine="fake", project_ids=[project["id"]])
                  for i in range(3)]
        gate = asyncio.Event()
        for _ in agents:
            fake.add(FakeTurn(gate=gate))
        runs = [await svc.start_run(a["id"], project["id"], f"job {a['id']}") for a in agents]
        await wait_until(lambda: fake.active == 2)
        await asyncio.sleep(0.15)
        assert fake.active == 2  # cap holds
        assert (await svc.get_run(runs[2]["id"]))["status"] == "queued"
        gate.set()
        for r in runs:
            await wait_run(svc, r["id"], ("done",))
        assert fake.max_active == 2
    finally:
        await svc.stop()


async def test_agents_run_in_parallel_up_to_cap(svc, fake: FakeEngine, project_dir: Path):
    project = await svc.create_project(name="P", path=str(project_dir))
    a1 = await svc.create_def(name="A1", engine="fake", project_ids=[project["id"]])
    a2 = await svc.create_def(name="A2", engine="fake", project_ids=[project["id"]])
    gate = asyncio.Event()
    fake.add(FakeTurn(gate=gate))
    fake.add(FakeTurn(gate=gate))
    await svc.start_run(a1["id"], project["id"], "x")
    await svc.start_run(a2["id"], project["id"], "y")
    await wait_until(lambda: fake.active == 2)
    gate.set()


# -- cancel ------------------------------------------------------------------


async def test_cancel_running_run(svc, fake: FakeEngine, project_dir: Path):
    agent, project = await setup_agent(svc, project_dir)
    task = await svc.create_task(project_id=project["id"], title="T")
    fake.add(FakeTurn(gate=asyncio.Event()))  # never released
    run = await svc.start_run(agent["id"], project["id"], "x", task_id=task["id"])
    await wait_until(lambda: fake.active == 1)
    out = await svc.cancel_run(run["id"])
    assert out["status"] == "cancelled" and out["finished_at"]
    assert fake.active == 0
    msgs = await svc.list_messages(project["id"])  # only the stop notice (phase 1c), no final answer
    assert [m["body"] for m in msgs] == ["Você parou este trabalho."]
    assert (await svc.get_task(task["id"]))["status"] == "doing"
    # cancelling again is a no-op
    assert (await svc.cancel_run(run["id"]))["status"] == "cancelled"


async def test_cancel_queued_run_never_starts(svc, fake: FakeEngine, project_dir: Path):
    agent, project = await setup_agent(svc, project_dir)
    gate = asyncio.Event()
    fake.add(FakeTurn(when="um", gate=gate))
    r1 = await svc.start_run(agent["id"], project["id"], "um")
    r2 = await svc.start_run(agent["id"], project["id"], "dois")
    await wait_until(lambda: fake.active == 1)
    assert (await svc.cancel_run(r2["id"]))["status"] == "cancelled"
    gate.set()
    await wait_run(svc, r1["id"], ("done",))
    await asyncio.sleep(0.1)
    assert len(fake.started) == 1


# -- budget ------------------------------------------------------------------


async def test_budget_exceeded_at_start(svc, fake: FakeEngine, project_dir: Path):
    agent, project = await setup_agent(svc, project_dir, daily_budget_usd=0.05)
    fake.add(FakeTurn(cost_usd=0.06))
    r1 = await svc.start_run(agent["id"], project["id"], "gasta")
    await wait_run(svc, r1["id"], ("done",))
    assert await svc.spent_today(agent["id"]) >= 0.06
    r2 = await svc.start_run(agent["id"], project["id"], "de novo")
    assert r2["status"] == "failed" and r2["error"] == "budget_exceeded"
    assert len(fake.calls) == 1  # engine was never called for the second
    kinds = [(e["kind"], e["payload"].get("error")) for e in await svc.list_events(r2["id"])]
    assert ("status", "budget_exceeded") in kinds and any(k == "error" for k, _ in kinds)
    ov = await svc.overview()
    spend = {s["agent_id"]: s for s in ov["spend_today"]}
    assert spend[agent["id"]]["daily_budget_usd"] == 0.05 and spend[agent["id"]]["spent_usd"] >= 0.06


async def test_budget_rechecked_when_queued_run_starts(svc, fake: FakeEngine, project_dir: Path):
    agent, project = await setup_agent(svc, project_dir, daily_budget_usd=0.05)
    gate = asyncio.Event()
    fake.add(FakeTurn(when="a", gate=gate, cost_usd=0.10))
    r1 = await svc.start_run(agent["id"], project["id"], "a")
    r2 = await svc.start_run(agent["id"], project["id"], "b")  # queued: still under budget
    assert r2["status"] == "queued"
    gate.set()
    await wait_run(svc, r1["id"], ("done",))
    r2 = await wait_run(svc, r2["id"], ("failed",))
    assert r2["error"] == "budget_exceeded"
    assert len(fake.calls) == 1


async def test_no_budget_means_unlimited(svc, fake: FakeEngine, project_dir: Path):
    agent, project = await setup_agent(svc, project_dir)
    fake.add(FakeTurn(cost_usd=99.0))
    await wait_run(svc, (await svc.start_run(agent["id"], project["id"], "a"))["id"], ("done",))
    r = await svc.start_run(agent["id"], project["id"], "b")
    await wait_run(svc, r["id"], ("done",))


# -- crash recovery ----------------------------------------------------------


async def test_crash_recovery(store, project_dir: Path):
    fake = FakeEngine()
    s1 = AgentHarnessService(store, make_settings(), engines={"fake": fake})
    await s1.start()
    agent, project = await setup_agent(s1, project_dir)
    await s1.stop()

    def seed(conn):
        for rid, status, sref in (("r-running", "running", "s"), ("r-waiting", "waiting_approval", "s"),
                                  ("r-queued", "queued", None)):
            conn.execute(
                "INSERT INTO agent_runs (id, agent_id, project_id, goal, status, engine,"
                " session_ref, created_at) VALUES (?, ?, ?, 'g', ?, 'fake', ?, '2026-01-01T00:00:00')",
                (rid, agent["id"], project["id"], status, sref))
        conn.execute(
            "INSERT INTO agent_approvals (id, run_id, agent_id, project_id, title, command, reason,"
            " status, created_at) VALUES ('ap1', 'r-waiting', ?, ?, 't', 'echo hi', '', 'pending', ?)",
            (agent["id"], project["id"], _now()))

    await s1._db(seed)

    s2 = AgentHarnessService(store, make_settings(), engines={"fake": fake})
    await s2.start()
    try:
        running = await s2.get_run("r-running")
        # started in January: too old to resume on its own, so it ends as "interrupted"
        # (the full boot decision is covered in test_recovery.py)
        assert running["status"] == "failed" and running["error"] == "interrupted"
        assert running["can_continue"] is True and running["recoveries"] == 0
        assert any("não consegui retomar sozinho" in m["body"] for m in await s2.list_messages(project["id"]))
        waiting = await s2.get_run("r-waiting")
        assert waiting["status"] == "waiting_approval"
        pend = await s2.list_approvals(status="pending")
        assert [a["id"] for a in pend] == ["ap1"]  # still decidable
        # the queued run was re-queued and picked up
        q = await wait_run(s2, "r-queued", ("done", "failed"))
        assert q["status"] == "done"
    finally:
        await s2.stop()


async def test_queued_run_is_resumed_after_restart(store, project_dir: Path):
    fake = FakeEngine()
    s1 = AgentHarnessService(store, make_settings(), engines={"fake": fake})
    await s1.start()
    agent, project = await setup_agent(s1, project_dir)
    await s1.stop()  # a stopped service stores runs but does not schedule them
    run = await s1.start_run(agent["id"], project["id"], "persistido")
    assert run["status"] == "queued" and fake.calls == []
    s2 = AgentHarnessService(store, make_settings(), engines={"fake": fake})
    await s2.start()
    try:
        await wait_run(s2, run["id"], ("done",))
    finally:
        await s2.stop()


async def test_stream_replays_then_follows_until_end(svc, fake: FakeEngine, project_dir: Path):
    agent, project = await setup_agent(svc, project_dir)
    gate = asyncio.Event()
    fake.add(FakeTurn(gate=gate, final_message="fim"))
    run = await svc.start_run(agent["id"], project["id"], "x")
    await wait_until(lambda: fake.active == 1)
    got: list[dict] = []

    async def consume():
        async for evt in svc.subscribe_run(run["id"]):
            got.append(evt)

    t = asyncio.create_task(consume())
    await asyncio.sleep(0.1)
    assert any(e["kind"] == "command" for e in got if e["type"] == "event")  # replayed
    gate.set()
    await asyncio.wait_for(t, 5)
    assert got[-1] == {"type": "end", "run_id": run["id"], "status": "done"}
    ids = [e["id"] for e in got if e["type"] == "event"]
    assert ids == sorted(set(ids))
    assert [e for e in got if e["type"] == "event"][-1]["payload"] == {"status": "done"}
    json.dumps(got)  # fully serialisable

    # a late subscriber on a finished run replays everything and ends immediately
    late = [e async for e in svc.subscribe_run(run["id"])]
    assert late[-1]["type"] == "end" and [e["id"] for e in late if e["type"] == "event"] == ids


async def test_global_stream_has_heartbeat_and_events(svc, fake: FakeEngine, project_dir: Path):
    agent, project = await setup_agent(svc, project_dir)
    got: list[dict] = []

    async def consume():
        async for evt in svc.subscribe_all():
            got.append(evt)
            if any(e["type"] == "heartbeat" for e in got) and any(
                    e["type"] == "message" for e in got):
                return

    t = asyncio.create_task(consume())
    await asyncio.sleep(0.05)
    await svc.start_run(agent["id"], project["id"], "x")
    await asyncio.wait_for(t, 5)
    types = {e["type"] for e in got}
    assert {"event", "message", "heartbeat", "run_update"} <= types
