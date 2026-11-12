"""Phase 1b: park instead of fail (outage, plan limit, expired login).

Time never passes for real: the service's ``now`` is a clock the tests move, and
``wake_due_runs`` is the sweep the periodic loop and the boot call.
"""

from __future__ import annotations

import asyncio
import os
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from seraphine.agents import schema as agents_schema
from seraphine.agents.engines.fake import FakeEngine, FakeTurn
from seraphine.agents.errors import Conflict, NotFound
from seraphine.agents.providers import ProviderRegistry, reason_is_auth
from seraphine.agents.routes import TOKEN_HEADER, router
from seraphine.agents.service import AgentHarnessService

from .conftest import make_settings, setup_agent, wait_run, wait_until

BASE = datetime(2026, 11, 11, 12, 0, tzinfo=timezone.utc)
MIN = timedelta(minutes=1)
WAIT_FIELDS = {"wait_kind", "wait_until", "wait_since", "wait_attempts", "wait_detail", "wait_exact"}
AUTH_REASON = "Codex não está conectado (rode `codex login`)"


class Clock:
    def __init__(self) -> None:
        self.t = BASE

    def __call__(self) -> datetime:
        return self.t


def at(iso: str) -> datetime:
    return datetime.fromisoformat(iso)


def started(call_id: str = "c1") -> tuple[str, dict]:
    return ("step", {"type": "command", "phase": "started", "call_id": call_id,
                     "command": "npm run migrate", "by": "agent"})


def failing(kind: str, retry_at: datetime | None = None, **kw: Any) -> FakeTurn:
    """A turn that produces nothing and fails with a classified reason."""
    kw.setdefault("events", [])
    return FakeTurn(fail_kind=kind, fail_retry_at=retry_at.isoformat() if retry_at else None, **kw)


async def build(store, clock: Clock, project_dir: Path, sweep_s: float | None = None,
                **settings: Any) -> SimpleNamespace:
    engine = FakeEngine()
    svc = AgentHarnessService(store, make_settings(**settings), engines={"fake": engine})
    svc.now = clock
    if sweep_s is not None:
        svc.approval_sweep_s = sweep_s
    await svc.start()
    agent, project = await setup_agent(svc, project_dir)
    return SimpleNamespace(svc=svc, engine=engine, clock=clock, agent=agent, project=project, store=store)


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
async def env(store, clock: Clock, project_dir: Path):
    e = await build(store, clock, project_dir)
    yield e
    await e.svc.stop()


async def start(env, goal: str = "migre o banco", agent: dict | None = None) -> dict:
    return await env.svc.start_run((agent or env.agent)["id"], env.project["id"], goal)


async def events(env, rid: str, kind: str | None = None, **match: Any) -> list[dict]:
    return [e for e in await env.svc.list_events(rid, limit=100_000)
            if (kind is None or e["kind"] == kind)
            and all(e["payload"].get(k) == v for k, v in match.items())]


async def channel(env) -> list[dict]:
    return [m for m in await env.svc.list_messages(env.project["id"]) if m["author"] == env.agent["id"]]


async def park_cycle(env, rid: str) -> dict:
    """Move the clock to the run's ``wait_until``, sweep, and wait for the next stop."""
    run = await env.svc.get_run(rid)
    env.clock.t = at(run["wait_until"])
    await env.svc.wake_due_runs()
    return await wait_run(env.svc, rid, ("parked", "failed", "done"))


# -- each reason parks ---------------------------------------------------------------------


@pytest.mark.parametrize("kind,hint,until,phrases", [
    ("outage", None, BASE + 2 * MIN, ["fora do ar", "tento de novo", "24 horas"]),
    ("plan_limit", BASE + timedelta(hours=3), BASE + timedelta(hours=3),
     ["limite de uso do plano", "volta sozinho", "renovar"]),
    ("plan_limit", None, BASE + 30 * MIN, ["não foi informado", "30 minutos", "24 horas"]),
    ("auth", None, None, ["login", "em espera", "peça para tentar de novo", "24 horas"]),
])
async def test_each_reason_parks_with_fields_events_and_one_channel_message(
        env, kind: str, hint, until, phrases: list[str]):
    env.engine.add(failing(kind, hint))
    run = await start(env)
    parked = await wait_run(env.svc, run["id"], ("parked",))
    assert parked["wait_kind"] == kind and parked["wait_attempts"] == 1
    assert at(parked["wait_since"]) == BASE
    assert (at(parked["wait_until"]) == until) if until else parked["wait_until"] is None
    assert parked["error"] is None and parked["finished_at"] is None
    (status,) = await events(env, run["id"], "status", status="parked")
    assert status["payload"] == {"status": "parked", "wait_kind": kind,
                                 "wait_until": parked["wait_until"], "wait_attempts": 1,
                                 "wait_detail": parked["wait_detail"], "wait_exact": parked["wait_exact"]}
    (note,) = await events(env, run["id"], "step", reason="parked")
    assert note["payload"]["type"] == "note" and note["payload"]["text"].startswith("Em espera")
    (message,) = await channel(env)
    assert message["run_id"] == run["id"]
    for phrase in phrases:
        assert phrase in message["body"], phrase
    assert (await env.svc.overview())["active_runs"][0]["id"] == run["id"]


async def test_unknown_errors_still_fail(env):
    env.engine.add(FakeTurn(fail="algo estranho"))
    failed = await wait_run(env.svc, (await start(env))["id"], ("failed",))
    assert failed["error"] == "engine_error" and failed["wait_kind"] is None
    env.engine.add(FakeTurn(fail_kind="inventado", events=[]))  # not one of the three reasons
    failed = await wait_run(env.svc, (await start(env))["id"], ("failed",))
    assert failed["error"] == "engine_error"
    assert not any(e["payload"].get("status") == "parked" for e in await events(env, failed["id"], "status"))


