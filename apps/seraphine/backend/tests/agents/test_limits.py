"""Phase 1d: run limits (actions, silence, turn duration, stuck loop) and the read-only boot rule.

The watchdog reads ``svc.clock``; tests replace it with a clock they move by hand (and a
short ``watchdog_poll_s``), so nothing waits for real time.
"""

from __future__ import annotations

import asyncio
import sqlite3
from pathlib import Path
from typing import Any

import pytest

from seraphine.agents import schema as agents_schema
from seraphine.agents import service as service_module
from seraphine.agents.engines.fake import (
    FakeEngine, FakeTurn, command_events, failing_actions, many_actions, repeated_action,
)
from seraphine.agents.errors import Conflict
from seraphine.agents.service import AgentHarnessService, LIMIT_CODES, _Active

from .conftest import make_settings, setup_agent, wait_run, wait_until
from .test_recovery import gated, interrupted_run, partial, service, started


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t

    def jump(self, seconds: float) -> None:
        self.t += seconds


@pytest.fixture
def clock(svc: AgentHarnessService) -> Clock:
    c = Clock()
    svc.clock = c
    svc.watchdog_poll_s = 0.01
    svc.silence_s = 30.0
    svc.turn_max_s = 600.0
    return c


async def start(svc: AgentHarnessService, fake: FakeEngine, project_dir: Path, *turns: FakeTurn,
                goal: str = "faça o trabalho") -> tuple[dict, dict, dict]:
    agent, project = await setup_agent(svc, project_dir)
    for t in turns:
        fake.add(t)
    run = await svc.start_run(agent["id"], project["id"], goal)
    return agent, project, run


async def notes(svc: AgentHarnessService, run_id: str, reason: str) -> list[dict]:
    return [e["payload"] for e in await svc.list_events(run_id, limit=100_000)
            if e["kind"] == "step" and e["payload"].get("reason") == reason]


async def agent_messages(svc: AgentHarnessService, project: dict, agent: dict) -> list[str]:
    return [m["body"] for m in await svc.list_messages(project["id"]) if m["author"] == agent["id"]]


def terminal_statuses(events: list[dict]) -> list[str]:
    return [e["payload"]["status"] for e in events
            if e["kind"] == "status" and e["payload"].get("status") in ("done", "failed", "cancelled")]


# -- counting actions --------------------------------------------------------------------


async def test_a_started_completed_pair_counts_once_in_rest_frames_and_overview(svc, fake, project_dir):
    frames: list[dict] = []

    async def listen() -> None:
        async for evt in svc.subscribe_all():
            frames.append(evt)

    listener = asyncio.create_task(listen())
    await asyncio.sleep(0.05)
    events = many_actions(3, paired=True) + command_events("single", call_id=None) \
        + command_events("single 2", call_id=None)
    _, _, run = await start(svc, fake, project_dir, FakeTurn(events=events, gate=asyncio.Event()))
    await wait_until(lambda: fake.active == 1)
    await wait_until(lambda: len([f for f in frames if f.get("type") == "run_update"
                                  and f["run"]["actions_count"] == 5]) >= 1)
    assert (await svc.get_run(run["id"]))["actions_count"] == 5  # 3 pairs + 2 single events
    assert (await svc.list_runs())[0]["actions_count"] == 5
    assert [r["actions_count"] for r in (await svc.overview())["active_runs"]] == [5]
    updates = [f["run"] for f in frames if f.get("type") == "run_update"]
    assert updates and all("actions_count" in r for r in updates)
    assert [r["actions_count"] for r in updates if r["status"] == "running"][-1] == 5
    await svc.cancel_run(run["id"])
    listener.cancel()
    await asyncio.gather(listener, return_exceptions=True)
    assert (await svc.get_run(run["id"]))["actions_count"] == 5


async def test_a_run_with_no_actions_shows_zero(svc, fake, project_dir):
    agent, project, run = await start(svc, fake, project_dir, FakeTurn(events=[], final_message="só texto"))
    done = await wait_run(svc, run["id"], ("done",))
    assert done["actions_count"] == 0


# -- the action cap ----------------------------------------------------------------------


