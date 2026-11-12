"""Phase 1a: recovery after a restart (actions, session, boot decision, stop, continue).

A "crash" is simulated by stopping the first service with a drain of 0 s: its
running turns are cancelled and the run stays ``running`` in the database (what
a kill leaves behind). A second service on the same database is the next boot.
"""

from __future__ import annotations

import asyncio
import os
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

import httpx
import pytest
from fastapi import FastAPI

from seraphine.agents import procutil
from seraphine.agents import schema as agents_schema
from seraphine.agents.actions import open_actions
from seraphine.agents.engines.fake import FakeEngine, FakeTurn
from seraphine.agents.errors import Conflict, NotFound
from seraphine.agents.routes import TOKEN_HEADER, router
from seraphine.agents.service import AgentHarnessService

from .conftest import make_settings, setup_agent, wait_run, wait_until


def started(call_id: str = "c1", command: str = "npm test") -> tuple[str, dict]:
    return ("step", {"type": "command", "phase": "started", "call_id": call_id,
                     "command": command, "by": "agent"})


def completed(call_id: str = "c1", command: str = "npm test") -> tuple[str, dict]:
    return ("command", {"command": command, "exit_code": 0, "output": "ok", "by": "agent",
                        "phase": "completed", "call_id": call_id})


def partial(text: str = "Progresso parcial: migrei a tabela A") -> tuple[str, dict]:
    return ("message", {"text": text})


def service(store, engine: FakeEngine, **settings: Any) -> AgentHarnessService:
    return AgentHarnessService(store, make_settings(**settings), engines={"fake": engine})


async def crash(svc: AgentHarnessService) -> None:
    """What a kill leaves: the turn is cut and the run is still ``running``."""
    svc.shutdown_drain_s = 0
    await svc.stop()


async def wait_events(svc: AgentHarnessService, run_id: str, pred: Callable[[dict], bool]) -> None:
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if any(pred(e) for e in await svc.list_events(run_id)):
            return
        await asyncio.sleep(0.02)
    raise AssertionError("event not seen in time")


async def interrupted_run(store, project_dir: Path, turn: FakeTurn, **agent_over: Any):
    """Boot s1, start a run whose scripted turn blocks, crash. Returns ``(s1, run, agent, project)``."""
    s1 = service(store, FakeEngine(turns=[turn]))
    await s1.start()
    agent, project = await setup_agent(s1, project_dir, **agent_over)
    run = await s1.start_run(agent["id"], project["id"], "migre o banco")
    await wait_run(s1, run["id"], ("running",))
    await wait_until(lambda: s1.engines["fake"].active == 1)
    await asyncio.sleep(0.1)  # let the scripted events reach the database
    await crash(s1)
    assert (await s1.get_run(run["id"]))["status"] == "running"
    return s1, run, agent, project


def gated(*events: tuple[str, dict], **kw: Any) -> FakeTurn:
    return FakeTurn(events=list(events), gate=asyncio.Event(), **kw)


async def messages(svc: AgentHarnessService, project_id: str) -> list[dict]:
    return await svc.list_messages(project_id)


# -- the open-actions helper ---------------------------------------------------------


def ev(kind: str, **payload: Any) -> dict:
    return {"kind": kind, "payload": payload}


def test_open_actions_pairs_started_and_completed():
    events = [
        ev("status", status="running"),
        ev("step", type="command", phase="started", call_id="a"),
        ev("step", type="tool_use", phase="started", call_id="b", tool="Edit"),
        ev("step", type="tool_use", phase="completed", call_id="b", tool="Edit"),
        ev("step", type="reasoning", text="pensando"),  # not an action: no phase
        ev("step", type="file_change", phase="completed", call_id="solo"),  # lone completed
    ]
    assert [a["call_id"] for a in open_actions(events)] == ["a"]


def test_open_actions_command_event_closes_by_call_id_or_approval_id():
    events = [
        ev("step", type="command", phase="started", call_id="x", by="agent"),
        ev("command", command="ls", call_id="x", phase="completed"),
        ev("step", type="command", phase="started", call_id="ap1", by="harness"),
        ev("command", command="echo", by="harness", approval_id="ap1"),  # older shape: approval_id only
        ev("step", type="command", phase="started", call_id="ap2", by="harness"),
    ]
    assert [a["call_id"] for a in open_actions(events)] == ["ap2"]


def test_open_actions_status_event_ends_the_turn():
    events = [
        ev("step", type="command", phase="started", call_id="old"),
        ev("status", status="waiting_approval"),
        ev("status", status="running"),
        ev("step", type="command", phase="started", call_id="new"),
    ]
    assert [a["call_id"] for a in open_actions(events)] == ["new"]
    assert open_actions([]) == []
    assert open_actions([ev("message", text="oi"), {"kind": "step", "payload": None}]) == []


