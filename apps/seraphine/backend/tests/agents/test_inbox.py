"""Phase 1c: a message in the middle of the work (inbox, burst window, interrupt, stop, continue)."""

from __future__ import annotations

import asyncio
import sqlite3
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from seraphine.agents import schema as agents_schema
from seraphine.agents import service as service_module
from seraphine.agents.engines.fake import FakeEngine, FakeTurn
from seraphine.agents.errors import Conflict
from seraphine.agents.routes import TOKEN_HEADER, router
from seraphine.agents.service import AgentHarnessService

from .conftest import make_settings, setup_agent, wait_run, wait_until, write_file_command


def tap(svc: AgentHarnessService) -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue()
    svc._global_subs.add(q)
    return q


def drain(q: asyncio.Queue) -> list[dict]:
    out = []
    while not q.empty():
        out.append(q.get_nowait())
    return out


def gated(*events: tuple[str, dict], **kw: Any) -> FakeTurn:
    return FakeTurn(events=list(events), gate=asyncio.Event(), **kw)


def started(call_id: str = "c1", command: str = "npm run migrate") -> tuple[str, dict]:
    return ("step", {"type": "command", "phase": "started", "call_id": call_id,
                     "command": command, "by": "agent"})


def service(store, engine: FakeEngine, **settings: Any) -> AgentHarnessService:
    return AgentHarnessService(store, make_settings(**settings), engines={"fake": engine})


async def start_busy(svc, fake, project_dir, *turns: FakeTurn):
    """A run whose first scripted turn is held open. Returns ``(agent, project, run)``."""
    agent, project = await setup_agent(svc, project_dir)
    for t in turns:
        fake.add(t)
    run = (await svc.post_message(project["id"], "primeiro pedido", agent_id=agent["id"]))["run"]
    await wait_until(lambda: fake.active == 1)
    return agent, project, run


async def say(svc, project, agent, text: str, **kw: Any) -> dict:
    return await svc.post_message(project["id"], text, agent_id=agent["id"], **kw)


async def notes(svc, run_id: str, reason: str) -> list[dict]:
    return [e["payload"] for e in await svc.list_events(run_id, limit=100_000)
            if e["kind"] == "step" and e["payload"].get("reason") == reason]


async def by_body(svc, project_id: str, body: str) -> dict:
    return next(m for m in await svc.list_messages(project_id) if m["body"] == body)


# -- join ------------------------------------------------------------------------------


async def test_message_to_busy_agent_joins_the_run(svc, fake, project_dir):
    gate = asyncio.Event()
    agent, project, run = await start_busy(svc, fake, project_dir, FakeTurn(gate=gate))
    out = await say(svc, project, agent, "e mais isto")
    assert out["joined"] is True and out["interrupted"] is False and out["error"] is None
    assert out["run"]["id"] == run["id"] and out["run"]["inbox_count"] == 1
    assert out["message"]["run_id"] == run["id"] and out["message"]["delivery"] == "pending"
    assert len(await svc.list_runs(project["id"])) == 1  # no new run
    listed = await by_body(svc, project["id"], "e mais isto")
    assert listed["delivery"] == "pending" and (await svc.get_run(run["id"]))["inbox_count"] == 1
    ov = await svc.overview()
    assert [r["inbox_count"] for r in ov["active_runs"]] == [1]
    gate.set()
    await wait_run(svc, run["id"], ("done",))


async def test_busy_in_another_project_still_queues_a_new_run(svc, fake, project_dir, tmp_path):
    gate = asyncio.Event()
    agent, project_a = await setup_agent(svc, project_dir)
    other = tmp_path / "projeto-b"
    other.mkdir()
    project_b = await svc.create_project(name="B", path=str(other))
    await svc.update_def(agent["id"], project_ids=[project_a["id"], project_b["id"]])
    fake.add(FakeTurn(gate=gate))
    run_a = (await say(svc, project_a, agent, "trabalho A"))["run"]
    await wait_until(lambda: fake.active == 1)
    out = await say(svc, project_b, agent, "trabalho B")
    assert out["joined"] is False and out["run"]["id"] != run_a["id"]
    assert out["run"]["status"] == "queued" and out["message"]["delivery"] is None
    gate.set()
    await wait_run(svc, out["run"]["id"], ("done",))