async def test_engine_auth_error_code_alone_parks_as_auth(env):
    env.engine.add(FakeTurn(fail="sem login", fail_code="engine_auth", events=[]))
    parked = await wait_run(env.svc, (await start(env))["id"], ("parked",))
    assert parked["wait_kind"] == "auth" and parked["wait_until"] is None


@pytest.mark.parametrize("kind", ["outage", "plan_limit", "auth"])
async def test_an_open_action_fails_with_interrupted_mid_action_and_never_parks(env, kind: str):
    env.engine.add(failing(kind, events=[started("c1")]))
    failed = await wait_run(env.svc, (await start(env))["id"], ("failed", "parked"))
    assert failed["status"] == "failed" and failed["error"] == "interrupted_mid_action"
    assert failed["can_continue"] is False and failed["wait_kind"] is None
    assert await events(env, failed["id"], "status", status="parked") == []
    (message,) = await channel(env)
    assert "npm run migrate" in message["body"] and "pela metade" in message["body"]


async def test_a_closed_action_does_not_block_parking(env):
    done = ("command", {"command": "ls", "exit_code": 0, "output": "", "by": "agent",
                        "phase": "completed", "call_id": "c1"})
    env.engine.add(failing("outage", events=[started("c1"), done]))
    assert (await wait_run(env.svc, (await start(env))["id"], ("failed", "parked")))["status"] == "parked"


# -- the waiting rules -----------------------------------------------------------------------


async def test_outage_ladder_then_gives_up_after_24_hours(env):
    for _ in range(40):
        env.engine.add(failing("outage"))
    run = await start(env)
    state = await wait_run(env.svc, run["id"], ("parked",))
    waits: list[tuple[int, timedelta]] = []
    while state["status"] == "parked":
        waits.append((state["wait_attempts"], at(state["wait_until"]) - env.clock.t))
        state = await park_cycle(env, run["id"])
    assert [d for _, d in waits[:4]] == [2 * MIN, 15 * MIN, 30 * MIN, 60 * MIN]
    assert all(d == 60 * MIN for _, d in waits[4:-1]) and waits[-1][1] <= 60 * MIN  # hourly, last one cut at 24 h
    assert [n for n, _ in waits] == list(range(1, len(waits) + 1))
    assert state["status"] == "failed" and state["error"] == "provider_unavailable"
    assert env.clock.t == BASE + timedelta(hours=24)
    bodies = [m["body"] for m in await channel(env)]
    assert len(bodies) == 2  # the first parking and the give-up: intermediate tries are silent
    assert "Desisti" in bodies[1] and "24 horas" in bodies[1]
    assert len(await events(env, run["id"], "status", status="parked")) == len(waits)


async def test_plan_limit_with_a_reset_waits_until_it_then_continues(env):
    reset = BASE + timedelta(hours=5)
    env.engine.add(failing("plan_limit", reset))
    env.engine.add(FakeTurn(final_message="pronto"))
    run = await start(env)
    parked = await wait_run(env.svc, run["id"], ("parked",))
    assert at(parked["wait_until"]) == reset
    env.clock.t = reset - timedelta(seconds=1)
    assert await env.svc.wake_due_runs() == 0
    assert (await env.svc.get_run(run["id"]))["status"] == "parked"
    env.clock.t = reset
    assert await env.svc.wake_due_runs() == 1
    done = await wait_run(env.svc, run["id"], ("done",))
    assert done["result_summary"] == "pronto"
    assert (await events(env, run["id"], "status", reason="woke"))[0]["payload"] == {
        "status": "queued", "reason": "woke", "by": "timer"}


async def test_plan_limit_without_a_reset_polls_every_30_minutes_and_gives_up_after_24_hours(env):
    for _ in range(3):
        env.engine.add(failing("plan_limit"))
    run = await start(env)
    state = await wait_run(env.svc, run["id"], ("parked",))
    for attempt in (1, 2, 3):
        assert state["wait_attempts"] == attempt
        assert at(state["wait_until"]) - env.clock.t == 30 * MIN
        if attempt < 3:
            state = await park_cycle(env, run["id"])
    env.clock.t = BASE + timedelta(hours=24)
    await env.svc.wake_due_runs()
    failed = await env.svc.get_run(run["id"])
    assert failed["status"] == "failed" and failed["error"] == "plan_limit"
    assert "limite de uso do plano" in (await channel(env))[-1]["body"]


async def test_plan_limit_reset_is_capped_at_8_days(env):
    env.engine.add(failing("plan_limit", BASE + timedelta(days=20)))
    run = await start(env)
    parked = await wait_run(env.svc, run["id"], ("parked",))
    assert at(parked["wait_until"]) == BASE + timedelta(days=8)
    env.clock.t = BASE + timedelta(days=8) - MIN
    assert await env.svc.wake_due_runs() == 0
    env.clock.t = BASE + timedelta(days=8)
    await env.svc.wake_due_runs()
    failed = await env.svc.get_run(run["id"])
    assert failed["status"] == "failed" and failed["error"] == "plan_limit"
    assert "8 dias" in (await channel(env))[-1]["body"]


async def test_a_reset_that_is_already_past_is_not_retried_at_once(env):
    env.engine.add(failing("plan_limit", BASE - 10 * MIN))
    parked = await wait_run(env.svc, (await start(env))["id"], ("parked",))
    assert at(parked["wait_until"]) == BASE + MIN