# -- rule 2: the session is saved as soon as it is known -----------------------------


async def test_session_is_persisted_before_the_turn_ends(svc, fake: FakeEngine, project_dir: Path):
    agent, project = await setup_agent(svc, project_dir)
    turn = fake.add(FakeTurn(gate=asyncio.Event(), session_ref="sessao-xyz"))
    run = await svc.start_run(agent["id"], project["id"], "x")
    await wait_until(lambda: fake.active == 1)
    await wait_until_async(lambda: svc.get_run(run["id"]), lambda r: r["session_ref"] == "sessao-xyz")
    assert (await svc.get_run(run["id"]))["status"] == "running"
    # internal kinds are never stored as run events
    assert all(not e["kind"].startswith("_") for e in await svc.list_events(run["id"]))
    turn.gate.set()
    done = await wait_run(svc, run["id"], ("done",))
    assert done["session_ref"] == "sessao-xyz"


async def wait_until_async(get, pred, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if pred(await get()):
            return
        await asyncio.sleep(0.02)
    raise AssertionError("condition not met in time")


# -- rule 4: the three-way decision at boot ------------------------------------------


async def test_open_action_means_interrupted_mid_action_without_resume(store, project_dir: Path):
    turn = gated(partial(), started("c1", "npm run migrate"))
    _, run, agent, project = await interrupted_run(store, project_dir, turn)
    engine2 = FakeEngine()
    s2 = service(store, engine2)
    await s2.start()
    try:
        r = await s2.get_run(run["id"])
        assert r["status"] == "failed" and r["error"] == "interrupted_mid_action"
        assert r["can_continue"] is False and r["recoveries"] == 0
        assert engine2.calls == []  # nothing was resumed
        msg = (await messages(s2, project["id"]))[-1]
        assert msg["author"] == agent["id"] and msg["run_id"] == run["id"]
        assert "npm run migrate" in msg["body"] and "Progresso parcial: migrei a tabela A" in msg["body"]
        assert "reiniciou" in msg["body"] and "não retomei" in msg["body"]
        notes = [e for e in await s2.list_events(run["id"]) if e["payload"].get("type") == "note"]
        assert notes and "reiniciou" in notes[-1]["payload"]["text"]
        with pytest.raises(Conflict) as exc:
            await s2.continue_run(run["id"])
        assert exc.value.code == "continue_not_allowed"
    finally:
        await s2.stop()


async def test_approved_command_cut_midway_is_not_rerun(store, project_dir: Path):
    sleeper = ("Add-Content -Path marker.txt -Value x; Start-Sleep -Seconds 60" if os.name == "nt"
               else "echo x >> marker.txt; sleep 60")
    e1 = FakeEngine(turns=[
        FakeTurn(final_message="Preciso rodar.", approval={"title": "Rodar", "command": sleeper, "reason": "r"}),
        FakeTurn(gate=asyncio.Event()),
    ])
    s1 = service(store, e1)
    await s1.start()
    agent, project = await setup_agent(s1, project_dir)
    run = await s1.start_run(agent["id"], project["id"], "x")
    await wait_run(s1, run["id"], ("waiting_approval",))
    (ap,) = await s1.list_approvals(status="pending")
    await s1.decide_approval(ap["id"], "approve", digest=ap["command_digest"], confirm_high_risk=True)
    await wait_events(s1, run["id"], lambda e: e["kind"] == "step" and e["payload"].get("phase") == "started")
    await wait_until_async(lambda: s1._raw_run(run["id"]), lambda r: r["engine_pid"] is not None)
    marker = project_dir / "marker.txt"
    await wait_until(marker.exists, timeout=10)
    await crash(s1)
    assert (await s1.get_run(run["id"]))["status"] == "running"

    engine2 = FakeEngine()
    s2 = service(store, engine2)
    await s2.start()
    try:
        r = await s2.get_run(run["id"])
        assert r["status"] == "failed" and r["error"] == "interrupted_mid_action" and not r["can_continue"]
        assert engine2.calls == []
        stored = await s2.get_approval(ap["id"])
        assert stored["status"] == "approved" and "pode ter rodado em parte" in stored["output"]
        assert len(marker.read_text().split()) == 1  # ran once, never again
        assert (await s2.list_events(run["id"]))[-2]["payload"].get("type") == "note"
    finally:
        await s2.stop()


async def test_no_open_action_resumes_the_same_session_with_a_note(store, project_dir: Path):
    turn = gated(started("c1"), completed("c1"), partial("Parte 1 pronta"), session_ref="sessao-1")
    _, run, agent, project = await interrupted_run(store, project_dir, turn)
    engine2 = FakeEngine(turns=[FakeTurn(final_message="Tudo terminado.")])
    s2 = service(store, engine2)
    await s2.start()
    try:
        done = await wait_run(s2, run["id"], ("done",))
        assert done["recoveries"] == 1 and done["can_continue"] is False
        assert done["result_summary"] == "Tudo terminado."
        # same session, delivered through resume with the note; no fresh start
        assert [c["op"] for c in engine2.calls] == ["resume"]
        call = engine2.calls[0]
        assert call["session_ref"] == "sessao-1"
        assert "reiniciou" in call["message"] and "continua feito" in call["message"]
        assert "migre o banco" in call["message"]  # the goal is restated
        assert "Não repita ações já concluídas" in call["message"]
        events = await s2.list_events(run["id"])
        queued = [e["payload"] for e in events if e["kind"] == "status" and e["payload"].get("reason") == "recovered"]
        assert queued == [{"status": "queued", "reason": "recovered", "recoveries": 1}]
        notes = [e["payload"] for e in events if e["kind"] == "step" and e["payload"].get("reason") == "recovered"]
        assert notes == [{"type": "note", "reason": "recovered", "text": "Retomada depois de um reinício (1ª vez)."}]
        bodies = [m["body"] for m in await messages(s2, project["id"])]
        assert any("retomando" in b for b in bodies)
        assert (await s2._raw_run(run["id"]))["resume_note"] is None  # delivered once, then cleared
    finally:
        await s2.stop()


async def test_resume_note_carries_a_harness_command_the_engine_may_not_have_seen(store, project_dir: Path):
    """Crash while the engine was being told the result of an approved command."""
    cmd = "Write-Output saida-aprovada" if os.name == "nt" else "echo saida-aprovada"
    e1 = FakeEngine(turns=[
        FakeTurn(final_message="Preciso rodar.", approval={"title": "Eco", "command": cmd, "reason": "r"}),
        FakeTurn(gate=asyncio.Event()),  # the resume that delivers the command result
    ])
    s1 = service(store, e1)
    await s1.start()
    agent, project = await setup_agent(s1, project_dir)
    run = await s1.start_run(agent["id"], project["id"], "x")
    await wait_run(s1, run["id"], ("waiting_approval",))
    (ap,) = await s1.list_approvals(status="pending")
    await s1.decide_approval(ap["id"], "approve", digest=ap["command_digest"], confirm_high_risk=True)
    await wait_until(lambda: e1.active == 1)
    await crash(s1)

    engine2 = FakeEngine(turns=[FakeTurn(final_message="ok")])
    s2 = service(store, engine2)
    await s2.start()
    try:
        done = await wait_run(s2, run["id"], ("done",))
        assert done["recoveries"] == 1
        assert [c["op"] for c in engine2.calls] == ["resume"]
        assert "saida-aprovada" in engine2.calls[0]["message"]
        assert "APROVOU" not in engine2.calls[0]["message"]  # not delivered twice as a decision
    finally:
        await s2.stop()


async def test_crash_before_the_engine_did_anything_starts_over_with_the_full_prompt(store, project_dir: Path):
    """A session id is known right away, but the engine has not stored the prompt in it yet."""
    turn = gated(session_ref="sessao-cedo")  # session reported, no engine event
    s1, run, agent, project = await interrupted_run(store, project_dir, turn)
    assert (await s1.get_run(run["id"]))["session_ref"] == "sessao-cedo"
    engine2 = FakeEngine(turns=[FakeTurn(final_message="comecei")])
    s2 = service(store, engine2)
    await s2.start()
    try:
        done = await wait_run(s2, run["id"], ("done",))
        assert done["recoveries"] == 1
        assert [c["op"] for c in engine2.calls] == ["run"]  # not resume
        prompt = engine2.calls[0]["ctx"].prompt
        assert prompt.startswith("AVISO DO SISTEMA: o sistema reiniciou antes de você começar")
        assert "migre o banco" in prompt and "POLÍTICA DE SEGURANÇA" in prompt  # the full composed prompt
        assert done["session_ref"] != "sessao-cedo"  # the stale session was dropped
        events = await s2.list_events(run["id"])
        assert [e["payload"] for e in events if e["kind"] == "status" and e["payload"].get("reason") == "recovered"] == [
            {"status": "queued", "reason": "recovered", "recoveries": 1}]
        notes = [e["payload"] for e in events if e["kind"] == "step" and e["payload"].get("reason") == "recovered"]
        assert [n["text"] for n in notes] == ["Recomeçou depois de um reinício (1ª vez)."]
        bodies = [m["body"] for m in await messages(s2, project["id"])]
        assert any("começando de novo" in b for b in bodies) and not any("retomando de onde" in b for b in bodies)
        assert (await s2._raw_run(run["id"]))["resume_note"] is None
    finally:
        await s2.stop()


async def test_fresh_restart_still_obeys_the_recovery_limit(store, project_dir: Path):
    s1, run, _, project = await interrupted_run(store, project_dir, gated(session_ref="sessao-cedo"))
    await s1._db(lambda c: _already_recovered_twice(c, run["id"]))
    engine2 = FakeEngine()
    s2 = service(store, engine2)
    await s2.start()
    try:
        r = await s2.get_run(run["id"])
        assert r["status"] == "failed" and r["error"] == "interrupted" and r["can_continue"] is True
        assert engine2.calls == []
    finally:
        await s2.stop()


async def test_a_later_turn_resumes_even_without_an_engine_event_in_it(store, project_dir: Path):
    cmd = "Write-Output ok-aprovado" if os.name == "nt" else "echo ok-aprovado"
    e1 = FakeEngine(turns=[
        FakeTurn(final_message="Preciso rodar.", approval={"title": "Eco", "command": cmd, "reason": "r"},
                 session_ref="sessao-longa"),
        FakeTurn(events=[], gate=asyncio.Event()),  # after the decision: nothing of its own yet
    ])
    s1 = service(store, e1)
    await s1.start()
    agent, project = await setup_agent(s1, project_dir)
    run = await s1.start_run(agent["id"], project["id"], "x")
    await wait_run(s1, run["id"], ("waiting_approval",))
    (ap,) = await s1.list_approvals(status="pending")
    await s1.decide_approval(ap["id"], "approve", digest=ap["command_digest"], confirm_high_risk=True)
    await wait_until(lambda: e1.active == 1)
    await asyncio.sleep(0.1)
    await crash(s1)
    engine2 = FakeEngine(turns=[FakeTurn(final_message="ok")])
    s2 = service(store, engine2)
    await s2.start()
    try:
        done = await wait_run(s2, run["id"], ("done",))
        assert done["recoveries"] == 1
        assert [c["op"] for c in engine2.calls] == ["resume"]
        assert engine2.calls[0]["session_ref"] == "sessao-longa"
    finally:
        await s2.stop()


def _too_old(conn: Any, rid: str) -> None:
    old = (datetime.now(timezone.utc) - timedelta(hours=7)).isoformat()
    conn.execute("UPDATE agent_runs SET started_at = ? WHERE id = ?", (old, rid))


def _already_recovered_twice(conn: Any, rid: str) -> None:
    conn.execute("UPDATE agent_runs SET recoveries = 2 WHERE id = ?", (rid,))


@pytest.mark.parametrize("why,mutate,engine_kw,turn_kw", [
    ("third attempt", _already_recovered_twice, {}, {}),
    ("too old", _too_old, {}, {}),
    ("engine cannot resume", None, {"resumable": False}, {}),
    ("no session", None, {}, {"emit_session": False}),
])
async def test_other_cases_end_as_interrupted_and_can_be_continued(
        store, project_dir: Path, why: str, mutate, engine_kw: dict, turn_kw: dict):
    turn = gated(partial(), **turn_kw)
    s1, run, agent, project = await interrupted_run(store, project_dir, turn)
    if mutate is not None:
        await s1._db(lambda c: mutate(c, run["id"]))
    engine2 = FakeEngine(**engine_kw)
    s2 = service(store, engine2)
    await s2.start()
    try:
        r = await s2.get_run(run["id"])
        assert r["status"] == "failed" and r["error"] == "interrupted", why
        assert r["can_continue"] is True and r["recoveries"] == (2 if why == "third attempt" else 0)
        assert engine2.calls == []
        msg = (await messages(s2, project["id"]))[-1]
        assert msg["author"] == agent["id"] and "Progresso parcial: migrei a tabela A" in msg["body"]
        assert "não consegui retomar sozinho" in msg["body"] and "continuar" in msg["body"]
    finally:
        await s2.stop()


async def test_partial_text_in_the_channel_message_is_capped_at_2000_chars(store, project_dir: Path):
    turn = gated(partial("Z" * 5000))
    _, run, _, project = await interrupted_run(store, project_dir, turn)
    s2 = service(store, FakeEngine(resumable=False))
    await s2.start()
    try:
        body = (await messages(s2, project["id"]))[-1]["body"]
        assert body.count("Z") == 2000
    finally:
        await s2.stop()


async def test_queued_and_waiting_runs_are_untouched_by_a_restart(store, project_dir: Path):
    s1 = service(store, FakeEngine(turns=[FakeTurn(approval={"title": "t", "command": "echo hi", "reason": "r"})]))
    await s1.start()
    agent, project = await setup_agent(s1, project_dir)
    waiting = await s1.start_run(agent["id"], project["id"], "a")
    await wait_run(s1, waiting["id"], ("waiting_approval",))
    await s1.stop()
    s2 = service(store, FakeEngine())
    await s2.start()
    try:
        r = await s2.get_run(waiting["id"])
        assert r["status"] == "waiting_approval" and r["recoveries"] == 0
    finally:
        await s2.stop()


async def test_decision_not_yet_delivered_still_wins_and_the_command_runs_once(store, project_dir: Path):
    cmd = ("Add-Content -Path once.txt -Value x" if os.name == "nt" else "echo x >> once.txt")
    e1 = FakeEngine(turns=[FakeTurn(approval={"title": "Gravar", "command": cmd, "reason": "r"})])
    s1 = service(store, e1)
    await s1.start()
    agent, project = await setup_agent(s1, project_dir)
    run = await s1.start_run(agent["id"], project["id"], "x")
    await wait_run(s1, run["id"], ("waiting_approval",))
    await s1.stop()  # from here on the scheduler does not start anything
    (ap,) = await s1.list_approvals(status="pending")
    await s1.decide_approval(ap["id"], "approve", digest=ap["command_digest"], confirm_high_risk=True)
    # crash right after the scheduler claimed the run, before the command started
    await s1._db(lambda c: c.execute("UPDATE agent_runs SET status = 'running' WHERE id = ?", (run["id"],)))

    engine2 = FakeEngine(turns=[FakeTurn(final_message="feito")])
    s2 = service(store, engine2)
    await s2.start()
    try:
        done = await wait_run(s2, run["id"], ("done",))
        assert done["recoveries"] == 1
        assert (project_dir / "once.txt").read_text().split() == ["x"]  # exactly once
        assert [c["op"] for c in engine2.calls] == ["resume"]
        assert "APROVOU" in engine2.calls[0]["message"]  # the decision, not the restart note
        assert "AVISO DO SISTEMA" not in engine2.calls[0]["message"]
    finally:
        await s2.stop()


async def test_command_already_run_but_not_recorded_on_the_approval_is_never_rerun(store, project_dir: Path):
    cmd = ("Add-Content -Path never.txt -Value x" if os.name == "nt" else "echo x >> never.txt")
    e1 = FakeEngine(turns=[FakeTurn(approval={"title": "Gravar", "command": cmd, "reason": "r"})])
    s1 = service(store, e1)
    await s1.start()
    agent, project = await setup_agent(s1, project_dir)
    run = await s1.start_run(agent["id"], project["id"], "x")
    await wait_run(s1, run["id"], ("waiting_approval",))
    await s1.stop()
    (ap,) = await s1.list_approvals(status="pending")
    await s1.decide_approval(ap["id"], "approve", digest=ap["command_digest"], confirm_high_risk=True)
    await s1._db(lambda c: c.execute("UPDATE agent_runs SET status = 'running' WHERE id = ?", (run["id"],)))
    # the command ran and its event was stored, but the crash came before approval.output was written
    await s1._emit(run["id"], "step", {"type": "command", "phase": "started", "call_id": ap["id"],
                                       "command": cmd, "by": "harness"})
    await s1._emit(run["id"], "command", {"command": cmd, "exit_code": 0, "output": "saida-gravada",
                                          "by": "harness", "approval_id": ap["id"], "phase": "completed",
                                          "call_id": ap["id"]})
    engine2 = FakeEngine(turns=[FakeTurn(final_message="ok")])
    s2 = service(store, engine2)
    await s2.start()
    try:
        await wait_run(s2, run["id"], ("done",))
        assert not (project_dir / "never.txt").exists()
        assert (await s2.get_approval(ap["id"]))["output"] == "saida-gravada"
        assert "saida-gravada" in engine2.calls[0]["message"]
    finally:
        await s2.stop()


# -- rule 5: two-phase stop ----------------------------------------------------------


async def test_stop_leaves_a_cut_run_running_and_the_next_boot_resolves_it(store, project_dir: Path):
    turn = gated(started("c1"), completed("c1"))
    s1, run, _, _ = await interrupted_run(store, project_dir, turn)
    r = await s1.get_run(run["id"])
    assert r["status"] == "running" and r["error"] is None and r["finished_at"] is None
    s2 = service(store, FakeEngine(turns=[FakeTurn(final_message="fim")]))
    await s2.start()
    try:
        assert (await wait_run(s2, run["id"], ("done",)))["recoveries"] == 1
    finally:
        await s2.stop()


async def test_drain_lets_a_short_turn_finish(store, project_dir: Path):
    turn = FakeTurn(gate=asyncio.Event(), final_message="terminei")
    s1 = service(store, FakeEngine(turns=[turn]), agents_shutdown_drain_s=5)
    await s1.start()
    agent, project = await setup_agent(s1, project_dir)
    run = await s1.start_run(agent["id"], project["id"], "x")
    await wait_until(lambda: s1.engines["fake"].active == 1)
    asyncio.get_running_loop().call_later(0.3, turn.gate.set)
    started_at = time.monotonic()
    await s1.stop()
    assert time.monotonic() - started_at < 4
    assert (await s1.get_run(run["id"]))["status"] == "done"


async def test_stop_starts_no_new_run_and_owner_cancel_during_the_drain_still_cancels(store, project_dir: Path):
    gate = asyncio.Event()
    s1 = service(store, FakeEngine(turns=[FakeTurn(gate=gate, when="primeira")]), agents_shutdown_drain_s=5)
    await s1.start()
    agent, project = await setup_agent(s1, project_dir)
    first = await s1.start_run(agent["id"], project["id"], "primeira")
    second = await s1.start_run(agent["id"], project["id"], "segunda")  # waits behind the first
    await wait_until(lambda: s1.engines["fake"].active == 1)
    stopper = asyncio.create_task(s1.stop())
    await asyncio.sleep(0.1)
    cancelled = await s1.cancel_run(first["id"])
    assert cancelled["status"] == "cancelled" and cancelled["can_continue"] is True
    await asyncio.wait_for(stopper, 5)
    assert (await s1.get_run(second["id"]))["status"] == "queued"  # never started during the stop


# -- rule 1: no engine outlives the backend --------------------------------------------


def _sleeper() -> subprocess.Popen:
    return subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"], **procutil.spawn_kwargs())


async def _seed_running_with_pid(store, project_dir: Path, pid: int, created: int | None) -> tuple[Any, str]:
    s1 = service(store, FakeEngine())
    await s1.start()
    agent, project = await setup_agent(s1, project_dir)
    await s1.stop()
    rid = "r-orfao"

    def seed(conn):
        conn.execute(
            "INSERT INTO agent_runs (id, agent_id, project_id, goal, status, engine, session_ref, created_at,"
            " started_at, engine_pid, engine_pid_created) VALUES (?, ?, ?, 'g', 'running', 'fake', 's', ?, ?, ?, ?)",
            (rid, agent["id"], project["id"], datetime.now(timezone.utc).isoformat(),
             datetime.now(timezone.utc).isoformat(), pid, created))

    await s1._db(seed)
    return s1, rid


async def test_boot_kills_a_recorded_engine_process_that_is_the_same_process(store, project_dir: Path):
    child = _sleeper()
    try:
        created = procutil.process_creation_time(child.pid)
        if created is None:
            pytest.skip("este sistema não informa o instante de criação do processo")
        _, rid = await _seed_running_with_pid(store, project_dir, child.pid, created)
        s2 = service(store, FakeEngine(turns=[FakeTurn(final_message="ok")]))
        await s2.start()
        try:
            assert await asyncio.to_thread(child.wait, 10) is not None  # the orphan is gone
            raw = await s2._raw_run(rid)
            assert raw["engine_pid"] is None and raw["engine_pid_created"] is None
        finally:
            await s2.stop()
    finally:
        child.kill()
        child.wait()


async def test_boot_never_kills_a_reused_pid(store, project_dir: Path):
    child = _sleeper()
    try:
        created = procutil.process_creation_time(child.pid)
        if created is None:
            pytest.skip("este sistema não informa o instante de criação do processo")
        for wrong in (created + 12345, None):  # another process now owns the pid / unreadable time
            _, rid = await _seed_running_with_pid(store, project_dir, child.pid, wrong)
            s2 = service(store, FakeEngine(turns=[FakeTurn(final_message="ok")]))
            await s2.start()
            await s2.stop()
            assert child.poll() is None
            await s2._db(lambda c: c.execute("DELETE FROM agent_runs WHERE id = ?", (rid,)))
    finally:
        child.kill()
        child.wait()


async def test_every_spawn_is_assigned_to_the_job_and_reports_its_pid(tmp_path: Path, monkeypatch):
    tracked: list[int] = []
    monkeypatch.setattr(procutil, "assign_to_job", lambda pid: tracked.append(pid) or True)
    reported: list[tuple[int, int | None]] = []

    async def on_spawn(pid: int, created: int | None) -> None:
        reported.append((pid, created))

    async def on_line(_line: str) -> None:
        pass

    await procutil.run_lines([sys.executable, "-c", "print('oi')"], cwd=str(tmp_path), stdin_text="",
                             on_line=on_line, cancel=asyncio.Event(), on_spawn=on_spawn)
    code, out, _, _ = await procutil.run_shell_command(
        "echo oi", cwd=str(tmp_path), timeout_s=30, cancel=asyncio.Event(), on_spawn=on_spawn)
    assert code == 0 and len(tracked) == 2 and [p for p, _ in reported] == tracked


@pytest.mark.skipif(os.name != "nt", reason="Job Object é recurso do Windows")
def test_job_object_kills_the_child_when_the_owner_dies_abruptly(tmp_path: Path):
    helper = (
        "import os, subprocess, sys\n"
        "from seraphine.agents import procutil\n"
        "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'],"
        " **procutil.spawn_kwargs())\n"
        "ok = procutil.assign_to_job(child.pid)\n"
        "print(child.pid, ok, flush=True)\n"
        "os._exit(3)\n"  # abrupt: no cleanup, no atexit
    )
    out = subprocess.run([sys.executable, "-c", helper], capture_output=True, text=True, timeout=60,
                         env=os.environ.copy())
    assert out.returncode == 3, out.stderr
    pid_text, ok_text = out.stdout.split()
    assert ok_text == "True", "o Job Object não foi criado ou o processo não foi atribuído"
    pid = int(pid_text)
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and procutil.process_creation_time(pid) is not None:
        time.sleep(0.1)
    assert procutil.process_creation_time(pid) is None, "o filho sobreviveu à morte do dono"


# -- rule 6: continue ----------------------------------------------------------------


async def test_continue_a_cancelled_run_resumes_its_session(svc, fake: FakeEngine, project_dir: Path):
    agent, project = await setup_agent(svc, project_dir)
    task = await svc.create_task(project_id=project["id"], title="T")
    fake.add(FakeTurn(gate=asyncio.Event(), session_ref="sessao-9"))
    old = await svc.start_run(agent["id"], project["id"], "faça X", task_id=task["id"])
    await wait_until(lambda: fake.active == 1)
    await wait_until_async(lambda: svc.get_run(old["id"]), lambda r: r["session_ref"] == "sessao-9")
    await svc.cancel_run(old["id"])
    old = await svc.get_run(old["id"])
    assert old["status"] == "cancelled" and old["can_continue"] is True and old["continued_by"] is None

    fake.add(FakeTurn(final_message="continuei"))
    new = await svc.continue_run(old["id"])
    assert new["id"] != old["id"] and new["continued_from"] == old["id"] and new["continued_by"] is None
    assert (new["agent_id"], new["project_id"], new["task_id"], new["goal"]) == (
        agent["id"], project["id"], task["id"], "faça X")
    done = await wait_run(svc, new["id"], ("done",))
    resumes = [c for c in fake.calls if c["op"] == "resume"]
    assert len(resumes) == 1 and resumes[0]["session_ref"] == "sessao-9"
    assert "continuar esta tarefa" in resumes[0]["message"] and "continua feito" in resumes[0]["message"]
    assert "faça X" in resumes[0]["message"] and "Tarefa: T" in resumes[0]["message"]
    assert done["result_summary"] == "continuei"
    old = await svc.get_run(old["id"])
    assert old["continued_by"] == new["id"] and old["can_continue"] is False
    with pytest.raises(Conflict) as exc:
        await svc.continue_run(old["id"])
    assert exc.value.code == "already_continued"


async def test_continue_starts_fresh_when_the_old_session_cannot_be_resumed(store, project_dir: Path):
    turn = gated(partial(), emit_session=False)
    _, run, _, _ = await interrupted_run(store, project_dir, turn)
    engine2 = FakeEngine(turns=[FakeTurn(final_message="de novo")])
    s2 = service(store, engine2)
    await s2.start()
    try:
        old = await s2.get_run(run["id"])
        assert old["error"] == "interrupted" and old["can_continue"] is True
        new = await s2.continue_run(old["id"])
        await wait_run(s2, new["id"], ("done",))
        assert [c["op"] for c in engine2.calls] == ["run"]
        prompt = engine2.calls[0]["ctx"].prompt
        assert "migre o banco" in prompt and "segunda tentativa" in prompt
    finally:
        await s2.stop()


async def test_continue_refusals(svc, fake: FakeEngine, project_dir: Path):
    agent, project = await setup_agent(svc, project_dir)
    done = await wait_run(svc, (await svc.start_run(agent["id"], project["id"], "a"))["id"], ("done",))
    assert done["can_continue"] is False
    with pytest.raises(Conflict) as exc:
        await svc.continue_run(done["id"])
    assert exc.value.code == "continue_not_allowed"
    with pytest.raises(NotFound):
        await svc.continue_run("nao-existe")

    # failed for another reason than the restart: not allowed either
    fake.add(FakeTurn(fail="quebrou"))
    failed = await wait_run(svc, (await svc.start_run(agent["id"], project["id"], "b"))["id"], ("failed",))
    assert failed["can_continue"] is False
    with pytest.raises(Conflict) as exc:
        await svc.continue_run(failed["id"])
    assert exc.value.code == "continue_not_allowed"

    # the agent is busy with another run
    fake.add(FakeTurn(gate=asyncio.Event(), when="c"))
    fake.add(FakeTurn(gate=asyncio.Event(), when="d"))
    victim = await svc.start_run(agent["id"], project["id"], "c")
    await wait_until(lambda: fake.active == 1)
    await svc.cancel_run(victim["id"])
    blocker = await svc.start_run(agent["id"], project["id"], "d")
    await wait_until(lambda: fake.active == 1)
    with pytest.raises(Conflict) as exc:
        await svc.continue_run(victim["id"])
    assert exc.value.code == "agent_busy"
    assert (await svc.get_run(victim["id"]))["continued_by"] is None  # nothing was half-written
    await svc.cancel_run(blocker["id"])


# -- the run object everywhere ---------------------------------------------------------

NEW_FIELDS = {"recoveries", "can_continue", "continued_from", "continued_by"}


async def test_new_run_fields_are_present_in_every_place_a_run_is_returned(svc, fake: FakeEngine, project_dir: Path):
    agent, project = await setup_agent(svc, project_dir)
    frames: list[dict] = []

    async def listen() -> None:
        async for evt in svc.subscribe_all():
            frames.append(evt)

    listener = asyncio.create_task(listen())
    await asyncio.sleep(0.05)
    fake.add(FakeTurn(gate=asyncio.Event()))
    run = await svc.start_run(agent["id"], project["id"], "a")
    await wait_until(lambda: fake.active == 1)
    overview = await svc.overview()
    listing = await svc.list_runs()
    await svc.cancel_run(run["id"])
    listener.cancel()
    await asyncio.gather(listener, return_exceptions=True)
    updates = [f["run"] for f in frames if f.get("type") == "run_update"]
    assert updates and all(NEW_FIELDS <= set(r) for r in updates)
    assert all(NEW_FIELDS <= set(r) for r in overview["active_runs"] + listing)
    assert NEW_FIELDS <= set(await svc.get_run(run["id"]))
    for hidden in ("engine_pid", "engine_pid_created", "resume_note"):
        assert hidden not in (await svc.get_run(run["id"]))
    assert updates[-1]["status"] == "cancelled" and updates[-1]["can_continue"] is True


@pytest.fixture
def app(svc: AgentHarnessService) -> FastAPI:
    a = FastAPI()
    a.include_router(router)
    a.state.agent_harness = svc
    return a


async def test_continue_route(app: FastAPI, svc: AgentHarnessService, fake: FakeEngine, project_dir: Path):
    agent, project = await setup_agent(svc, project_dir)
    fake.add(FakeTurn(gate=asyncio.Event(), session_ref="sess-http"))
    old = await svc.start_run(agent["id"], project["id"], "x")
    await wait_until(lambda: fake.active == 1)
    await wait_until_async(lambda: svc.get_run(old["id"]), lambda r: r["session_ref"] == "sess-http")
    await svc.cancel_run(old["id"])
    h = {TOKEN_HEADER: svc.token}
    transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 50000))
    async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8000") as c:
        missing = await c.post("/agents/runs/nao-existe/continue", headers=h)
        assert missing.status_code == 404 and missing.headers["cache-control"] == "no-store"
        assert (await c.post(f"/agents/runs/{old['id']}/continue")).status_code == 401
        ok = await c.post(f"/agents/runs/{old['id']}/continue", headers=h)
        assert ok.status_code == 200 and ok.headers["cache-control"] == "no-store"
        run = ok.json()["run"]
        assert run["continued_from"] == old["id"] and NEW_FIELDS <= set(run)
        again = await c.post(f"/agents/runs/{old['id']}/continue", headers=h)
        assert again.status_code == 409 and again.headers["cache-control"] == "no-store"
        assert again.json()["code"] == "already_continued" and "detail" in again.json()
        got = (await c.get(f"/agents/runs/{old['id']}", headers=h)).json()["run"]
        assert got["continued_by"] == run["id"] and got["can_continue"] is False
        await wait_run(svc, run["id"], ("done",))
        done = await c.post(f"/agents/runs/{run['id']}/continue", headers=h)
        assert done.status_code == 409 and done.json()["code"] == "continue_not_allowed"


# -- schema --------------------------------------------------------------------------


def test_migration_is_idempotent_on_a_database_from_before_these_columns(tmp_path: Path):
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
                 " VALUES ('r1', 'a', 'p', 'g', 'running', 'codex', '2026-01-01')")
    conn.commit()
    agents_schema.migrate(conn)
    agents_schema.migrate(conn)  # twice: no error, nothing duplicated
    cols = {r[1] for r in conn.execute("PRAGMA table_info(agent_runs)")}
    assert {"recoveries", "continued_from", "continued_by", "engine_pid", "engine_pid_created",
            "resume_note"} <= cols
    row = conn.execute("SELECT recoveries, continued_from, engine_pid FROM agent_runs WHERE id = 'r1'").fetchone()
    assert row == (0, None, None)
    conn.close()