async def test_warning_two_before_the_cap_then_step_limit_with_channel_message_and_continue(
        svc, fake, project_dir):
    svc.max_actions = 5
    events = [("message", {"text": "Parcial: li os arquivos A e B"})] + many_actions(8)
    agent, project, run = await start(svc, fake, project_dir, FakeTurn(events=events))
    failed = await wait_run(svc, run["id"], ("failed",))
    assert failed["error"] == "step_limit" and failed["actions_count"] == 5  # the 6th was cut
    assert failed["can_continue"] is True and fake.active == 0

    all_events = await svc.list_events(run["id"], limit=100_000)
    (warning,) = await notes(svc, run["id"], "limit_warning")
    assert warning == {"type": "note", "reason": "limit_warning",
                       "text": "Atenção: faltam 2 ações para o limite de 5 por execução. "
                               "Ao chegar lá, o trabalho é encerrado."}
    ids = {name: next(e["id"] for e in all_events if e["payload"].get("command") == name)
           for name in ("cmd-3", "cmd-4")}
    warn_id = next(e["id"] for e in all_events if e["payload"].get("reason") == "limit_warning")
    assert ids["cmd-3"] < warn_id < ids["cmd-4"]  # right after the 3rd action (5 - 2)
    (stop,) = await notes(svc, run["id"], "limit_stop")
    assert stop["limit"] == "step_limit" and "5 ações" in stop["text"]
    assert terminal_statuses(all_events) == ["failed"]

    body = (await agent_messages(svc, project, agent))[-1]
    assert body.startswith("Parei: esta execução chegou ao limite de 5 ações")
    assert "Já tinha feito 5 ações" in body and "Parcial: li os arquivos A e B" in body
    assert "peça para continuar" in body and "pela metade" not in body  # single-event actions: none open

    # No scripted events: the default turn runs an action of its own, which would be counted
    # (correctly) by the new run before ``continue_run`` returns its row.
    fake.add(FakeTurn(events=[], final_message="retomei"))
    new = await svc.continue_run(run["id"])
    assert new["continued_from"] == run["id"], new
    assert new["actions_count"] == 0, new
    await wait_run(svc, new["id"], ("done",))
    (resume,) = [c for c in fake.calls if c["op"] == "resume"]
    assert resume["session_ref"] == failed["session_ref"]
    assert "limite de ações por execução" in resume["message"] and "faça o trabalho" in resume["message"]
    assert (await svc.get_run(run["id"]))["can_continue"] is False


async def test_exactly_the_cap_of_actions_may_finish_normally(svc, fake, project_dir):
    svc.max_actions = 5
    _, _, run = await start(svc, fake, project_dir, FakeTurn(events=many_actions(5)))
    done = await wait_run(svc, run["id"], ("done", "failed"))
    assert done["status"] == "done" and done["actions_count"] == 5


async def test_the_warning_is_sent_once_and_not_for_a_tiny_cap(svc, fake, project_dir):
    svc.max_actions = 2
    _, _, run = await start(svc, fake, project_dir, FakeTurn(events=many_actions(2)))
    await wait_run(svc, run["id"], ("done",))
    assert await notes(svc, run["id"], "limit_warning") == []


async def test_the_count_carries_over_a_turn_that_resumes_the_run(svc, fake, project_dir):
    svc.max_actions = 6
    agent, project, run = await start(svc, fake, project_dir, FakeTurn(events=many_actions(2)))
    await wait_run(svc, run["id"], ("done",))
    # a second turn of the SAME run (inbox delivered at the end of the turn) keeps counting
    fake.turns.clear()
    gate = asyncio.Event()
    fake.add(FakeTurn(events=many_actions(2), gate=gate, final_message="parte 1"))
    fake.add(FakeTurn(events=many_actions(5, paired=True), final_message="parte 2"))
    run2 = (await svc.post_message(project["id"], "outra", agent_id=agent["id"]))["run"]
    await wait_until(lambda: fake.active == 1)
    await svc.post_message(project["id"], "mais uma", agent_id=agent["id"])
    gate.set()
    failed = await wait_run(svc, run2["id"], ("failed",))
    assert failed["error"] == "step_limit" and failed["actions_count"] == 6  # 2 + 4 of the second turn