async def test_delivery_at_the_end_of_the_turn_resumes_the_same_session(svc, fake, project_dir):
    gate = asyncio.Event()
    q = tap(svc)
    agent, project, run = await start_busy(svc, fake, project_dir, FakeTurn(gate=gate, final_message="Parte 1."))
    out = await say(svc, project, agent, "ajuste o título")
    gate.set()
    done = await wait_run(svc, run["id"], ("done",))
    assert [c["op"] for c in fake.calls] == ["run", "resume"]
    assert fake.calls[1]["session_ref"] == done["session_ref"]
    assert "ajuste o título" in fake.calls[1]["message"]
    msg = await by_body(svc, project["id"], "ajuste o título")
    assert msg["delivery"] == "delivered" and done["inbox_count"] == 0
    note = (await notes(svc, run["id"], "inbox"))[0]
    assert note["type"] == "note" and note["count"] == 1 and note["text"] == "Leu 1 mensagem nova."
    frames = [f for f in drain(q) if f["type"] == "message_update"]
    assert [f["message"]["id"] for f in frames] == [out["message"]["id"]]
    assert frames[0]["message"]["delivery"] == "delivered"
    agent_texts = [m["body"] for m in await svc.list_messages(project["id"]) if m["author"] == agent["id"]]
    assert agent_texts == ["Parte 1.", "Concluído."]  # the first part is shown, then the final answer


async def test_two_messages_in_one_turn_are_delivered_together_in_order(svc, fake, project_dir):
    gate = asyncio.Event()
    agent, project, run = await start_busy(svc, fake, project_dir, FakeTurn(gate=gate))
    await say(svc, project, agent, "primeira nova")
    await say(svc, project, agent, "segunda nova")
    assert (await svc.get_run(run["id"]))["inbox_count"] == 2
    gate.set()
    await wait_run(svc, run["id"], ("done",))
    resumes = [c for c in fake.calls if c["op"] == "resume"]
    assert len(resumes) == 1
    text = resumes[0]["message"]
    assert "2 mensagens novas" in text and text.index("primeira nova") < text.index("segunda nova")
    assert (await notes(svc, run["id"], "inbox"))[0]["count"] == 2


async def test_turn_with_nothing_new_after_a_delivery_ends_the_run(svc, fake, project_dir):
    gate = asyncio.Event()
    agent, project, run = await start_busy(svc, fake, project_dir, FakeTurn(gate=gate))
    await say(svc, project, agent, "mais uma")
    gate.set()
    await wait_run(svc, run["id"], ("done",))
    assert len(fake.calls) == 2 and (await svc.get_run(run["id"]))["status"] == "done"


async def test_delivery_cap_fails_the_run_clearly(svc, fake, project_dir, monkeypatch):
    monkeypatch.setattr(service_module, "MAX_INBOX_DELIVERIES_PER_RUN", 1)
    g1, g2 = asyncio.Event(), asyncio.Event()
    agent, project, run = await start_busy(svc, fake, project_dir, FakeTurn(gate=g1), FakeTurn(gate=g2))
    await say(svc, project, agent, "um")
    g1.set()
    await wait_until(lambda: len(fake.calls) == 2 and fake.active == 1)
    await say(svc, project, agent, "dois")
    g2.set()
    failed = await wait_run(svc, run["id"], ("failed",))
    assert failed["error"] == "inbox_limit"
    assert (await by_body(svc, project["id"], "um"))["delivery"] == "delivered"
    assert (await by_body(svc, project["id"], "dois"))["delivery"] == "undelivered"
    assert any("entregas de mensagens" in m["body"] for m in await svc.list_messages(project["id"]))