async def test_auth_never_wakes_by_itself_wakes_for_the_owner_and_expires_after_24_hours(env):
    env.engine.add(failing("auth"))
    env.engine.add(FakeTurn(final_message="ok"))
    run = await start(env)
    parked = await wait_run(env.svc, run["id"], ("parked",))
    assert parked["wait_until"] is None
    env.clock.t = BASE + timedelta(hours=23, minutes=59)
    assert await env.svc.wake_due_runs() == 0
    assert (await env.svc.get_run(run["id"]))["status"] == "parked"
    woken = await env.svc.wake_run(run["id"])
    assert woken["status"] != "parked" and woken["wait_kind"] is None and woken["wait_attempts"] == 0
    await wait_run(env.svc, run["id"], ("done",))
    assert (await events(env, run["id"], "status", reason="woke"))[0]["payload"]["by"] == "owner"


async def test_auth_expires_with_engine_auth_after_24_hours(env):
    env.engine.add(failing("auth"))
    run = await start(env)
    await wait_run(env.svc, run["id"], ("parked",))
    env.clock.t = BASE + timedelta(hours=24)
    await env.svc.wake_due_runs()
    failed = await env.svc.get_run(run["id"])
    assert failed["status"] == "failed" and failed["error"] == "engine_auth"
    assert failed["wait_kind"] is None and failed["wait_attempts"] == 0
    bodies = [m["body"] for m in await channel(env)]
    assert len(bodies) == 2 and "Desisti" in bodies[1] and "login" in bodies[1]


async def test_auth_that_is_still_broken_after_the_owner_tries_keeps_the_clock(env):
    env.engine.add(failing("auth"))
    env.engine.add(failing("auth"))
    run = await start(env)
    await wait_run(env.svc, run["id"], ("parked",))
    env.clock.t = BASE + timedelta(hours=2)
    await env.svc.wake_run(run["id"])
    again = await wait_run(env.svc, run["id"], ("parked",))
    assert again["wait_attempts"] == 2 and at(again["wait_since"]) == BASE  # still the same sequence
    assert len(await channel(env)) == 1  # no second "first time" message


async def test_the_ladder_resets_once_the_engine_produces_something(env):
    env.engine.add(failing("outage"))
    env.engine.add(FakeTurn(fail_kind="outage"))  # default events: the engine did something first
    env.engine.add(failing("outage"))
    run = await start(env)
    first = await wait_run(env.svc, run["id"], ("parked",))
    assert first["wait_attempts"] == 1
    second = await park_cycle(env, run["id"])
    assert second["wait_attempts"] == 1 and at(second["wait_since"]) == env.clock.t  # a new sequence
    assert at(second["wait_until"]) - env.clock.t == 2 * MIN
    assert len(await channel(env)) == 2  # the first parking of each sequence says so
    third = await park_cycle(env, run["id"])  # nothing produced this time: the ladder climbs
    assert third["wait_attempts"] == 2 and at(third["wait_since"]) == at(second["wait_since"])
    assert at(third["wait_until"]) - env.clock.t == 15 * MIN


async def test_another_reason_starts_a_new_sequence(env):
    env.engine.add(failing("outage"))
    env.engine.add(failing("plan_limit"))
    run = await start(env)
    await wait_run(env.svc, run["id"], ("parked",))
    second = await park_cycle(env, run["id"])
    assert second["wait_kind"] == "plan_limit" and second["wait_attempts"] == 1
    assert len(await channel(env)) == 2


# -- waking: resume or start over ----------------------------------------------------------------


async def test_waking_by_timer_resumes_the_session_when_the_engine_had_produced_something(env):
    env.engine.add(FakeTurn(fail_kind="outage"))  # default events: reasoning + a command
    env.engine.add(FakeTurn(final_message="terminei"))
    run = await start(env)
    parked = await wait_run(env.svc, run["id"], ("parked",))
    env.clock.t = at(parked["wait_until"])
    await env.svc.wake_due_runs()
    done = await wait_run(env.svc, run["id"], ("done",))
    assert [c["op"] for c in env.engine.calls] == ["run", "resume"]
    call = env.engine.calls[1]
    assert call["session_ref"] == parked["session_ref"]
    for text in ("provedor voltou", "migre o banco", "continua feito", "Não repita ações já concluídas"):
        assert text in call["message"], text
    assert done["recoveries"] == 0 and done["result_summary"] == "terminei"
    (woke,) = await events(env, run["id"], "status", reason="woke")
    assert woke["payload"] == {"status": "queued", "reason": "woke", "by": "timer"}
    (note,) = await events(env, run["id"], "step", reason="woke")
    assert note["payload"]["type"] == "note" and "retomando" in note["payload"]["text"]
    assert "fresh_restart" not in note["payload"]
    assert (await env.svc._raw_run(run["id"]))["resume_note"] is None  # delivered once


async def test_waking_for_the_owner_starts_over_when_the_engine_had_produced_nothing(env):
    env.engine.add(failing("outage"))
    env.engine.add(FakeTurn(final_message="comecei"))
    run = await start(env)
    parked = await wait_run(env.svc, run["id"], ("parked",))
    first_session = parked["session_ref"]
    assert first_session
    await env.svc.wake_run(run["id"])
    done = await wait_run(env.svc, run["id"], ("done",))
    assert [c["op"] for c in env.engine.calls] == ["run", "run"]  # not a resume
    prompt = env.engine.calls[1]["ctx"].prompt
    assert prompt.startswith("AVISO DO SISTEMA")
    assert "o dono pediu para tentar de novo" in prompt and "Comece agora, do início" in prompt
    assert "migre o banco" in prompt and "POLÍTICA DE SEGURANÇA" in prompt  # the whole prompt
    assert done["session_ref"] != first_session and done["recoveries"] == 0
    (note,) = await events(env, run["id"], "step", reason="woke")
    assert "do zero" in note["payload"]["text"] and note["payload"]["fresh_restart"] is True
    (woke,) = await events(env, run["id"], "status", reason="woke")
    assert woke["payload"]["by"] == "owner"