# -- silence and turn duration -----------------------------------------------------------


async def test_engine_silent_ends_the_turn_and_fails_the_run(svc, fake, project_dir, clock):
    agent, project, run = await start(
        svc, fake, project_dir, FakeTurn(events=[("message", {"text": "Comecei a ler o projeto"})], silent=True))
    await wait_until(lambda: fake.active == 1)
    await asyncio.sleep(0.05)
    assert (await svc.get_run(run["id"]))["status"] == "running"  # nothing moved: no trigger
    clock.jump(31)
    failed = await wait_run(svc, run["id"], ("failed",))
    assert failed["error"] == "engine_silent" and failed["can_continue"] is True
    await wait_until(lambda: fake.active == 0)  # the engine turn was cut through the cancellation
    (stop,) = await notes(svc, run["id"], "limit_stop")
    assert stop["limit"] == "engine_silent" and "30 segundos" in stop["text"]
    body = (await agent_messages(svc, project, agent))[-1]
    assert body.startswith("Parei: fiquei 30 segundos sem nenhum sinal do motor")
    assert "Comecei a ler o projeto" in body and "peça para continuar" in body


async def test_events_keep_the_engine_from_being_silent(svc, fake, project_dir, clock):
    _, _, run = await start(svc, fake, project_dir, FakeTurn(events=[], silent=True))
    await wait_until(lambda: fake.active == 1)
    for _ in range(5):  # 25 s of the clock, an event in between: never 30 s without one
        clock.jump(25)
        svc._active[run["id"]].last_event = clock()  # what any engine event does
        await asyncio.sleep(0.05)
        assert (await svc.get_run(run["id"]))["status"] == "running"
    await svc.cancel_run(run["id"])


async def test_turn_timeout_even_when_the_engine_keeps_talking(svc, fake, project_dir, clock):
    svc.silence_s = 100_000
    svc.turn_max_s = 600
    agent, project, run = await start(svc, fake, project_dir, FakeTurn(events=[], silent=True))
    await wait_until(lambda: fake.active == 1)
    clock.jump(601)
    failed = await wait_run(svc, run["id"], ("failed",))
    assert failed["error"] == "turn_timeout" and failed["can_continue"] is True
    (stop,) = await notes(svc, run["id"], "limit_stop")
    assert stop["limit"] == "turn_timeout" and "10 minutos" in stop["text"]
    assert (await agent_messages(svc, project, agent))[-1].startswith("Parei: este turno passou de 10 minutos")


async def test_waiting_for_approval_does_not_count_and_neither_does_the_approved_command(
        svc, fake, project_dir, clock, monkeypatch):
    async def slow_command(command, *, cwd, timeout_s, cancel, on_spawn=None):
        clock.jump(100_000)  # the harness-run command takes "forever" on the watchdog's clock
        await asyncio.sleep(0.1)
        return 0, "feito", False, False

    monkeypatch.setattr(service_module, "run_shell_command", slow_command)
    agent, project, run = await start(
        svc, fake, project_dir,
        FakeTurn(events=[], approval={"title": "Rodar", "command": "echo oi", "reason": "preciso"}),
        FakeTurn(events=[], final_message="pronto"))
    await wait_run(svc, run["id"], ("waiting_approval",))
    clock.jump(100_000)  # the owner takes a day to answer
    await asyncio.sleep(0.1)
    assert (await svc.get_run(run["id"]))["status"] == "waiting_approval"
    (a,) = await svc.list_approvals(status="pending")
    await svc.decide_approval(a["id"], "approve", digest=a["command_digest"])
    done = await wait_run(svc, run["id"], ("done", "failed"))
    assert done["status"] == "done", done


async def test_parked_time_does_not_count(svc, fake, project_dir, clock):
    _, _, run = await start(svc, fake, project_dir, FakeTurn(events=[], fail_kind="outage"),
                            FakeTurn(events=[], final_message="voltei"))
    await wait_run(svc, run["id"], ("parked",))
    clock.jump(100_000)
    await asyncio.sleep(0.1)
    assert (await svc.get_run(run["id"]))["status"] == "parked"
    await svc.wake_run(run["id"])
    done = await wait_run(svc, run["id"], ("done", "failed"))
    assert done["status"] == "done", done