async def test_inbox_full(store, fake, project_dir):
    s = service(store, fake, agents_inbox_max=2)
    await s.start()
    try:
        gate = asyncio.Event()
        agent, project, run = await start_busy(s, fake, project_dir, FakeTurn(gate=gate))
        await say(s, project, agent, "m1")
        await say(s, project, agent, "m2")
        before = len(await s.list_messages(project["id"]))
        with pytest.raises(Conflict) as exc:
            await say(s, project, agent, "m3")
        assert exc.value.code == "inbox_full"
        assert len(await s.list_messages(project["id"])) == before  # nothing stored
        assert (await s.get_run(run["id"]))["inbox_count"] == 2
        gate.set()
        await wait_run(s, run["id"], ("done",))
    finally:
        await s.stop()


# -- with approvals, parking and restarts ----------------------------------------------------


@pytest.mark.parametrize("decision", ["approve", "deny"])
async def test_messages_wait_for_the_approval_decision_and_arrive_with_it(
        svc, fake, project_dir, decision):
    gate = asyncio.Event()
    cmd = write_file_command("feito.txt")
    agent, project, run = await start_busy(
        svc, fake, project_dir,
        FakeTurn(gate=gate, approval={"title": "Criar arquivo", "command": cmd, "reason": "r"}))
    await say(svc, project, agent, "ah, e capriche")
    gate.set()
    waiting = await wait_run(svc, run["id"], ("waiting_approval",))
    assert waiting["inbox_count"] == 1  # the approval stands, the message waits
    assert len([c for c in fake.calls if c["op"] == "resume"]) == 0
    ap = (await svc.list_approvals(run_id=run["id"]))[0]
    await svc.decide_approval(ap["id"], decision, digest=ap["command_digest"])
    await wait_run(svc, run["id"], ("done",))
    resumes = [c for c in fake.calls if c["op"] == "resume"]
    assert len(resumes) == 1 and "ah, e capriche" in resumes[0]["message"]
    assert ("APROVOU" in resumes[0]["message"]) == (decision == "approve")
    assert (await by_body(svc, project["id"], "ah, e capriche"))["delivery"] == "delivered"
    ran = [e for e in await svc.list_events(run["id"], limit=1000)
           if e["kind"] == "command" and e["payload"].get("by") == "harness"]
    assert len(ran) == (1 if decision == "approve" else 0)
    assert (project_dir / "feito.txt").exists() == (decision == "approve")


async def test_messages_to_a_parked_run_arrive_when_it_wakes(svc, fake, project_dir):
    agent, project = await setup_agent(svc, project_dir)
    fake.add(FakeTurn(fail_kind="outage", events=[("message", {"text": "comecei"})]))
    run = (await say(svc, project, agent, "pedido"))["run"]
    await wait_run(svc, run["id"], ("parked",))
    out = await say(svc, project, agent, "enquanto espera")
    assert out["joined"] is True and out["interrupted"] is False and out["run"]["inbox_count"] == 1
    await svc.wake_run(run["id"])
    await wait_run(svc, run["id"], ("done",))
    resume = [c for c in fake.calls if c["op"] == "resume"][0]
    assert "enquanto espera" in resume["message"] and "Esta conversa foi retomada" in resume["message"]
    assert (await by_body(svc, project["id"], "enquanto espera"))["delivery"] == "delivered"


async def test_parked_run_that_starts_over_puts_messages_in_the_first_prompt(svc, fake, project_dir):
    agent, project = await setup_agent(svc, project_dir)
    fake.add(FakeTurn(fail_kind="outage", events=[]))
    run = (await say(svc, project, agent, "pedido"))["run"]
    await wait_run(svc, run["id"], ("parked",))
    await say(svc, project, agent, "detalhe novo")
    await svc.wake_run(run["id"])
    await wait_run(svc, run["id"], ("done",))
    prompt = [c for c in fake.calls if c["op"] == "run"][-1]["ctx"].prompt
    assert "pedido" in prompt and "detalhe novo" in prompt