async def test_waking_after_a_plan_limit_or_login_says_why_in_the_note(env):
    env.engine.add(FakeTurn(fail_kind="plan_limit"))
    env.engine.add(FakeTurn(final_message="ok"))
    run = await start(env)
    await wait_run(env.svc, run["id"], ("parked",))
    await env.svc.wake_run(run["id"])
    await wait_run(env.svc, run["id"], ("done",))
    assert "limite de uso do plano" in env.engine.calls[1]["message"]
    assert "o dono pediu para tentar de novo" in env.engine.calls[1]["message"]


async def test_wake_on_a_run_that_is_not_parked(env):
    run = await start(env)
    await wait_run(env.svc, run["id"], ("done",))
    with pytest.raises(Conflict) as exc:
        await env.svc.wake_run(run["id"])
    assert exc.value.code == "not_parked"
    with pytest.raises(NotFound):
        await env.svc.wake_run("nao-existe")


async def test_the_owner_waking_and_the_timer_cannot_both_win(env):
    env.engine.add(failing("outage"))
    run = await start(env)
    parked = await wait_run(env.svc, run["id"], ("parked",))
    env.clock.t = at(parked["wait_until"])
    results = await asyncio.gather(env.svc.wake_run(run["id"]), env.svc.wake_due_runs(),
                                   return_exceptions=True)
    assert sum(1 for r in results if isinstance(r, dict) or r == 1) == 1
    await wait_run(env.svc, run["id"], ("done",))
    assert len(await events(env, run["id"], "status", reason="woke")) == 1


# -- cancel -----------------------------------------------------------------------------------


async def test_cancel_a_parked_run(env):
    env.engine.add(failing("outage"))
    run = await start(env)
    parked = await wait_run(env.svc, run["id"], ("parked",))
    cancelled = await env.svc.cancel_run(run["id"])
    assert cancelled["status"] == "cancelled" and cancelled["finished_at"]
    assert cancelled["wait_kind"] is None and cancelled["wait_attempts"] == 0
    assert cancelled["can_continue"] is True
    assert (await events(env, run["id"], "status", status="cancelled"))
    env.clock.t = at(parked["wait_until"]) + timedelta(hours=30)
    assert await env.svc.wake_due_runs() == 0  # nothing revives it
    assert (await env.svc.get_run(run["id"]))["status"] == "cancelled"
    with pytest.raises(Conflict):
        await env.svc.wake_run(run["id"])


# -- the scheduler ----------------------------------------------------------------------------


async def test_a_parked_run_holds_no_global_slot_but_keeps_its_agent_busy(store, clock, project_dir: Path):
    env = await build(store, clock, project_dir, agents_max_concurrent=1)
    try:
        other = await env.svc.create_def(name="Rev", engine="fake", project_ids=[env.project["id"]])
        env.engine.add(failing("outage", when="tarefa-um"))
        a1 = await start(env, "tarefa-um")
        await wait_run(env.svc, a1["id"], ("parked",))
        a2 = await start(env, "tarefa-dois")
        b1 = await start(env, "tarefa-b", agent=other)
        await wait_run(env.svc, b1["id"], ("done",))  # the only global slot was free
        await asyncio.sleep(0.2)
        assert (await env.svc.get_run(a2["id"]))["status"] == "queued"  # behind its parked run
        assert "tarefa-dois" not in " ".join(c["ctx"].prompt for c in env.engine.calls)
        await env.svc.cancel_run(a1["id"])
        await wait_run(env.svc, a2["id"], ("done",))
    finally:
        await env.svc.stop()


async def test_a_woken_run_goes_through_the_queue_like_any_other(store, clock, project_dir: Path):
    env = await build(store, clock, project_dir, agents_max_concurrent=1)
    try:
        other = await env.svc.create_def(name="Rev", engine="fake", project_ids=[env.project["id"]])
        gate = asyncio.Event()
        env.engine.add(failing("outage", when="tarefa-um"))
        env.engine.add(FakeTurn(gate=gate, when="tarefa-b"))
        a1 = await start(env, "tarefa-um")
        await wait_run(env.svc, a1["id"], ("parked",))
        b1 = await start(env, "tarefa-b", agent=other)
        await wait_until(lambda: env.engine.active == 1)
        await env.svc.wake_run(a1["id"])
        await asyncio.sleep(0.2)
        assert (await env.svc.get_run(a1["id"]))["status"] == "queued"  # the one slot is taken
        gate.set()
        await wait_run(env.svc, b1["id"], ("done",))
        await wait_run(env.svc, a1["id"], ("done",))
    finally:
        await env.svc.stop()


# -- a restart ---------------------------------------------------------------------------------