async def test_time_in_the_queue_does_not_count(svc, fake, project_dir, clock):
    agent, project, first = await start(svc, fake, project_dir, FakeTurn(events=[], silent=True))
    await wait_until(lambda: fake.active == 1)
    fake.add(FakeTurn(events=[], final_message="segundo"))
    queued = await svc.start_run(agent["id"], project["id"], "fila")  # same agent: waits for the first
    assert queued["status"] == "queued"
    clock.jump(601)  # the first run times out; the second waited all that time in the queue
    assert (await wait_run(svc, first["id"], ("failed",)))["error"] in ("turn_timeout", "engine_silent")
    done = await wait_run(svc, queued["id"], ("done", "failed"))
    assert done["status"] == "done", done


# -- stuck loop, end to end ---------------------------------------------------------------


@pytest.mark.parametrize("events,needle", [
    (repeated_action("npm test", 4, paired=True), "repetindo o comando `npm test` (3 vezes seguidas)"),
    (failing_actions(5, paired=True), "4 ações seguidas falharam"),
    (failing_actions(3, command="pytest", error="Boom 7"), "repetindo o comando `pytest`"),
], ids=["repeat", "fail_streak", "repeat_wins_over_error"])
async def test_stuck_loop_ends_the_run_with_a_message(svc, fake, project_dir, events, needle):
    agent, project, run = await start(svc, fake, project_dir, FakeTurn(
        events=[("message", {"text": "Rodando os testes"})] + events))
    failed = await wait_run(svc, run["id"], ("failed",))
    assert failed["error"] == "stuck_loop" and failed["can_continue"] is True
    (stop,) = await notes(svc, run["id"], "limit_stop")
    assert stop["limit"] == "stuck_loop" and "Repetição detectada" in stop["text"]
    body = (await agent_messages(svc, project, agent))[-1]
    assert needle in body and "Rodando os testes" in body
    assert terminal_statuses(await svc.list_events(run["id"], limit=100_000)) == ["failed"]


async def test_the_same_failure_three_times_with_other_actions_between_is_a_loop(svc, fake, project_dir):
    bad = lambda n: command_events("pytest tests/a", call_id=f"p{n}", exit_code=1, output=f"FAILED {n} de 9")  # noqa: E731
    events = bad(1) + command_events("ls") + bad(2) + command_events("pwd") + bad(3)
    agent, project, run = await start(svc, fake, project_dir, FakeTurn(events=events))
    failed = await wait_run(svc, run["id"], ("failed",))
    assert failed["error"] == "stuck_loop"
    assert "falhou 3 vezes com o mesmo erro" in (await agent_messages(svc, project, agent))[-1]


async def test_read_only_repeats_are_allowed_up_to_five(svc, fake, project_dir):
    def read(n: int) -> list:
        return [("step", {"type": "tool_use", "phase": "started", "call_id": f"r{n}", "tool": "Read",
                          "target": "a.py", "read_only": True}),
                ("step", {"type": "tool_use", "phase": "completed", "call_id": f"r{n}", "tool": "Read",
                          "target": "a.py", "read_only": True})]

    agent, project, run = await start(svc, fake, project_dir, FakeTurn(
        events=[e for n in range(5) for e in read(n)]))
    assert (await wait_run(svc, run["id"], ("done", "failed")))["status"] == "done"
    fake.add(FakeTurn(events=[e for n in range(6) for e in read(n)]))
    again = await svc.start_run(agent["id"], project["id"], "de novo")
    failed = await wait_run(svc, again["id"], ("done", "failed"))
    assert failed["status"] == "failed" and failed["error"] == "stuck_loop"
    assert "6 vezes seguidas" in (await agent_messages(svc, project, agent))[-1]


# -- one path for every limit -------------------------------------------------------------