async def _crash_with_message(store, project_dir, turn: FakeTurn):
    s1 = service(store, FakeEngine(turns=[turn]))
    await s1.start()
    agent, project = await setup_agent(s1, project_dir)
    run = (await say(s1, project, agent, "migre o banco"))["run"]
    await wait_until(lambda: s1.engines["fake"].active == 1)
    await say(s1, project, agent, "e confira os índices")
    await asyncio.sleep(0.1)
    s1.shutdown_drain_s = 0
    await s1.stop()
    assert (await s1.get_run(run["id"]))["status"] == "running"
    return agent, project, run


async def test_pending_messages_survive_a_crash_and_are_delivered_on_resume(store, project_dir):
    agent, project, run = await _crash_with_message(
        store, project_dir, gated(("message", {"text": "migrando"})))
    e2 = FakeEngine()
    s2 = service(store, e2)
    await s2.start()
    try:
        await wait_run(s2, run["id"], ("done",))
        resume = [c for c in e2.calls if c["op"] == "resume"]
        assert len(resume) == 1 and "e confira os índices" in resume[0]["message"]
        assert "o sistema reiniciou" in resume[0]["message"]
        assert (await by_body(s2, project["id"], "e confira os índices"))["delivery"] == "delivered"
    finally:
        await s2.stop()


async def test_pending_messages_survive_a_crash_and_go_in_the_prompt_when_starting_over(store, project_dir):
    agent, project, run = await _crash_with_message(store, project_dir, gated())
    e2 = FakeEngine()
    s2 = service(store, e2)
    await s2.start()
    try:
        await wait_run(s2, run["id"], ("done",))
        first = [c for c in e2.calls if c["op"] == "run"]
        assert len(first) == 1 and "migre o banco" in first[0]["ctx"].prompt
        assert "e confira os índices" in first[0]["ctx"].prompt
        assert (await by_body(s2, project["id"], "e confira os índices"))["delivery"] == "delivered"
    finally:
        await s2.stop()


# -- burst window ----------------------------------------------------------------------------


async def test_burst_becomes_one_run_and_one_first_prompt(store, fake, project_dir):
    s = service(store, fake, agents_quiet_window_s=0.4)
    await s.start()
    try:
        agent, project = await setup_agent(s, project_dir)
        first = await say(s, project, agent, "faça o relatório")
        assert first["joined"] is False and first["run"]["status"] == "queued"
        m2 = await say(s, project, agent, "em português")
        m3 = await say(s, project, agent, "com gráficos")
        assert m2["joined"] and m3["joined"] and m2["run"]["id"] == first["run"]["id"]
        assert fake.calls == []  # still inside the window
        assert (await s.get_run(first["run"]["id"]))["inbox_count"] == 2
        await wait_run(s, first["run"]["id"], ("done",), timeout=5)  # woken by the timer, not the sweep
        assert len(await s.list_runs(project["id"])) == 1
        assert [c["op"] for c in fake.calls] == ["run"]
        prompt = fake.calls[0]["ctx"].prompt
        assert prompt.index("faça o relatório") < prompt.index("em português") < prompt.index("com gráficos")
        for body in ("em português", "com gráficos"):
            assert (await by_body(s, project["id"], body))["delivery"] == "delivered"
    finally:
        await s.stop()


async def test_window_restarts_at_most_the_configured_number_of_times(store, fake, project_dir):
    s = service(store, fake, agents_quiet_window_s=30, agents_quiet_window_max=2)
    await s.start()
    try:
        agent, project = await setup_agent(s, project_dir)
        rid = (await say(s, project, agent, "a"))["run"]["id"]
        seen = []
        for text in ("b", "c", "d", "e"):
            await say(s, project, agent, text)
            raw = await s._raw_run(rid)
            seen.append((raw["quiet_count"], raw["quiet_until"]))
        assert [c for c, _ in seen] == [1, 2, 2, 2]
        assert seen[1][1] == seen[2][1] == seen[3][1]  # no more restarts after the limit
        assert seen[0][1] != seen[1][1]
        await s.cancel_run(rid)
    finally:
        await s.stop()