async def test_a_parked_run_is_untouched_by_a_restart_and_woken_by_the_new_process_when_due(
        store, clock, project_dir: Path):
    s1 = await build(store, clock, project_dir)
    s1.engine.add(failing("outage"))
    run = await start(s1)
    parked = await wait_run(s1.svc, run["id"], ("parked",))
    await s1.svc.stop()

    engine2 = FakeEngine(turns=[FakeTurn(final_message="voltei")])
    s2 = AgentHarnessService(store, make_settings(), engines={"fake": engine2})
    s2.now = clock  # not due yet
    await s2.start()
    try:
        r = await s2.get_run(run["id"])
        assert r["status"] == "parked" and r["error"] is None and r["recoveries"] == 0
        assert (r["wait_kind"], r["wait_attempts"], r["wait_until"], r["wait_since"]) == (
            "outage", 1, parked["wait_until"], parked["wait_since"])
        assert engine2.calls == []
    finally:
        await s2.stop()

    clock.t = at(parked["wait_until"]) + MIN
    engine3 = FakeEngine(turns=[FakeTurn(final_message="voltei")])
    s3 = AgentHarnessService(store, make_settings(), engines={"fake": engine3})
    s3.now = clock
    await s3.start()
    try:
        done = await wait_run(s3, run["id"], ("done",))
        assert done["recoveries"] == 0 and [c["op"] for c in engine3.calls] == ["run"]
        (woke,) = [e for e in await s3.list_events(run["id"])
                   if e["kind"] == "status" and e["payload"].get("reason") == "woke"]
        assert woke["payload"]["by"] == "timer"
    finally:
        await s3.stop()


async def test_the_periodic_sweep_wakes_due_runs(store, clock, project_dir: Path):
    env = await build(store, clock, project_dir, sweep_s=0.05)
    try:
        env.engine.add(failing("outage"))
        run = await start(env)
        parked = await wait_run(env.svc, run["id"], ("parked",))
        env.clock.t = at(parked["wait_until"])
        await wait_run(env.svc, run["id"], ("done",))  # nobody called the sweep: the loop did
    finally:
        await env.svc.stop()


# -- pre-run checks ----------------------------------------------------------------------------


async def _blocked_second_run(env, reason: str) -> dict:
    """Run 1 holds the agent; the engine breaks; run 2 starts with the engine unusable."""
    gate = asyncio.Event()
    env.engine.add(FakeTurn(gate=gate, when="primeira"))
    first = await start(env, "primeira")
    await wait_until(lambda: env.engine.active == 1)
    second = await start(env, "segunda")
    env.engine._ok, env.engine._reason = False, reason
    gate.set()
    await wait_run(env.svc, first["id"], ("done",))
    return second


async def test_pre_run_auth_problem_parks_and_waking_continues(env):
    second = await _blocked_second_run(env, AUTH_REASON)
    parked = await wait_run(env.svc, second["id"], ("parked", "failed"))
    assert parked["status"] == "parked" and parked["wait_kind"] == "auth"
    assert len(env.engine.started) == 1  # only the first run ever reached the engine
    env.engine._ok, env.engine._reason = True, "ok"
    await env.svc.wake_run(second["id"])
    await wait_run(env.svc, second["id"], ("done",))
    assert "segunda" in env.engine.calls[-1]["ctx"].prompt


async def test_pre_run_problems_that_are_not_about_login_still_fail(env):
    second = await _blocked_second_run(env, "Codex CLI não encontrado neste computador")
    failed = await wait_run(env.svc, second["id"], ("parked", "failed"))
    assert failed["status"] == "failed" and failed["error"] == "engine_unavailable"


def test_which_provider_reasons_count_as_login_problems():
    assert reason_is_auth("provedor OpenRouter: falta a chave OPENROUTER_API_KEY no .env do backend")
    assert reason_is_auth("provedor OpenAI (login do Codex): Codex não está conectado (rode `codex login`)")
    assert reason_is_auth("Claude Code não está conectado (rode `claude auth login`)")
    assert not reason_is_auth("Codex não encontrado neste computador")
    assert not reason_is_auth("o servidor de Ollama não está respondendo")
    assert not reason_is_auth("")


async def test_codex_plan_logged_out_before_the_run_parks_as_auth(store, project_dir: Path):
    logged_in = [True]
    t = [0.0]

    async def probe(which: str):
        return (True, "") if logged_in[0] else (False, AUTH_REASON)

    reg = ProviderRegistry(make_settings(), cli_probe=probe, clock=lambda: t[0])
    codex = FakeEngine("codex")
    svc = AgentHarnessService(store, make_settings(), engines={"codex": codex}, providers=reg)
    await svc.start()
    try:
        agent, project = await setup_agent(svc, project_dir, engine="codex")
        gate = asyncio.Event()
        codex.add(FakeTurn(gate=gate, when="primeira"))
        first = await svc.start_run(agent["id"], project["id"], "primeira")
        await wait_until(lambda: codex.active == 1)
        second = await svc.start_run(agent["id"], project["id"], "segunda")
        logged_in[0] = False
        t[0] += 100  # the cached probe result expires
        gate.set()
        await wait_run(svc, first["id"], ("done",))
        parked = await wait_run(svc, second["id"], ("parked", "failed"))
        assert parked["status"] == "parked" and parked["wait_kind"] == "auth"
        (message,) = [m for m in await svc.list_messages(project["id"]) if m["run_id"] == second["id"]]
        assert "entrar de novo no Codex" in message["body"] and "`" not in message["body"]
        logged_in[0] = True
        t[0] += 100
        await svc.wake_run(second["id"])
        await wait_run(svc, second["id"], ("done",))
    finally:
        await svc.stop()


# -- approvals ---------------------------------------------------------------------------------


def _once_command(output: str = "") -> str:
    tail = f"; Write-Output {output}" if output and os.name == "nt" else f"; echo {output}" if output else ""
    base = "Add-Content -Path once.txt -Value x" if os.name == "nt" else "echo x >> once.txt"
    return base + tail