async def test_a_limit_stop_with_an_open_action_says_it_may_be_half_done(svc, fake, project_dir, clock):
    agent, project, run = await start(svc, fake, project_dir, gated(
        partial("Migrei a tabela A"), started("c1", "npm run migrate")))
    await wait_until(lambda: fake.active == 1)
    await asyncio.sleep(0.05)
    clock.jump(31)
    failed = await wait_run(svc, run["id"], ("failed",))
    assert failed["error"] == "engine_silent"
    (stop,) = await notes(svc, run["id"], "limit_stop")
    assert "`npm run migrate`" in stop["text"] and "pela metade" in stop["text"]
    body = (await agent_messages(svc, project, agent))[-1]
    assert "Eu estava executando o comando `npm run migrate` e ela pode ter ficado pela metade" in body
    assert "Migrei a tabela A" in body


async def test_pending_inbox_messages_become_undelivered_on_a_limit_stop(svc, fake, project_dir, clock):
    agent, project, run = await start(svc, fake, project_dir, FakeTurn(events=[], silent=True))
    await wait_until(lambda: fake.active == 1)
    queue: asyncio.Queue = asyncio.Queue()
    svc._global_subs.add(queue)
    out = await svc.post_message(project["id"], "uma coisa mais", agent_id=agent["id"])
    assert out["joined"] is True and out["message"]["delivery"] == "pending"
    clock.jump(31)
    failed = await wait_run(svc, run["id"], ("failed",))
    assert failed["error"] == "engine_silent" and failed["inbox_count"] == 0
    msg = next(m for m in await svc.list_messages(project["id"]) if m["body"] == "uma coisa mais")
    assert msg["delivery"] == "undelivered"
    # the frame is published just after the status row is committed: wait for it, do not assume it
    frames: list[dict] = []

    def seen() -> bool:
        while not queue.empty():
            frames.append(queue.get_nowait())
        return any(f["type"] == "message_update" and f["message"]["delivery"] == "undelivered" for f in frames)

    await wait_until(seen)
    # and a continuation takes the message along (rule of 1c)
    fake.add(FakeTurn(final_message="li"))
    new = await svc.continue_run(run["id"])
    await wait_run(svc, new["id"], ("done",))
    assert any("uma coisa mais" in c.get("message", "") for c in fake.calls)


async def test_a_limit_racing_the_natural_end_of_the_turn_leaves_one_terminal_state(
        svc, fake, project_dir, clock):
    gate = asyncio.Event()
    agent, project, run = await start(svc, fake, project_dir, FakeTurn(
        events=[], gate=gate, ignore_cancel=True, final_message="Terminei tudo"))
    await wait_until(lambda: fake.active == 1)
    clock.jump(31)
    await wait_until(lambda: svc._active[run["id"]].limit is not None)
    gate.set()  # the engine finishes by itself right after the harness asked it to stop
    failed = await wait_run(svc, run["id"], ("failed", "done"))
    await asyncio.sleep(0.1)
    assert failed["status"] == "failed" and failed["error"] == "engine_silent"
    events = await svc.list_events(run["id"], limit=100_000)
    assert terminal_statuses(events) == ["failed"]
    assert failed["result_summary"] is None  # the late natural answer is not taken as the result
    # a second attempt to stop the same run (the other side of the race) changes nothing
    act = _Active(agent_id=agent["id"])
    act.limit = {"code": "turn_timeout", "seconds": 1}
    before = len(events)
    await svc._stop_for_limit(run["id"], act)
    assert len(await svc.list_events(run["id"], limit=100_000)) == before


async def test_the_natural_end_before_the_watchdog_wins(svc, fake, project_dir, clock):
    _, _, run = await start(svc, fake, project_dir, FakeTurn(events=[], final_message="pronto"))
    await wait_run(svc, run["id"], ("done",))
    clock.jump(100_000)  # too late: the watchdog of that turn is gone
    await asyncio.sleep(0.1)
    assert (await svc.get_run(run["id"]))["status"] == "done"
    act = _Active(agent_id="x")
    assert svc._hit(act, "engine_silent") is False and act.limit is None  # no turn in flight


async def test_an_owner_cancel_wins_over_a_limit_that_was_just_flagged(svc, fake, project_dir, clock):
    gate = asyncio.Event()
    _, _, run = await start(svc, fake, project_dir, FakeTurn(events=[], gate=gate, ignore_cancel=True))
    await wait_until(lambda: fake.active == 1)
    clock.jump(31)
    await wait_until(lambda: svc._active[run["id"]].limit is not None)
    cancelling = asyncio.create_task(svc.cancel_run(run["id"]))
    await wait_until(lambda: svc._active[run["id"]].cancel_requested)
    gate.set()
    cancelled = await cancelling
    assert cancelled["status"] == "cancelled" and cancelled["error"] is None
    assert await notes(svc, run["id"], "limit_stop") == []