async def test_task_runs_and_zero_window_do_not_wait(store, fake, project_dir):
    s = service(store, fake, agents_quiet_window_s=30)
    await s.start()
    try:
        agent, project = await setup_agent(s, project_dir)
        task = await s.create_task(project_id=project["id"], title="T", assignee_agent_id=agent["id"])
        run = await s.run_task(task["id"])
        await wait_run(s, run["id"], ("done",), timeout=3)
        run2 = await s.start_run(agent["id"], project["id"], "pela ferramenta")
        await wait_run(s, run2["id"], ("done",), timeout=3)
    finally:
        await s.stop()
    s0 = service(store, FakeEngine(), agents_quiet_window_s=0)
    await s0.start()
    try:
        out = await s0.post_message(project["id"], "sem espera", agent_id=agent["id"])
        await wait_run(s0, out["run"]["id"], ("done",), timeout=3)
    finally:
        await s0.stop()


async def test_open_window_at_a_restart_starts_after_boot(store, project_dir):
    e1 = FakeEngine()
    s1 = service(store, e1, agents_quiet_window_s=30)
    await s1.start()
    agent, project = await setup_agent(s1, project_dir)
    rid = (await say(s1, project, agent, "pedido"))["run"]["id"]
    await say(s1, project, agent, "outro")
    await s1.stop()
    assert (await s1.get_run(rid))["status"] == "queued" and e1.calls == []
    e2 = FakeEngine()
    s2 = service(store, e2, agents_quiet_window_s=30)
    await s2.start()
    try:
        await wait_run(s2, rid, ("done",), timeout=3)
        assert "outro" in e2.calls[0]["ctx"].prompt
    finally:
        await s2.stop()


# -- interrupt --------------------------------------------------------------------------------


async def test_interrupt_ends_the_turn_and_resumes_at_once(svc, fake, project_dir):
    gate = asyncio.Event()  # never opened: only the interrupt can end the turn
    q = tap(svc)
    agent, project, run = await start_busy(
        svc, fake, project_dir,
        FakeTurn(events=[("message", {"text": "texto parcial"}), started()], gate=gate,
                 final_message="NÃO DEVE APARECER"))
    out = await say(svc, project, agent, "mude de plano", mode="interrupt")
    assert out["joined"] is True and out["interrupted"] is True
    done = await wait_run(svc, run["id"], ("done",))
    assert done["status"] == "done"  # resumed, not cancelled
    resume = [c for c in fake.calls if c["op"] == "resume"]
    assert len(resume) == 1 and resume[0]["session_ref"] == done["session_ref"]
    text = resume[0]["message"]
    assert "mude de plano" in text and "interrompeu" in text
    assert "npm run migrate" in text and "pela metade" in text  # the open action
    assert (await notes(svc, run["id"], "interrupted_by_owner"))[0]["type"] == "note"
    assert (await by_body(svc, project["id"], "mude de plano"))["delivery"] == "delivered"
    agent_texts = [m["body"] for m in await svc.list_messages(project["id"]) if m["author"] == agent["id"]]
    assert agent_texts == ["Concluído."]  # the interrupted partial output is not an answer
    assert not [m for m in agent_texts if "parou" in m]
    assert not [f for f in drain(q) if f["type"] == "run_update" and f["run"]["status"] == "cancelled"]
    statuses = [e["payload"]["status"] for e in await svc.list_events(run["id"], limit=1000)
                if e["kind"] == "status"]
    assert statuses.count("done") == 1 and "cancelled" not in statuses and "failed" not in statuses


