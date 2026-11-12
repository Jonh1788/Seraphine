"""Phase 6b: the routine clock and the life of a routine run (time is injected; nothing sleeps)."""

from __future__ import annotations

import asyncio
import time
from datetime import datetime, timedelta, timezone

import pytest

from seraphine.agents import routines
from seraphine.agents.engines.fake import FakeEngine, FakeTurn
from seraphine.agents.service import AgentHarnessService

from .conftest import make_settings, make_api, wait_run

UTC = timezone.utc
#: Thursday 2026-11-12, 10:00 local time (the tests run at UTC-3).
T0 = datetime(2026, 11, 12, 13, 0, tzinfo=UTC)
DAILY_11 = {"kind": "daily", "time": "11:00"}
EVERY_15 = {"kind": "interval", "every_minutes": 15}


class Clock:
    """The service's clock, set by hand, with local time fixed at UTC-3."""

    def __init__(self, svc: AgentHarnessService, start: datetime = T0) -> None:
        self.t = start
        svc.now = lambda: self.t  # type: ignore[assignment]
        svc.local_time = routines.FixedOffset(-3)

    def local(self, month: int, day: int, hour: int, minute: int = 0, second: int = 0) -> datetime:
        """Move to a LOCAL wall-clock time of 2026."""
        self.t = datetime(2026, month, day, hour, minute, second, tzinfo=UTC) + timedelta(hours=3)
        return self.t

    def advance(self, **kw) -> datetime:
        self.t += timedelta(**kw)
        return self.t


def iso_local(month: int, day: int, hour: int, minute: int = 0) -> str:
    return (datetime(2026, month, day, hour, minute, tzinfo=UTC) + timedelta(hours=3)).isoformat(
        timespec="microseconds")


async def setup(hsvc, name="Ana", schedule=DAILY_11, report="news", **over):
    clock = Clock(hsvc)
    agent = await hsvc.create_def(name=name, engine="fake")
    routine = await hsvc.create_routine(agent_id=agent["id"], title="Pendências",
                                        prompt="Liste o que está pendente.", schedule=schedule,
                                        report=report, **over)
    return clock, agent, routine