async def test_an_owner_interrupt_still_resumes_the_session_with_the_watchdog_running(svc, fake, project_dir, clock):
    agent, project, run = await start(svc, fake, project_dir, FakeTurn(
        events=[("message", {"text": "comecei"})], silent=True))
    await wait_until(lambda: fake.active == 1)
    fake.add(FakeTurn(events=[], final_message="li a mensagem"))
    out = await svc.post_message(project["id"], "mude de rumo", agent_id=agent["id"], mode="interrupt")
    assert out["interrupted"] is True
    done = await wait_run(svc, run["id"], ("done", "failed"))
    assert done["status"] == "done" and done["actions_count"] == 0
    assert any("mude de rumo" in c.get("message", "") for c in fake.calls)


async def test_a_shutdown_leaves_the_run_running_for_the_next_boot(store, project_dir):
    engine = FakeEngine(turns=[FakeTurn(events=[], silent=True)])
    s1 = service(store, engine)
    await s1.start()
    agent, project = await setup_agent(s1, project_dir)
    run = await s1.start_run(agent["id"], project["id"], "x")
    await wait_until(lambda: engine.active == 1)
    s1.shutdown_drain_s = 0
    await s1.stop()
    row = await s1.get_run(run["id"])
    assert row["status"] == "running" and row["error"] is None
    assert not [n for n in await notes(s1, run["id"], "limit_stop")]


async def test_every_limit_code_allows_continue_and_other_failures_do_not(svc, fake, project_dir):
    agent, project = await setup_agent(svc, project_dir)
    for code in LIMIT_CODES + ("engine_error",):
        run = await svc.start_run(agent["id"], project["id"], f"g {code}")
        await wait_run(svc, run["id"], ("done",))
        await svc._db(lambda c, rid=run["id"], code=code: c.execute(
            "UPDATE agent_runs SET status = 'failed', error = ? WHERE id = ?", (code, rid)))
        assert (await svc.get_run(run["id"]))["can_continue"] is (code in LIMIT_CODES), code
        if code not in LIMIT_CODES:
            with pytest.raises(Conflict) as exc:
                await svc.continue_run(run["id"])
            assert exc.value.code == "continue_not_allowed"


async def test_continuing_a_limit_run_that_cannot_resume_starts_over_with_the_reason(
        store, project_dir):
    engine = FakeEngine(turns=[FakeTurn(events=many_actions(4))], resumable=False)
    s = service(store, engine, agents_run_max_actions=3)
    await s.start()
    try:
        agent, project = await setup_agent(s, project_dir)
        run = await s.start_run(agent["id"], project["id"], "meta original")
        assert (await wait_run(s, run["id"], ("failed",)))["error"] == "step_limit"
        engine.add(FakeTurn(final_message="de novo"))
        new = await s.continue_run(run["id"])
        await wait_run(s, new["id"], ("done",))
        prompt = engine.calls[-1]["ctx"].prompt
        assert "segunda tentativa" in prompt and "limite de ações por execução" in prompt
        assert "meta original" in prompt
    finally:
        await s.stop()


# -- settings ----------------------------------------------------------------------------


async def test_the_three_settings_are_read_with_their_defaults(store):
    s = AgentHarnessService(store, make_settings(), engines={"fake": FakeEngine()})
    assert (s.max_actions, s.silence_s, s.turn_max_s) == (200, 900, 10800)
    s = AgentHarnessService(store, make_settings(
        agents_run_max_actions=7, agents_engine_silence_s=11, agents_turn_max_s=22), engines={"fake": FakeEngine()})
    assert (s.max_actions, s.silence_s, s.turn_max_s) == (7, 11, 22)
    from seraphine.config import Settings
    fields = Settings.model_fields
    assert fields["agents_run_max_actions"].default == 200
    assert fields["agents_engine_silence_s"].default == 900
    assert fields["agents_turn_max_s"].default == 10800