async def test_interrupt_in_other_states_behaves_as_join(store, fake, project_dir):
    s = service(store, fake, agents_quiet_window_s=30)
    await s.start()
    try:
        agent, project = await setup_agent(s, project_dir)
        rid = (await say(s, project, agent, "pedido"))["run"]["id"]  # queued, in its window
        out = await say(s, project, agent, "agora", mode="interrupt")
        assert out["joined"] is True and out["interrupted"] is False
        assert (await s.get_run(rid))["status"] == "queued" and (await s.get_run(rid))["inbox_count"] == 1
        await s.cancel_run(rid)
    finally:
        await s.stop()
    sp = service(store, FakeEngine(turns=[FakeTurn(fail_kind="outage", events=[])]))
    await sp.start()
    try:
        run = (await sp.post_message(project["id"], "outro pedido", agent_id=agent["id"]))["run"]
        await wait_run(sp, run["id"], ("parked",))
        out = await sp.post_message(project["id"], "acorde", agent_id=agent["id"], mode="interrupt")
        assert out["joined"] is True and out["interrupted"] is False
        assert (await sp.get_run(run["id"]))["status"] == "parked"
    finally:
        await sp.stop()


async def test_interrupt_racing_the_natural_end_has_one_consistent_outcome(svc, fake, project_dir):
    gate = asyncio.Event()
    agent, project, run = await start_busy(
        svc, fake, project_dir, FakeTurn(gate=gate, ignore_cancel=True, final_message="Quase pronto."))
    out = await say(svc, project, agent, "corrige isso", mode="interrupt")
    assert out["interrupted"] is True
    gate.set()  # the engine finishes on its own, ignoring the cancel
    done = await wait_run(svc, run["id"], ("done",))
    assert len([c for c in fake.calls if c["op"] == "resume"]) == 1
    statuses = [e["payload"]["status"] for e in await svc.list_events(run["id"], limit=1000)
                if e["kind"] == "status"]
    assert statuses.count("done") == 1 and "failed" not in statuses and "cancelled" not in statuses
    assert (await by_body(svc, project["id"], "corrige isso"))["delivery"] == "delivered"
    assert done["inbox_count"] == 0
    # an interrupt after the turn is over is a plain join
    assert svc._interrupt(run["id"]) is False


# -- stop and continue -----------------------------------------------------------------------


async def test_cancel_posts_the_stop_message_and_undelivers_the_inbox(svc, fake, project_dir):
    q = tap(svc)
    agent, project, run = await start_busy(
        svc, fake, project_dir, gated(("message", {"text": "migrei a tabela A"}), started()))
    out = await say(svc, project, agent, "não deu tempo")
    await asyncio.sleep(0.1)
    await svc.cancel_run(run["id"])
    stop = [m for m in await svc.list_messages(project["id"]) if m["body"].startswith("Você parou")]
    assert len(stop) == 1 and stop[0]["author"] == agent["id"] and stop[0]["run_id"] == run["id"]
    assert "migrei a tabela A" in stop[0]["body"]
    assert "npm run migrate" in stop[0]["body"] and "pela metade" in stop[0]["body"]
    assert (await by_body(svc, project["id"], "não deu tempo"))["delivery"] == "undelivered"
    assert (await svc.get_run(run["id"]))["inbox_count"] == 0
    frames = [f for f in drain(q) if f["type"] == "message_update"]
    assert [(f["message"]["id"], f["message"]["delivery"]) for f in frames] == [
        (out["message"]["id"], "undelivered")]


async def test_cancel_of_a_queued_run_undelivers_too(store, fake, project_dir):
    s = service(store, fake, agents_quiet_window_s=30)
    await s.start()
    try:
        agent, project = await setup_agent(s, project_dir)
        rid = (await say(s, project, agent, "pedido"))["run"]["id"]
        await say(s, project, agent, "junto")
        await s.cancel_run(rid)
        assert (await by_body(s, project["id"], "junto"))["delivery"] == "undelivered"
        assert [m["body"] for m in await s.list_messages(project["id"])][-1] == "Você parou este trabalho."
    finally:
        await s.stop()