async def _waiting_with_approval(env, command: str) -> tuple[dict, dict]:
    env.engine.add(FakeTurn(final_message="Preciso rodar.",
                            approval={"title": "Gravar", "command": command, "reason": "r"}))
    run = await start(env, "x")
    await wait_run(env.svc, run["id"], ("waiting_approval",))
    (ap,) = await env.svc.list_approvals(status="pending")
    return run, ap


async def test_a_decision_not_yet_delivered_when_the_run_parks_is_delivered_after_waking(env):
    run, ap = await _waiting_with_approval(env, _once_command())
    env.engine._ok, env.engine._reason = False, AUTH_REASON
    await env.svc.decide_approval(ap["id"], "approve", digest=ap["command_digest"], confirm_high_risk=True)
    parked = await wait_run(env.svc, run["id"], ("parked", "failed"))
    assert parked["status"] == "parked" and parked["wait_kind"] == "auth"
    marker = Path(env.project["path"]) / "once.txt"
    assert not marker.exists()
    assert (await env.svc.get_approval(ap["id"]))["output"] is None  # still to be delivered
    env.engine._ok, env.engine._reason = True, "ok"
    env.engine.add(FakeTurn(final_message="feito"))
    await env.svc.wake_run(run["id"])
    await wait_run(env.svc, run["id"], ("done",))
    assert marker.read_text().split() == ["x"]  # ran exactly once
    assert env.engine.calls[-1]["op"] == "resume" and "APROVOU" in env.engine.calls[-1]["message"]


async def test_a_command_that_ran_before_the_outage_is_not_run_again_and_its_result_is_told(env):
    run, ap = await _waiting_with_approval(env, _once_command("saida-estacionada"))
    env.engine.add(failing("outage"))  # the resume that delivers the result hits an outage
    env.engine.add(FakeTurn(final_message="ok"))
    await env.svc.decide_approval(ap["id"], "approve", digest=ap["command_digest"], confirm_high_risk=True)
    parked = await wait_run(env.svc, run["id"], ("parked", "failed"))
    assert parked["status"] == "parked" and parked["wait_kind"] == "outage"
    marker = Path(env.project["path"]) / "once.txt"
    assert marker.read_text().split() == ["x"]
    assert "saida-estacionada" in ((await env.svc.get_approval(ap["id"]))["output"] or "")
    env.clock.t = at(parked["wait_until"])
    await env.svc.wake_due_runs()
    await wait_run(env.svc, run["id"], ("done",))
    assert marker.read_text().split() == ["x"]  # never twice
    call = env.engine.calls[-1]
    assert call["op"] == "resume" and call["session_ref"] == parked["session_ref"]
    assert "saida-estacionada" in call["message"] and "APROVOU" not in call["message"]


# -- the run object everywhere ---------------------------------------------------------------


async def test_new_fields_are_present_in_rest_run_update_frames_and_overview(env):
    frames: list[dict] = []

    async def listen() -> None:
        async for evt in env.svc.subscribe_all():
            frames.append(evt)

    listener = asyncio.create_task(listen())
    await asyncio.sleep(0.05)
    env.engine.add(failing("plan_limit", BASE + timedelta(hours=1)))
    run = await start(env)
    parked = await wait_run(env.svc, run["id"], ("parked",))
    overview = await env.svc.overview()
    listing = await env.svc.list_runs(status="parked")
    await env.svc.wake_run(run["id"])
    done = await wait_run(env.svc, run["id"], ("done",))
    listener.cancel()
    await asyncio.gather(listener, return_exceptions=True)
    updates = [f["run"] for f in frames if f.get("type") == "run_update"]
    assert updates and all(WAIT_FIELDS <= set(r) for r in updates)
    assert "wait_deadline" not in parked
    park_frame = next(r for r in updates if r["status"] == "parked")
    assert (park_frame["wait_kind"], park_frame["wait_attempts"]) == ("plan_limit", 1)
    assert at(park_frame["wait_until"]) == BASE + timedelta(hours=1) and park_frame["wait_since"]
    assert [r["id"] for r in overview["active_runs"]] == [run["id"]] == [r["id"] for r in listing]
    assert overview["active_runs"][0]["wait_kind"] == "plan_limit"
    assert (done["wait_kind"], done["wait_until"], done["wait_since"], done["wait_attempts"]) == (None, None, None, 0)
    assert all(WAIT_FIELDS <= set(r) for r in overview["active_runs"] + listing)


@pytest.fixture
def app(env) -> FastAPI:
    a = FastAPI()
    a.include_router(router)
    a.state.agent_harness = env.svc
    return a


async def test_wake_and_cancel_routes(app: FastAPI, env):
    gate = asyncio.Event()
    env.engine.add(failing("outage"))
    env.engine.add(failing("auth", gate=gate))  # holds the woken run so the second wake is refused
    run = await start(env)
    await wait_run(env.svc, run["id"], ("parked",))
    h = {TOKEN_HEADER: env.svc.token}
    transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 50000))
    async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8000") as c:
        missing = await c.post("/agents/runs/nao-existe/wake", headers=h)
        assert missing.status_code == 404 and missing.headers["cache-control"] == "no-store"
        assert (await c.post(f"/agents/runs/{run['id']}/wake")).status_code == 401
        ok = await c.post(f"/agents/runs/{run['id']}/wake", headers=h)
        assert ok.status_code == 200 and ok.headers["cache-control"] == "no-store"
        woken = ok.json()["run"]
        assert woken["id"] == run["id"] and woken["status"] in ("queued", "running") and WAIT_FIELDS <= set(woken)
        assert woken["wait_kind"] is None and woken["wait_attempts"] == 0
        again = await c.post(f"/agents/runs/{run['id']}/wake", headers=h)
        assert again.status_code == 409 and again.json()["code"] == "not_parked" and "detail" in again.json()
        gate.set()

        parked = await wait_run(env.svc, run["id"], ("parked",))  # the second scripted failure (auth)
        assert parked["wait_kind"] == "auth"
        got = (await c.get(f"/agents/runs/{run['id']}", headers=h)).json()["run"]
        assert got["status"] == "parked" and got["wait_kind"] == "auth" and got["wait_until"] is None
        cancelled = await c.post(f"/agents/runs/{run['id']}/cancel", headers=h)
        assert cancelled.status_code == 200 and cancelled.json()["run"]["status"] == "cancelled"
        listing = (await c.get("/agents/overview", headers=h)).json()["active_runs"]
        assert listing == []