async def wait_routine(hsvc, routine_id, pred, timeout=10.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        routine = await hsvc.get_routine(routine_id)
        if pred(routine):
            return routine
        await asyncio.sleep(0.02)
    raise AssertionError(f"routine never reached the state: {await hsvc.get_routine(routine_id)}")


async def settled(hsvc, routine_id):
    """The routine has no run in progress any more (its last line is closed)."""
    return await wait_routine(hsvc, routine_id, lambda r: r["running"] is False)


async def lines(hsvc, routine_id):
    return await hsvc.list_routine_runs(routine_id, 100)


def home_messages(msgs, agent_id):
    return [m for m in msgs if m["author"] == agent_id]


# -- due detection -----------------------------------------------------------------------------------------


async def test_nothing_happens_before_the_time_and_a_due_routine_starts_one_run(hsvc):
    clock, agent, routine = await setup(hsvc)
    fake = hsvc.engines["fake"]
    assert routine["next_run_at"] == iso_local(11, 12, 11)
    clock.local(11, 12, 10, 59, 59)
    assert await hsvc.tick() == 0 and await lines(hsvc, routine["id"]) == []
    sub, _ = hsvc.open_live()
    clock.local(11, 12, 11, 0, 10)
    assert await hsvc.tick() == 1
    assert await hsvc.tick() == 0  # the same look again does nothing: the next time already moved on
    await settled(hsvc, routine["id"])
    got = await lines(hsvc, routine["id"])
    assert len(got) == 1
    line = got[0]
    assert line["trigger"] == "schedule" and line["scheduled_for"] == iso_local(11, 12, 11)
    assert line["status"] in ("quiet", "reported") and line["run_id"]
    runs = await hsvc.list_runs(routine["project_id"])
    assert len(runs) == 1 and runs[0]["id"] == line["run_id"]
    assert runs[0]["requested_by"] == "routine" and runs[0]["routine_id"] == routine["id"]
    assert runs[0]["routine_title"] == "Pendências" and runs[0]["goal"] == "Liste o que está pendente."
    after = await hsvc.get_routine(routine["id"])
    assert after["next_run_at"] == iso_local(11, 13, 11)  # the next one AFTER now
    assert after["last_run_at"] and after["last_status"] in ("quiet", "reported")
    updates = [f["routine"] for f in _drain(sub) if f["type"] == "routine_update"]
    assert updates and updates[0]["next_run_at"] == iso_local(11, 13, 11)
    assert any(u["running"] for u in updates) and updates[-1]["running"] is False
    # the preamble: not a question-asking run, the routine, the request and the SEM_NOVIDADE rule
    prompt = fake.calls[0]["ctx"].prompt
    assert "--- ROTINA ---" in prompt and "NÃO está presente" in prompt and "perguntas de esclarecimento" in prompt
    assert "«Pendências»" in prompt and "Liste o que está pendente." in prompt and "SEM_NOVIDADE" in prompt
    assert prompt.index("--- ROTINA ---") < prompt.index("Liste o que está pendente.")


def _drain(sub):
    frames = []
    while not sub.empty():
        frames.append(sub.get_nowait())
    return frames


async def test_always_report_has_no_news_rule_and_a_normal_run_has_no_preamble(hsvc):
    clock, agent, routine = await setup(hsvc, report="always")
    fake = hsvc.engines["fake"]
    clock.local(11, 12, 11, 0, 5)
    await hsvc.tick()
    await settled(hsvc, routine["id"])
    assert "--- ROTINA ---" in fake.calls[0]["ctx"].prompt and "SEM_NOVIDADE" not in fake.calls[0]["ctx"].prompt
    async with make_api(hsvc) as c:
        r = await c.post(f"/agents/projects/{routine['project_id']}/messages", json={"body": "oi"})
        await wait_run(hsvc, r.json()["run"]["id"], ("done",))
    assert "--- ROTINA ---" not in fake.calls[-1]["ctx"].prompt


async def test_disabled_routines_never_fire(hsvc):
    clock, agent, routine = await setup(hsvc, enabled=False)
    clock.local(11, 20, 12)
    assert await hsvc.tick() == 0
    on = await hsvc.update_routine(routine["id"], enabled=True)
    assert on["next_run_at"] == iso_local(11, 21, 11)
    await hsvc.update_routine(routine["id"], enabled=False)
    clock.local(11, 22, 12)
    assert await hsvc.tick() == 0 and await lines(hsvc, routine["id"]) == []


async def test_tick_accepts_an_explicit_now(hsvc):
    agent = await hsvc.create_def(name="Ana", engine="fake")
    routine = await hsvc.create_routine(agent_id=agent["id"], title="T", prompt="p", schedule=EVERY_15)
    created = datetime.fromisoformat(routine["created_at"])
    assert await hsvc.tick(now=created + timedelta(minutes=10)) == 0
    assert await hsvc.tick(now=created + timedelta(minutes=16)) == 1
    await settled(hsvc, routine["id"])
    assert (await lines(hsvc, routine["id"]))[0]["trigger"] == "schedule"


# -- skipped, missed, catch-up -----------------------------------------------------------------------------------


async def test_the_next_time_is_skipped_while_the_previous_run_goes_on(hsvc):
    clock, agent, routine = await setup(hsvc)
    gate = asyncio.Event()
    hsvc.engines["fake"].add(FakeTurn(gate=gate))
    clock.local(11, 12, 11, 0, 10)
    await hsvc.tick()
    assert (await hsvc.get_routine(routine["id"]))["running"] is True
    clock.local(11, 13, 11, 0, 10)
    assert await hsvc.tick() == 1
    got = await lines(hsvc, routine["id"])
    assert [(x["status"], x["scheduled_for"]) for x in got] == [
        ("skipped", iso_local(11, 13, 11)), ("running", iso_local(11, 12, 11))]
    assert "anterior" in got[0]["detail"] and got[0]["run_id"] is None and got[0]["finished_at"]
    assert len(await hsvc.list_runs(routine["project_id"])) == 1  # no second run
    assert (await hsvc.get_routine(routine["id"]))["next_run_at"] == iso_local(11, 14, 11)
    gate.set()
    await settled(hsvc, routine["id"])
    assert (await hsvc.get_routine(routine["id"]))["last_status"] in ("quiet", "reported")


async def test_a_time_missed_for_more_than_twelve_hours_is_recorded_not_run(hsvc):
    clock, agent, routine = await setup(hsvc)
    clock.local(11, 13, 0, 5)  # 13 h after the 11:00 of the 12th, before the 11:00 of the 13th
    assert await hsvc.tick() == 1
    got = await lines(hsvc, routine["id"])
    assert len(got) == 1 and got[0]["status"] == "missed" and got[0]["scheduled_for"] == iso_local(11, 12, 11)
    assert got[0]["run_id"] is None and "12 horas" in got[0]["detail"] and got[0]["trigger"] == "schedule"
    assert await hsvc.list_runs(routine["project_id"]) == []
    after = await hsvc.get_routine(routine["id"])
    assert after["next_run_at"] == iso_local(11, 13, 11) and after["last_status"] is None
    assert after["week"] == {"ok": 0, "total": 1}  # it had a time, and it did not go well


async def test_a_time_just_inside_the_window_runs_once_as_catch_up(hsvc):
    clock, agent, routine = await setup(hsvc)
    clock.local(11, 12, 22, 59)  # 11 h 59 min late
    await hsvc.tick()
    await settled(hsvc, routine["id"])
    got = await lines(hsvc, routine["id"])
    assert len(got) == 1 and got[0]["trigger"] == "catchup" and got[0]["scheduled_for"] == iso_local(11, 12, 11)
    assert got[0]["status"] in ("quiet", "reported")
    assert (await hsvc.get_routine(routine["id"]))["next_run_at"] == iso_local(11, 13, 11)


async def test_a_small_delay_is_still_the_schedule_and_five_minutes_is_the_edge(hsvc):
    clock, agent, routine = await setup(hsvc)
    clock.local(11, 12, 11, 5, 0)
    await hsvc.tick()
    await settled(hsvc, routine["id"])
    assert (await lines(hsvc, routine["id"]))[0]["trigger"] == "schedule"
    clock.local(11, 13, 11, 5, 1)
    await hsvc.tick()
    await settled(hsvc, routine["id"])
    assert (await lines(hsvc, routine["id"]))[0]["trigger"] == "catchup"


async def test_several_missed_times_collapse_into_one_run(hsvc):
    clock, agent, routine = await setup(hsvc)
    clock.local(11, 15, 12)  # the PC was off from the 12th to Sunday noon: 12th..15th at 11:00 passed
    assert await hsvc.tick() == 1
    await settled(hsvc, routine["id"])
    got = await lines(hsvc, routine["id"])
    by_status = {}
    for x in got:
        by_status.setdefault(x["status"], []).append(x)
    assert len(by_status["missed"]) == 3  # the 12th, 13th and 14th at 11:00 are older than 12 h
    assert sorted(x["scheduled_for"] for x in by_status["missed"]) == [
        iso_local(11, 12, 11), iso_local(11, 13, 11), iso_local(11, 14, 11)]
    ran = [x for x in got if x["run_id"]]
    assert len(ran) == 1 and ran[0]["scheduled_for"] == iso_local(11, 15, 11) and ran[0]["trigger"] == "catchup"
    assert len(await hsvc.list_runs(routine["project_id"])) == 1  # never a queue of them
    assert (await hsvc.get_routine(routine["id"]))["next_run_at"] == iso_local(11, 16, 11)
    assert await hsvc.tick() == 0


async def test_interval_routines_count_from_their_anchor_and_collapse_too(hsvc):
    clock, agent, routine = await setup(hsvc, schedule={"kind": "interval", "every_minutes": 30})
    assert routine["next_run_at"] == iso_local(11, 12, 10, 30)  # created at 10:00
    clock.local(11, 12, 10, 30, 5)
    await hsvc.tick()
    await settled(hsvc, routine["id"])
    assert (await hsvc.get_routine(routine["id"]))["next_run_at"] == iso_local(11, 12, 11)
    clock.local(11, 12, 12, 20)  # off for a while: 11:00, 11:30 and 12:00 passed
    await hsvc.tick()
    await settled(hsvc, routine["id"])
    got = await lines(hsvc, routine["id"])
    assert [x["scheduled_for"] for x in got][0] == iso_local(11, 12, 12) and got[0]["trigger"] == "catchup"
    assert len(got) == 2 and len(await hsvc.list_runs(routine["project_id"])) == 2
    assert (await hsvc.get_routine(routine["id"]))["next_run_at"] == iso_local(11, 12, 12, 30)


async def test_changing_the_schedule_restarts_an_interval(hsvc):
    clock, agent, routine = await setup(hsvc, schedule={"kind": "interval", "every_minutes": 60})
    clock.local(11, 12, 10, 40)
    changed = await hsvc.update_routine(routine["id"], schedule={"kind": "interval", "every_minutes": 30})
    assert changed["next_run_at"] == iso_local(11, 12, 11, 10)  # counted from the change, not from the creation


# -- how a run ends ----------------------------------------------------------------------------------------------


async def run_once(hsvc, clock, routine, day=12, hour=11):
    clock.local(11, day, hour, 0, 5)
    await hsvc.tick()
    return await settled(hsvc, routine["id"])


async def test_reported_publishes_the_answer_and_counts_as_ok(hsvc):
    clock, agent, routine = await setup(hsvc)
    hsvc.engines["fake"].add(FakeTurn(final_message="Você tem 3 pendências."))
    after = await run_once(hsvc, clock, routine)
    assert (await lines(hsvc, routine["id"]))[0]["status"] == "reported"
    assert after["last_status"] == "reported" and after["consecutive_failures"] == 0
    msgs = home_messages(await hsvc.list_messages(routine["project_id"]), agent["id"])
    assert [m["body"] for m in msgs] == ["Você tem 3 pendências."] and msgs[0]["routine_id"] == routine["id"]
    assert after["week"] == {"ok": 1, "total": 1}


@pytest.mark.parametrize("answer", ["SEM_NOVIDADE", "  sem_novidade.  ", "`Sem_Novidade`\n"])
async def test_quiet_when_there_is_no_news_and_the_message_is_not_published(hsvc, answer):
    clock, agent, routine = await setup(hsvc)
    hsvc.engines["fake"].add(FakeTurn(final_message=answer))
    sub, _ = hsvc.open_live()
    after = await run_once(hsvc, clock, routine)
    line = (await lines(hsvc, routine["id"]))[0]
    assert line["status"] == "quiet" and line["detail"] == "" and after["last_status"] == "quiet"
    assert home_messages(await hsvc.list_messages(routine["project_id"]), agent["id"]) == []
    assert not [f for f in _drain(sub) if f["type"] == "message" and f["message"]["author"] == agent["id"]]
    run = await hsvc.get_run(line["run_id"])
    assert run["status"] == "done" and run["result_summary"].strip(" `\n.").lower() == "sem_novidade"
    assert after["week"] == {"ok": 1, "total": 1}  # quiet counts as well


async def test_an_answer_that_only_mentions_the_word_is_published(hsvc):
    clock, agent, routine = await setup(hsvc)
    hsvc.engines["fake"].add(FakeTurn(final_message="SEM_NOVIDADE no e-mail, mas há 2 prazos hoje."))
    await run_once(hsvc, clock, routine)
    assert (await lines(hsvc, routine["id"]))[0]["status"] == "reported"
    assert len(home_messages(await hsvc.list_messages(routine["project_id"]), agent["id"])) == 1


async def test_report_always_publishes_even_sem_novidade(hsvc):
    clock, agent, routine = await setup(hsvc, report="always")
    hsvc.engines["fake"].add(FakeTurn(final_message="SEM_NOVIDADE"))
    await run_once(hsvc, clock, routine)
    assert (await lines(hsvc, routine["id"]))[0]["status"] == "reported"
    msgs = home_messages(await hsvc.list_messages(routine["project_id"]), agent["id"])
    assert [m["body"] for m in msgs] == ["SEM_NOVIDADE"]


async def test_failed_run_closes_the_line_and_counts(hsvc):
    clock, agent, routine = await setup(hsvc)
    hsvc.engines["fake"].add(FakeTurn(fail="o motor caiu"))
    after = await run_once(hsvc, clock, routine)
    line = (await lines(hsvc, routine["id"]))[0]
    assert line["status"] == "failed" and "o motor caiu" in line["detail"] and line["finished_at"]
    assert after["last_status"] == "failed" and after["consecutive_failures"] == 1
    assert after["enabled"] is True and after["paused_reason"] is None  # one failure does not pause
    assert after["week"] == {"ok": 0, "total": 1}


async def test_a_success_resets_the_failures(hsvc):
    clock, agent, routine = await setup(hsvc, schedule=EVERY_15)
    fake = hsvc.engines["fake"]
    for i in range(3):
        fake.add(FakeTurn(fail="boom"))
        clock.advance(minutes=15, seconds=1)
        await hsvc.tick()
        await settled(hsvc, routine["id"])
    assert (await hsvc.get_routine(routine["id"]))["consecutive_failures"] == 3
    clock.advance(minutes=15, seconds=1)
    await hsvc.tick()
    after = await settled(hsvc, routine["id"])
    assert after["consecutive_failures"] == 0 and after["last_status"] in ("quiet", "reported")
    got = await lines(hsvc, routine["id"])
    assert [x["status"] for x in got[1:]] == ["failed"] * 3
    assert after["week"] == {"ok": 1, "total": 4}


async def test_the_fifth_failure_in_a_row_pauses_with_one_notice(hsvc):
    clock, agent, routine = await setup(hsvc, schedule=EVERY_15)
    fake = hsvc.engines["fake"]
    sub, _ = hsvc.open_live()
    for i in range(5):
        fake.add(FakeTurn(fail=f"falha {i + 1}"))
        clock.advance(minutes=15, seconds=1)
        assert await hsvc.tick() == 1
        after = await settled(hsvc, routine["id"])
        assert after["consecutive_failures"] == i + 1
        notices = [m for m in await hsvc.list_messages(routine["project_id"]) if m["author"] == "system"]
        assert len(notices) == (1 if i == 4 else 0)
    assert after["enabled"] is False and after["paused_reason"] == "failures"
    assert after["next_run_at"] is None and after["upcoming"] == []
    notice = notices[0]
    assert notice["body"].startswith("A rotina «Pendências» foi pausada depois de 5 falhas seguidas.")
    assert "falha 5" in notice["body"] and notice["run_id"] is None
    clock.advance(hours=3)
    assert await hsvc.tick() == 0  # paused: nothing more
    assert len([m for m in await hsvc.list_messages(routine["project_id"]) if m["author"] == "system"]) == 1
    assert any(f["type"] == "routine_update" and f["routine"]["paused_reason"] == "failures" for f in _drain(sub))
    back = await hsvc.update_routine(routine["id"], enabled=True)  # "Retomar"
    assert back["paused_reason"] is None and back["consecutive_failures"] == 0 and back["next_run_at"]


async def test_cancelled_run_is_recorded_and_does_not_count_as_a_failure(hsvc):
    clock, agent, routine = await setup(hsvc)
    gate = asyncio.Event()
    hsvc.engines["fake"].add(FakeTurn(gate=gate))
    clock.local(11, 12, 11, 0, 5)
    await hsvc.tick()
    line = (await lines(hsvc, routine["id"]))[0]
    assert line["status"] == "running"
    await wait_run(hsvc, line["run_id"], ("running",))
    await hsvc.cancel_run(line["run_id"])
    after = await settled(hsvc, routine["id"])
    got = (await lines(hsvc, routine["id"]))[0]
    assert got["status"] == "cancelled" and got["detail"] and after["consecutive_failures"] == 0
    assert after["last_status"] == "cancelled" and after["enabled"] is True


async def test_a_queued_routine_run_cancelled_before_it_starts_closes_its_line(hsvc):
    clock, agent, routine = await setup(hsvc)
    gate = asyncio.Event()
    hsvc.engines["fake"].add(FakeTurn(gate=gate))
    async with make_api(hsvc) as c:
        busy = (await c.post(f"/agents/projects/{routine['project_id']}/messages", json={"body": "ocupe-se"})).json()
        await wait_run(hsvc, busy["run"]["id"], ("running",))
        clock.local(11, 12, 11, 0, 5)
        await hsvc.tick()  # the agent is busy: the routine's run waits in the queue
        line = (await lines(hsvc, routine["id"]))[0]
        assert line["status"] == "running"
        assert (await hsvc.get_run(line["run_id"]))["status"] == "queued"
        await hsvc.cancel_run(line["run_id"])
        assert (await lines(hsvc, routine["id"]))[0]["status"] == "cancelled"
        gate.set()
        await wait_run(hsvc, busy["run"]["id"], ("done",))


async def test_a_routine_run_that_waits_for_approval_stays_running(hsvc):
    clock, agent, routine = await setup(hsvc)
    hsvc.engines["fake"].add(FakeTurn(approval={"title": "Rodar", "command": "echo oi", "reason": "preciso"}))
    clock.local(11, 12, 11, 0, 5)
    await hsvc.tick()
    line = (await lines(hsvc, routine["id"]))[0]
    run = await wait_run(hsvc, line["run_id"], ("waiting_approval",))
    assert run["requested_by"] == "routine"
    pending = await hsvc.list_approvals(status="pending")
    assert len(pending) == 1 and pending[0]["run_id"] == run["id"]  # a routine never skips the approval
    assert (await lines(hsvc, routine["id"]))[0]["status"] == "running"
    assert (await hsvc.get_routine(routine["id"]))["running"] is True
    msgs = home_messages(await hsvc.list_messages(routine["project_id"]), agent["id"])
    assert msgs and all(m["routine_id"] == routine["id"] for m in msgs)  # "Preciso da sua aprovação..."
    await hsvc.cancel_run(run["id"])
    assert (await settled(hsvc, routine["id"]))["last_status"] == "cancelled"
    assert (await hsvc.get_def(agent["id"]))["perm_commands"] == "ask"  # nothing was changed


# -- one-shot routines --------------------------------------------------------------------------------------------


async def test_a_one_shot_runs_once_and_switches_itself_off(hsvc):
    clock, agent, routine = await setup(hsvc, schedule={"kind": "once", "at": "2026-11-12T11:00"})
    assert routine["next_run_at"] == iso_local(11, 12, 11) and routine["upcoming"] == [iso_local(11, 12, 11)]
    after = await run_once(hsvc, clock, routine)
    assert after["enabled"] is False and after["next_run_at"] is None and after["upcoming"] == []
    assert after["last_status"] in ("quiet", "reported") and after["paused_reason"] is None
    clock.advance(days=3)
    assert await hsvc.tick() == 0 and len(await lines(hsvc, routine["id"])) == 1


async def test_a_one_shot_that_fails_still_switches_off_and_a_missed_one_too(hsvc):
    clock, agent, routine = await setup(hsvc, schedule={"kind": "once", "at": "2026-11-12T11:00"})
    hsvc.engines["fake"].add(FakeTurn(fail="boom"))
    after = await run_once(hsvc, clock, routine)
    assert after["enabled"] is False and after["last_status"] == "failed" and after["paused_reason"] is None
    other = await hsvc.create_routine(agent_id=agent["id"], title="Outra", prompt="p",
                                      schedule={"kind": "once", "at": "2026-11-12T20:00"})
    clock.local(11, 14, 9)  # the PC was off for days
    await hsvc.tick()
    missed = await hsvc.get_routine(other["id"])
    assert missed["enabled"] is False and missed["next_run_at"] is None
    assert [x["status"] for x in await lines(hsvc, other["id"])] == ["missed"]


async def test_a_one_shot_that_finds_the_previous_run_busy_keeps_its_time(hsvc):
    clock, agent, routine = await setup(hsvc, schedule={"kind": "once", "at": "2026-11-12T11:00"})
    gate = asyncio.Event()
    hsvc.engines["fake"].add(FakeTurn(gate=gate))
    await hsvc.run_routine_now(routine["id"])  # a manual run is in progress
    clock.local(11, 12, 11, 0, 5)
    await hsvc.tick()
    got = await hsvc.get_routine(routine["id"])
    assert got["enabled"] is True and got["next_run_at"] == iso_local(11, 12, 11)
    assert "skipped" in [x["status"] for x in await lines(hsvc, routine["id"])]
    gate.set()
    await wait_routine(hsvc, routine["id"], lambda r: r["running"] is False and r["enabled"] is False)


# -- agents that are off or gone ------------------------------------------------------------------------------------


async def test_a_paused_agent_makes_the_times_skipped_and_they_never_count_as_failures(hsvc):
    # Phase 6c part 2 changed the 6b rule: pausing is not failing.
    clock, agent, routine = await setup(hsvc, schedule=EVERY_15)
    await hsvc.update_def(agent["id"], enabled=False)
    for _ in range(6):
        clock.advance(minutes=15, seconds=1)
        assert await hsvc.tick() == 1
        got = await hsvc.get_routine(routine["id"])
        assert got["consecutive_failures"] == 0
    got = await hsvc.get_routine(routine["id"])
    assert got["enabled"] is True and got["paused_reason"] is None and got["next_run_at"] is not None
    ledger = await lines(hsvc, routine["id"])
    assert len(ledger) == 6 and all(x["status"] == "skipped" and x["run_id"] is None for x in ledger)
    assert ledger[0]["detail"] == "O agente está pausado."
    assert await hsvc.list_runs(routine["project_id"]) == []  # nothing was started
    assert [m for m in await hsvc.list_messages(routine["project_id"]) if m["author"] == "system"] == []


async def test_deleting_the_agent_deletes_routines_and_the_clock_has_nothing_to_do(hsvc):
    clock, agent, routine = await setup(hsvc)
    await hsvc.delete_def(agent["id"])
    assert await hsvc.list_routines() == [] and await hsvc.get_routine(routine["id"]) is None
    clock.local(11, 20, 12)
    assert await hsvc.tick() == 0


async def test_an_engine_that_is_not_ready_fails_the_time_without_a_run_left_behind(hsvc):
    clock, agent, routine = await setup(hsvc, schedule=EVERY_15)
    hsvc.engines["fake"]._ok, hsvc.engines["fake"]._reason = False, "motor desligado"
    clock.advance(minutes=15, seconds=1)
    await hsvc.tick()
    got = (await lines(hsvc, routine["id"]))[0]
    assert got["status"] == "failed" and "motor desligado" in got["detail"] and got["run_id"] is None
    assert (await hsvc.get_routine(routine["id"]))["consecutive_failures"] == 1


# -- the numbers of the week ----------------------------------------------------------------------------------------


async def test_week_counts_scheduled_times_of_the_last_seven_days_only(hsvc):
    clock, agent, routine = await setup(hsvc, schedule=EVERY_15)
    fake = hsvc.engines["fake"]
    fake.add(FakeTurn(final_message="Algo novo."))
    fake.add(FakeTurn(fail="boom"))
    for _ in range(2):
        clock.advance(minutes=15, seconds=1)
        await hsvc.tick()
        await settled(hsvc, routine["id"])
    await hsvc.run_routine_now(routine["id"])  # manual: has no time of its own
    await settled(hsvc, routine["id"])
    await hsvc._db(lambda c: c.execute(
        "INSERT INTO agent_routine_runs (id, routine_id, scheduled_for, fired_by, status, created_at)"
        " VALUES ('old', ?, ?, 'schedule', 'failed', 'x')",
        (routine["id"], (T0 - timedelta(days=8)).isoformat(timespec="microseconds"))))
    got = await hsvc.get_routine(routine["id"])
    assert got["week"] == {"ok": 1, "total": 2}


# -- a restart -------------------------------------------------------------------------------------------------------


async def test_restart_closes_a_running_line_whose_run_is_over(hsvc, store, tmp_path):
    agent = await hsvc.create_def(name="Ana", engine="fake")
    routine = await hsvc.create_routine(agent_id=agent["id"], title="T", prompt="p", schedule=DAILY_11)
    gate = asyncio.Event()
    hsvc.engines["fake"].add(FakeTurn(gate=gate))
    out = await hsvc.run_routine_now(routine["id"])
    run_id = out["run"]["id"]
    await wait_run(hsvc, run_id, ("running",))
    await hsvc.stop()  # the backend goes away with the run in progress
    assert (await hsvc.get_run(run_id))["status"] == "running"
    assert (await lines(hsvc, routine["id"]))[0]["status"] == "running"
    # what the next boot finds: the run ended without anyone closing the line
    await hsvc._db(lambda c: c.execute(
        "UPDATE agent_runs SET status = 'failed', error = 'interrupted', finished_at = ? WHERE id = ?",
        (T0.isoformat(), run_id)))
    settings = make_settings(agents_home_dir=str(tmp_path / "casas"), agents_guide_timeout_s=5)
    boot = AgentHarnessService(store, settings, engines={"fake": FakeEngine()}, heartbeat_s=0.2)
    await boot.start()
    try:
        line = (await boot.list_routine_runs(routine["id"], 10))[0]
        assert line["status"] == "failed" and "reiniciou" in line["detail"] and line["finished_at"]
        got = await boot.get_routine(routine["id"])
        assert got["running"] is False and got["consecutive_failures"] == 1 and got["last_status"] == "failed"
    finally:
        await boot.stop()


async def test_restart_closes_a_line_that_never_got_a_run_and_keeps_a_live_one(hsvc):
    agent = await hsvc.create_def(name="Ana", engine="fake")
    routine = await hsvc.create_routine(agent_id=agent["id"], title="T", prompt="p", schedule=DAILY_11)
    clock = Clock(hsvc)
    await hsvc._db(lambda c: c.execute(
        "INSERT INTO agent_routine_runs (id, routine_id, scheduled_for, fired_by, status, created_at)"
        " VALUES ('orfa', ?, 'a', 'schedule', 'running', ?)",
        (routine["id"], (T0 - timedelta(minutes=10)).isoformat(timespec="microseconds"))))
    await hsvc._routine_reconcile()
    got = (await lines(hsvc, routine["id"]))[0]
    assert got["status"] == "failed" and "não chegou a começar" in got["detail"]
    clock.advance(seconds=1)
    gate = asyncio.Event()
    hsvc.engines["fake"].add(FakeTurn(gate=gate))
    out = await hsvc.run_routine_now(routine["id"])
    await wait_run(hsvc, out["run"]["id"], ("running",))
    await hsvc._routine_reconcile()
    assert (await hsvc.get_routine(routine["id"]))["running"] is True  # a live run is left alone
    gate.set()
    await settled(hsvc, routine["id"])


async def test_the_clock_loop_is_started_and_stopped_with_the_service(hsvc):
    assert hsvc._routine_task is not None and not hsvc._routine_task.done()
    task = hsvc._routine_task
    await hsvc.stop()
    assert hsvc._routine_task is None and task.done()