async def test_failed_run_marks_pending_messages_undelivered(svc, fake, project_dir):
    gate = asyncio.Event()
    agent, project, run = await start_busy(svc, fake, project_dir, FakeTurn(gate=gate, fail="quebrou"))
    await say(svc, project, agent, "tarde demais")
    gate.set()
    await wait_run(svc, run["id"], ("failed",))
    assert (await by_body(svc, project["id"], "tarde demais"))["delivery"] == "undelivered"
    assert (await svc.get_run(run["id"]))["inbox_count"] == 0


async def test_continue_after_a_stop_delivers_the_undelivered_messages(svc, fake, project_dir):
    agent, project, run = await start_busy(svc, fake, project_dir, gated(("message", {"text": "feito até aqui"})))
    await say(svc, project, agent, "lembre do rodapé")
    await svc.cancel_run(run["id"])
    assert (await by_body(svc, project["id"], "lembre do rodapé"))["delivery"] == "undelivered"
    new = await svc.continue_run(run["id"])
    await wait_run(svc, new["id"], ("done",))
    msg = await by_body(svc, project["id"], "lembre do rodapé")
    assert msg["delivery"] == "delivered" and msg["run_id"] == new["id"]
    resume = [c for c in fake.calls if c["op"] == "resume"][-1]
    assert "lembre do rodapé" in resume["message"] and "continuar" in resume["message"]


# -- wire ------------------------------------------------------------------------------------


async def test_wire_shapes_over_http(store, fake, project_dir):
    s = service(store, fake, agents_inbox_max=1)
    await s.start()
    app = FastAPI()
    app.include_router(router)
    app.state.agent_harness = s
    try:
        gate = asyncio.Event()
        agent, project, run = await start_busy(s, fake, project_dir, FakeTurn(gate=gate))
        h = {TOKEN_HEADER: s.token}
        transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 50000))
        async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8000") as c:
            r = await c.post(f"/agents/projects/{project['id']}/messages", headers=h,
                             json={"body": "olha isso", "agent_id": agent["id"], "mode": "join"})
            assert r.status_code == 200
            body = r.json()
            assert body["joined"] is True and body["interrupted"] is False
            assert body["message"]["delivery"] == "pending" and body["run"]["inbox_count"] == 1
            full = await c.post(f"/agents/projects/{project['id']}/messages", headers=h,
                                json={"body": "e esta", "agent_id": agent["id"]})
            assert full.status_code == 409 and full.json()["code"] == "inbox_full"
            bad = await c.post(f"/agents/projects/{project['id']}/messages", headers=h,
                               json={"body": "x", "mode": "parar"})
            assert bad.status_code == 422
            listed = (await c.get(f"/agents/projects/{project['id']}/messages", headers=h)).json()["messages"]
            assert all("delivery" in m for m in listed)
            runs = (await c.get("/agents/runs", headers=h)).json()["runs"]
            assert all("inbox_count" in x for x in runs)
        gate.set()
        await wait_run(s, run["id"], ("done",))
    finally:
        await s.stop()


def test_migration_adds_the_inbox_columns_and_is_idempotent(tmp_path: Path):
    conn = sqlite3.connect(tmp_path / "old.sqlite")
    conn.execute("CREATE TABLE agent_messages (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT,"
                 " author TEXT NOT NULL, body TEXT NOT NULL, run_id TEXT, created_at TEXT NOT NULL)")
    conn.execute("INSERT INTO agent_messages VALUES ('m1', 'p', NULL, 'user', 'oi', NULL, '2026-01-01')")
    conn.commit()
    agents_schema.migrate(conn)
    agents_schema.migrate(conn)
    assert "delivery" in {r[1] for r in conn.execute("PRAGMA table_info(agent_messages)")}
    assert {"quiet_until", "quiet_count", "inbox_deliveries"} <= {
        r[1] for r in conn.execute("PRAGMA table_info(agent_runs)")}
    assert conn.execute("SELECT delivery FROM agent_messages WHERE id = 'm1'").fetchone() == (None,)
    conn.close()