# -- settings and schema -------------------------------------------------------------------------


def test_settings_declare_the_three_parking_limits_and_the_service_reads_them(store):
    from seraphine.config import Settings

    s = Settings()
    assert (s.agents_park_max_s, s.agents_park_plan_poll_s, s.agents_park_plan_max_s) == (86400, 1800, 691200)
    assert Settings(agents_park_max_s=600).agents_park_max_s == 600
    svc = AgentHarnessService(store, make_settings(agents_park_max_s=600, agents_park_plan_poll_s=60,
                                                   agents_park_plan_max_s=1200), engines={})
    assert (svc.park_max_s, svc.park_plan_poll_s, svc.park_plan_max_s) == (600, 60, 1200)
    default = AgentHarnessService(store, make_settings(), engines={})
    assert (default.park_max_s, default.park_plan_poll_s, default.park_plan_max_s) == (86400, 1800, 691200)


async def test_the_limits_come_from_the_settings(store, clock: Clock, project_dir: Path):
    env = await build(store, clock, project_dir, agents_park_max_s=600, agents_park_plan_poll_s=120)
    try:
        for _ in range(3):
            env.engine.add(failing("plan_limit"))
        run = await start(env)
        parked = await wait_run(env.svc, run["id"], ("parked",))
        assert at(parked["wait_until"]) == BASE + 2 * MIN
        state = await park_cycle(env, run["id"])
        assert at(state["wait_until"]) - env.clock.t == 2 * MIN
        env.clock.t = BASE + 10 * MIN
        await env.svc.wake_due_runs()
        assert (await env.svc.get_run(run["id"]))["error"] == "plan_limit"
    finally:
        await env.svc.stop()


def test_migration_adds_the_parking_columns_and_is_idempotent(tmp_path: Path):
    db = tmp_path / "old.sqlite"
    conn = sqlite3.connect(db)
    conn.execute(
        "CREATE TABLE agent_runs (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, project_id TEXT NOT NULL,"
        " task_id TEXT, goal TEXT NOT NULL, status TEXT NOT NULL, engine TEXT NOT NULL, session_ref TEXT,"
        " requested_by TEXT NOT NULL DEFAULT 'user', result_summary TEXT, error TEXT, exit_code INTEGER,"
        " tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,"
        " cost_usd REAL NOT NULL DEFAULT 0, approvals_used INTEGER NOT NULL DEFAULT 0,"
        " created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT)")
    conn.execute("INSERT INTO agent_runs (id, agent_id, project_id, goal, status, engine, created_at)"
                 " VALUES ('r1', 'a', 'p', 'g', 'queued', 'codex', '2026-01-01')")
    conn.commit()
    agents_schema.migrate(conn)
    agents_schema.migrate(conn)
    cols = {r[1] for r in conn.execute("PRAGMA table_info(agent_runs)")}
    assert {"wait_kind", "wait_until", "wait_since", "wait_attempts", "wait_deadline",
            "wait_detail", "wait_exact"} <= cols
    assert conn.execute("SELECT wait_kind, wait_until, wait_since, wait_attempts, wait_detail, wait_exact"
                        " FROM agent_runs WHERE id = 'r1'").fetchone() == (None, None, None, 0, None, 0)
    conn.close()


# -- parked at creation (login / credential missing) ------------------------------------------


KEY_REASON = "provedor OpenRouter: falta a chave OPENROUTER_API_KEY no .env do backend"


def block(env, reason: str = AUTH_REASON) -> None:
    env.engine._ok, env.engine._reason = False, reason


async def assert_created_parked(env, run: dict) -> dict:
    assert run["status"] == "parked" and run["wait_kind"] == "auth" and run["wait_until"] is None
    assert run["wait_attempts"] == 1 and run["session_ref"] is None
    assert env.engine.calls == []  # no engine call
    assert len([m for m in await channel(env) if m["run_id"] == run["id"]]) == 1
    (note,) = await events(env, run["id"], "step", reason="parked")
    (status,) = await events(env, run["id"], "status", status="parked")
    assert status["payload"]["wait_detail"] == run["wait_detail"] and status["payload"]["wait_exact"] is False
    return run


async def test_creation_parks_for_auth_via_start_run_message_task_and_continue(env):
    block(env)
    run = await assert_created_parked(env, await start(env))
    await env.svc.cancel_run(run["id"])

    out = await env.svc.post_message(env.project["id"], "oi", agent_id=env.agent["id"])
    assert out["error"] is None
    await assert_created_parked(env, out["run"])
    await env.svc.cancel_run(out["run"]["id"])

    task = await env.svc.create_task(project_id=env.project["id"], title="T", assignee_agent_id=env.agent["id"])
    await assert_created_parked(env, await env.svc.run_task(task["id"]))