def test_migration_adds_actions_count_once_to_an_older_database():
    conn = sqlite3.connect(":memory:")
    agents_schema.migrate(conn)
    conn.execute("INSERT INTO agent_runs (id, agent_id, project_id, goal, status, engine, created_at)"
                 " VALUES ('r1', 'a', 'p', 'g', 'done', 'fake', 'n')")
    conn.execute("ALTER TABLE agent_runs DROP COLUMN actions_count")  # a database from before 1d
    agents_schema.migrate(conn)
    agents_schema.migrate(conn)
    cols = [r[1] for r in conn.execute("PRAGMA table_info(agent_runs)")]
    assert cols.count("actions_count") == 1
    assert conn.execute("SELECT actions_count FROM agent_runs WHERE id = 'r1'").fetchone()[0] == 0


# -- read-only actions in the boot decision ------------------------------------------------


def started_read(call_id: str = "r1") -> tuple[str, dict]:
    return ("step", {"type": "tool_use", "phase": "started", "call_id": call_id, "tool": "Read",
                     "target": "a.py", "read_only": True, "by": "agent"})


async def test_boot_resumes_a_run_whose_only_open_action_is_read_only(store, project_dir: Path):
    turn = gated(partial(), started_read())
    _, run, agent, project = await interrupted_run(store, project_dir, turn)
    engine2 = FakeEngine()
    s2 = service(store, engine2)
    await s2.start()
    try:
        await wait_until(lambda: any(c["op"] == "resume" for c in engine2.calls))
        r = await wait_run(s2, run["id"], ("done", "running", "queued"))
        assert r["error"] is None and r["recoveries"] == 1
        assert engine2.calls[0]["op"] == "resume"
    finally:
        await s2.stop()


async def test_boot_still_refuses_when_a_non_read_only_action_is_open_too(store, project_dir: Path):
    turn = gated(partial(), started_read("r1"), started("c1", "npm run migrate"))
    _, run, agent, project = await interrupted_run(store, project_dir, turn)
    engine2 = FakeEngine()
    s2 = service(store, engine2)
    await s2.start()
    try:
        r = await s2.get_run(run["id"])
        assert r["status"] == "failed" and r["error"] == "interrupted_mid_action"
        assert engine2.calls == []
    finally:
        await s2.stop()


async def test_a_command_flagged_read_only_still_blocks_the_boot_resume(store, project_dir: Path):
    sneaky = ("step", {"type": "command", "phase": "started", "call_id": "c9", "command": "cat a",
                       "by": "agent", "read_only": True})
    _, run, _, _ = await interrupted_run(store, project_dir, gated(partial(), sneaky))
    s2 = service(store, FakeEngine())
    await s2.start()
    try:
        assert (await s2.get_run(run["id"]))["error"] == "interrupted_mid_action"
    finally:
        await s2.stop()


async def test_late_events_of_a_turn_ended_by_a_limit_are_not_recorded_counted_or_fed(svc, fake, project_dir):
    svc.max_actions = 2
    gate = asyncio.Event()
    late = many_actions(3) + [("message", {"text": "texto tardio"})]
    agent, project, run = await start(svc, fake, project_dir, FakeTurn(
        events=many_actions(3), gate=gate, ignore_cancel=True, events_after=late))
    await wait_until(lambda: fake.active == 1)
    await wait_until(lambda: svc._active[run["id"]].limit is not None)  # cut at the 3rd action
    before = [e["id"] for e in await svc.list_events(run["id"], limit=100_000)]
    gate.set()  # the stopped turn now delivers its late events
    failed = await wait_run(svc, run["id"], ("failed",))
    await wait_until(lambda: fake.active == 0)
    events = await svc.list_events(run["id"], limit=100_000)
    texts = [e["payload"].get("text") for e in events]
    assert "texto tardio" not in texts
    assert [e["id"] for e in events if e["id"] in before] == before
    assert len([e for e in events if e["kind"] == "command"]) == 3  # 2 counted + the one that was cut
    assert failed["actions_count"] == 2 and failed["error"] == "step_limit"
    assert terminal_statuses(events) == ["failed"]