async def test_creation_parks_for_auth_on_continue(env):
    gate = asyncio.Event()
    env.engine.add(FakeTurn(gate=gate))
    old = await start(env)
    await wait_until(lambda: env.engine.active == 1)
    await env.svc.cancel_run(old["id"])
    calls = len(env.engine.calls)
    block(env)
    new = await env.svc.continue_run(old["id"])
    assert new["status"] == "parked" and new["wait_kind"] == "auth" and new["continued_from"] == old["id"]
    assert len(env.engine.calls) == calls
    assert len([m for m in await channel(env) if m["run_id"] == new["id"]]) == 1


async def test_creation_with_another_unavailability_is_still_refused(env):
    block(env, "Codex CLI não encontrado neste computador")
    with pytest.raises(Conflict) as exc:
        await start(env)
    assert exc.value.code == "engine_unavailable"
    out = await env.svc.post_message(env.project["id"], "oi", agent_id=env.agent["id"])
    assert out["run"] is None and out["error"] == "engine_unavailable"


async def test_fallback_is_used_before_parking_and_a_blocked_fallback_decides(store, project_dir: Path):
    primary, backup = FakeEngine(ok=False, reason=AUTH_REASON), FakeEngine("fake2")
    svc = AgentHarnessService(store, make_settings(), engines={"fake": primary, "fake2": backup})
    await svc.start()
    try:
        agent, project = await setup_agent(svc, project_dir, fallback_engine="fake2")
        run = await svc.start_run(agent["id"], project["id"], "x")
        assert run["engine"] == "fake2" and run["status"] != "parked"
        await wait_run(svc, run["id"], ("done",))
        backup._ok, backup._reason = False, "Codex CLI não encontrado neste computador"
        with pytest.raises(Conflict):  # the fallback is blocked for a non-login reason: refused
            await svc.start_run(agent["id"], project["id"], "y")
        backup._reason = AUTH_REASON
        parked = await svc.start_run(agent["id"], project["id"], "z")
        assert parked["status"] == "parked" and parked["engine"] == "fake"
    finally:
        await svc.stop()


async def test_waking_a_creation_parked_run_starts_from_scratch_and_a_still_blocked_wake_keeps_the_clock(env):
    block(env)
    run = await start(env)
    since = run["wait_since"]
    env.clock.t = BASE + timedelta(hours=2)
    await env.svc.wake_run(run["id"])  # still blocked: parks again, same sequence
    again = await wait_run(env.svc, run["id"], ("parked",))
    assert again["wait_attempts"] == 2 and again["wait_since"] == since
    assert len(await channel(env)) == 1 and env.engine.calls == []
    env.engine._ok, env.engine._reason = True, "ok"
    await env.svc.wake_run(run["id"])
    done = await wait_run(env.svc, run["id"], ("done",))
    assert [c["op"] for c in env.engine.calls] == ["run"]
    prompt = env.engine.calls[0]["ctx"].prompt
    assert "migre o banco" in prompt and "Comece agora, do início" in prompt and "POLÍTICA DE SEGURANÇA" in prompt
    assert done["wait_detail"] is None and done["wait_exact"] is False


# -- wait_detail and wait_exact ------------------------------------------------------------------


async def test_wait_detail_for_each_reason_and_null_outside_parked(env):
    env.engine.add(failing("outage"))
    outage = await wait_run(env.svc, (await start(env))["id"], ("parked",))
    assert "não respondeu" in outage["wait_detail"] and outage["wait_exact"] is False
    await env.svc.cancel_run(outage["id"])
    env.engine.add(failing("plan_limit"))
    plan = await wait_run(env.svc, (await start(env))["id"], ("parked",))
    assert plan["wait_detail"] == "O limite de uso do plano acabou." and plan["wait_exact"] is False
    await env.svc.cancel_run(plan["id"])
    env.engine.add(failing("plan_limit", BASE + timedelta(hours=2)))
    exact = await wait_run(env.svc, (await start(env))["id"], ("parked",))
    assert exact["wait_exact"] is True and "renovar" in exact["wait_detail"]
    await env.svc.cancel_run(exact["id"])
    env.engine.add(failing("plan_limit", BASE - 10 * MIN))  # clamped, so not the reported time
    assert (await wait_run(env.svc, (await start(env))["id"], ("parked",)))["wait_exact"] is False
    assert (await env.svc.get_run(exact["id"]))["wait_detail"] is None  # cancelled: null outside parked
    assert (await env.svc.get_run(exact["id"]))["wait_exact"] is False


async def test_wait_detail_for_auth_names_the_engine_or_the_key_and_has_no_commands(env):
    block(env, AUTH_REASON)
    login = await start(env)
    assert "entrar de novo" in login["wait_detail"] and "`" not in login["wait_detail"]
    assert "rode" not in login["wait_detail"]
    body = (await channel(env))[0]["body"]
    assert "`" not in body and "terminal" not in body and "peça para tentar de novo" in body
    await env.svc.cancel_run(login["id"])
    block(env, KEY_REASON)
    key = await start(env)
    assert "OPENROUTER_API_KEY" in key["wait_detail"] and ".env" in key["wait_detail"] and "`" not in key["wait_detail"]
    await env.svc.cancel_run(key["id"])
    env.engine._ok, env.engine._reason = True, "ok"
    env.engine.add(failing("auth"))  # at execution time (the engine says so)
    during = await wait_run(env.svc, (await start(env))["id"], ("parked",))
    assert "entrar de novo" in during["wait_detail"]
