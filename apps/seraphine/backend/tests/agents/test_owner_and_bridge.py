"""Phase 3c, part 2: asking the owner (``ask_owner``) and the bridge status and test.

The parking clock is the service's own ``now``, which the tests move; the engines are the fake
engine, which calls the gateway with the turn's own token like the MCP bridge would."""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from seraphine.agents.catalog import ASK_OWNER_REPLY
from seraphine.agents.engines.fake import FakeEngine, FakeTurn
from seraphine.agents.errors import Conflict, Invalid
from seraphine.agents.gateway import BRIDGE_TEST_PROMPT, STATUS_REFUSED, STATUS_SILENT
from seraphine.agents.routes import TOKEN_HEADER, router
from seraphine.agents.service import AgentHarnessService

from .conftest import make_settings, setup_agent, wait_run, wait_until, write_file_command
from .test_gateway import events_of, payloads
from .test_inbox import drain, tap

BASE = datetime(2026, 11, 11, 12, 0, tzinfo=timezone.utc)
ASK = ("ask_owner", {"pergunta": "Qual cor?", "opcoes": ["azul", "verde"]})


class Clock:
    def __init__(self) -> None:
        self.t = BASE

    def __call__(self) -> datetime:
        return self.t


def api(svc: AgentHarnessService, *, token: bool = True) -> httpx.AsyncClient:
    app = FastAPI()
    app.include_router(router)
    app.state.agent_harness = svc
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=("127.0.0.1", 50000)),
                             base_url="http://127.0.0.1:8000", headers={TOKEN_HEADER: svc.token} if token else {})


async def build(store, **settings: Any) -> tuple[AgentHarnessService, FakeEngine, Clock]:
    engine = FakeEngine(bridge=True)
    svc = AgentHarnessService(store, make_settings(**settings), engines={"fake": engine}, heartbeat_s=0.2)
    engine.gateway = svc.gateway
    clock = Clock()
    svc.now = clock
    await svc.start()
    return svc, engine, clock


@pytest.fixture
async def env(store, project_dir):
    svc, engine, clock = await build(store)
    agent, project = await setup_agent(svc, project_dir)
    yield svc, engine, clock, agent, project
    await svc.stop()


async def ask_and_park(svc, engine, agent, project, *, goal: str = "Pinte a parede", turn: FakeTurn | None = None):
    engine.add(turn or FakeTurn(events=[], gateway_calls=[ASK], final_message="Aguardo a sua resposta."))
    run = await svc.start_run(agent["id"], project["id"], goal)
    return await wait_run(svc, run["id"], ("parked",))


# -- end to end ---------------------------------------------------------------------------------------


async def test_a_question_is_posted_the_run_parks_and_the_owners_message_wakes_it_in_the_same_session(env):
    svc, engine, clock, agent, project = env
    parked = await ask_and_park(svc, engine, agent, project)
    assert parked["wait_kind"] == "owner_input" and parked["wait_until"] is None and parked["wait_exact"] is False
    assert parked["wait_attempts"] == 1 and parked["wait_detail"]
    q = parked["question"]
    assert set(q) == {"text", "options", "asked_at"} and q["text"] == "Qual cor?" and q["options"] == ["azul", "verde"]
    assert engine.gateway_results[0] == {"ok": True, "content": ASK_OWNER_REPLY}  # told to end the turn
    msgs = await svc.list_messages(project["id"])
    assert [m["author"] for m in msgs] == [agent["id"], agent["id"]]  # the question, then its closing words
    assert msgs[0]["body"] == "Qual cor?\n\nOpções:\n- azul\n- verde" and msgs[0]["run_id"] == parked["id"]
    assert msgs[1]["body"] == "Aguardo a sua resposta."
    events = await events_of(svc, parked["id"])
    assert payloads(events, reason="asked_owner")[0]["text"] == "Perguntou ao dono: Qual cor?"
    assert "Em espera" in payloads(events, reason="parked")[0]["text"]
    status = [e["payload"] for e in events if e["kind"] == "status"][-1]
    assert status["status"] == "parked" and status["wait_kind"] == "owner_input"
    # a message to that agent in that project is the answer: it joins the run's inbox and wakes it
    q_frames = tap(svc)
    out = await svc.post_message(project["id"], "verde, por favor", agent_id=agent["id"])
    assert out["joined"] is True and out["run"]["id"] == parked["id"] and out["run"]["status"] in ("queued", "running", "done")
    done = await wait_run(svc, parked["id"], ("done",))
    assert [c["op"] for c in engine.calls] == ["run", "resume"]  # the same session, not a fresh start
    resumed = engine.calls[1]
    assert resumed["session_ref"] == done["session_ref"] == "fake-session-1"
    assert "verde, por favor" in resumed["message"] and "perguntou ao dono" in resumed["message"]
    assert done["question"] is None and done["wait_kind"] is None
    woke = payloads(await events_of(svc, parked["id"]), reason="woke")
    assert len(woke) == 1 and "o dono respondeu" in woke[0]["text"] and "fresh_restart" not in woke[0]
    answer = next(m for m in await svc.list_messages(project["id"]) if m["body"] == "verde, por favor")
    assert answer["delivery"] == "delivered" and answer["run_id"] == parked["id"]
    assert len(await svc.list_runs(project["id"])) == 1  # no second run was started
    assert any(f["type"] == "run_update" and f["run"]["status"] == "queued" for f in drain(q_frames))


async def test_the_generic_wake_route_also_resumes_a_run_that_waits_for_the_owner(env):
    svc, engine, clock, agent, project = env
    parked = await ask_and_park(svc, engine, agent, project)
    async with api(svc) as c:
        r = await c.post(f"/agents/runs/{parked['id']}/wake")
        assert r.status_code == 200 and r.json()["run"]["status"] in ("queued", "running") and r.json()["run"]["question"] is None
    await wait_run(svc, parked["id"], ("done",))
    assert [c_["op"] for c_ in engine.calls] == ["run", "resume"]
    assert "continuar sem responder agora" in engine.calls[1]["message"]


async def test_cancel_works_while_the_agent_waits_for_the_owner(env):
    svc, engine, clock, agent, project = env
    parked = await ask_and_park(svc, engine, agent, project)
    cancelled = await svc.cancel_run(parked["id"])
    assert cancelled["status"] == "cancelled" and cancelled["question"] is None and cancelled["wait_kind"] is None
    # the agent is free again
    engine.add(FakeTurn(events=[]))
    again = await svc.start_run(agent["id"], project["id"], "outra coisa")
    await wait_run(svc, again["id"], ("done",))


async def test_waiting_for_the_owner_is_not_engine_silence_and_holds_no_slot(env):
    svc, engine, clock, agent, project = env
    svc.silence_s = 0.05
    svc.watchdog_poll_s = 0.05
    parked = await ask_and_park(svc, engine, agent, project)
    await asyncio.sleep(0.4)  # many times the silence limit
    assert (await svc.get_run(parked["id"]))["status"] == "parked"
    assert svc._active == {}  # no scheduler slot held while it waits


async def test_it_gives_up_after_the_limit_with_owner_no_answer(env):
    svc, engine, clock, agent, project = env
    parked = await ask_and_park(svc, engine, agent, project)
    clock.t = BASE + timedelta(hours=23, minutes=59)
    assert await svc.wake_due_runs() == 0 and (await svc.get_run(parked["id"]))["status"] == "parked"
    clock.t = BASE + timedelta(hours=24, seconds=1)
    await svc.wake_due_runs()
    failed = await svc.get_run(parked["id"])
    assert failed["status"] == "failed" and failed["error"] == "owner_no_answer" and failed["question"] is None
    last = (await svc.list_messages(project["id"]))[-1]
    assert last["body"].startswith("Desisti: o dono não respondeu à minha pergunta em 24 horas.")


async def test_the_limit_is_the_setting(store, project_dir):
    svc, engine, clock = await build(store, agents_owner_answer_max_s=600)
    try:
        agent, project = await setup_agent(svc, project_dir)
        parked = await ask_and_park(svc, engine, agent, project)
        clock.t = BASE + timedelta(minutes=11)
        await svc.wake_due_runs()
        assert (await svc.get_run(parked["id"]))["error"] == "owner_no_answer"
    finally:
        await svc.stop()


async def test_a_second_call_in_the_same_turn_replaces_the_first_question(env):
    svc, engine, clock, agent, project = env
    turn = FakeTurn(events=[], gateway_calls=[("ask_owner", {"pergunta": "Primeira?"}),
                                              ("ask_owner", {"pergunta": "Segunda?", "opcoes": ["sim", "não"]})])
    parked = await ask_and_park(svc, engine, agent, project, turn=turn)
    assert parked["question"]["text"] == "Segunda?" and parked["question"]["options"] == ["sim", "não"]
    bodies = [m["body"] for m in await svc.list_messages(project["id"])]
    assert bodies[0] == "Primeira?" and bodies[1].startswith("Segunda?")  # both were posted, one is open
    assert all(r["ok"] for r in engine.gateway_results)


async def test_at_most_five_questions_per_run(env):
    svc, engine, clock, agent, project = env
    calls = [("ask_owner", {"pergunta": f"Pergunta {i}?"}) for i in range(1, 7)]
    parked = await ask_and_park(svc, engine, agent, project, turn=FakeTurn(events=[], gateway_calls=calls))
    ok = [r["ok"] for r in engine.gateway_results]
    assert ok == [True] * 5 + [False]
    assert "5 perguntas" in engine.gateway_results[5]["error"]
    assert parked["question"]["text"] == "Pergunta 5?"  # the refused one did not replace it
    asked = [m for m in await svc.list_messages(project["id"]) if m["body"].startswith("Pergunta ")]
    assert len(asked) == 5
    # the cap is per run, across turns: the answer wakes it, and it cannot ask a sixth time
    engine.add(FakeTurn(events=[], gateway_calls=[("ask_owner", {"pergunta": "Mais uma?"})], final_message="x"))
    await svc.post_message(project["id"], "ok", agent_id=agent["id"])
    await wait_until(lambda: len(engine.gateway_results) == 7)
    assert engine.gateway_results[6]["ok"] is False
    await wait_run(svc, parked["id"], ("done",))


async def test_an_answer_that_arrives_before_the_turn_ends_is_delivered_and_the_run_does_not_park(env):
    svc, engine, clock, agent, project = env
    gate = asyncio.Event()
    engine.add(FakeTurn(events=[], gateway_calls=[ASK], gate=gate, final_message="Já perguntei."))
    engine.add(FakeTurn(events=[], final_message="Certo, verde."))
    run = await svc.start_run(agent["id"], project["id"], "Pinte")
    await wait_until(lambda: len(engine.gateway_results) == 1)
    assert (await svc.get_run(run["id"]))["question"]["text"] == "Qual cor?"  # visible while the turn is open
    out = await svc.post_message(project["id"], "verde", agent_id=agent["id"])
    assert out["joined"] is True
    gate.set()
    done = await wait_run(svc, run["id"], ("done",))
    assert [c["op"] for c in engine.calls] == ["run", "resume"] and "verde" in engine.calls[1]["message"]
    assert done["question"] is None
    statuses = [e["payload"]["status"] for e in await events_of(svc, run["id"]) if e["kind"] == "status"]
    assert "parked" not in statuses


async def test_when_the_turn_also_asks_for_a_command_approval_the_approval_wins(env):
    svc, engine, clock, agent, project = env
    turn = FakeTurn(events=[], gateway_calls=[ASK], final_message="Preciso rodar um comando.",
                    approval={"title": "Criar arquivo", "command": write_file_command("x.txt"), "reason": "r"})
    engine.add(turn)
    run = await svc.start_run(agent["id"], project["id"], "Pinte")
    waiting = await wait_run(svc, run["id"], ("waiting_approval",))
    assert waiting["question"] is None and waiting["wait_kind"] is None
    bodies = [m["body"] for m in await svc.list_messages(project["id"])]
    assert bodies[0].startswith("Qual cor?")  # the question stays posted, as an ordinary message
    assert any("Preciso da sua aprovação" in b for b in bodies)
    statuses = [e["payload"]["status"] for e in await events_of(svc, run["id"]) if e["kind"] == "status"]
    assert "parked" not in statuses
    await svc.cancel_run(run["id"])


async def test_the_other_parking_reasons_are_untouched_and_never_carry_a_question(env):
    svc, engine, clock, agent, project = env
    engine.add(FakeTurn(events=[], fail_kind="outage"))
    run = await svc.start_run(agent["id"], project["id"], "x")
    parked = await wait_run(svc, run["id"], ("parked",))
    assert parked["wait_kind"] == "outage" and parked["wait_until"] is not None and parked["question"] is None
    clock.t = BASE + timedelta(hours=2)
    await svc.wake_due_runs()  # the timer still wakes an outage
    await wait_run(svc, run["id"], ("done",))


async def test_a_system_notice_does_not_count_as_the_answer(env):
    svc, engine, clock, agent, project = env
    engine.add(FakeTurn(events=[], gateway_calls=[("create_note", {"title": "Rascunho"}), ASK], final_message="Aguardo."))
    from seraphine.agents.catalog import Services
    from seraphine.notes import schema as notes_schema
    from seraphine.notes.service import NoteService
    svc.store.register_migrator("seraphine_notes", notes_schema.migrate)
    await svc.store.ensure_schema()
    notes = NoteService(store=svc.store)
    svc.gateway.services = Services(notes=notes)
    await svc.set_grants(agent["id"], {"notes": "write"})
    run = await svc.start_run(agent["id"], project["id"], "Pinte")
    parked = await wait_run(svc, run["id"], ("parked",))
    (action,) = await svc.list_actions(parked["id"])
    await svc.undo_action(action["id"])  # a system notice goes to the inbox of the waiting run
    still = await svc.get_run(parked["id"])
    assert still["status"] == "parked" and still["inbox_count"] == 1 and still["question"]["text"] == "Qual cor?"
    await svc.post_message(project["id"], "azul", agent_id=agent["id"])
    await wait_run(svc, parked["id"], ("done",))
    resumed = engine.calls[1]["message"]  # the answer and the notice arrive together, in the same session
    assert "azul" in resumed and "desfez uma ação sua" in resumed and engine.calls[1]["op"] == "resume"


async def test_ask_owner_works_for_an_agent_with_every_group_closed(env):
    svc, engine, clock, agent, project = env
    await svc.set_grants(agent["id"], {"notes": "none", "wiki": "none", "project_tasks": "none"})
    parked = await ask_and_park(svc, engine, agent, project)
    assert parked["question"]["text"] == "Qual cor?"


# -- bridge status ------------------------------------------------------------------------------------


async def test_the_status_is_unknown_until_the_bridge_was_used(svc):
    async with api(svc) as c:
        r = await c.get("/agents/bridge/status")
        assert r.status_code == 200
        assert r.json() == {"engines": [
            {"engine": "codex", "label": "Codex", "state": "unknown", "last_ok_at": None,
             "last_failure_at": None, "last_failure": None},
            {"engine": "claude_code", "label": "Claude Code", "state": "unknown", "last_ok_at": None,
             "last_failure_at": None, "last_failure": None}]}
    async with api(svc, token=False) as anon:
        assert (await anon.get("/agents/bridge/status")).status_code == 401


async def test_the_status_follows_the_last_time_the_bridge_was_offered_ok_failed_and_ok_again(store, project_dir):
    svc, engine, clock = await build(store, agents_bridge_hello_timeout_s=0.1)
    try:
        engine.name = "codex"  # the bridge status is kept per engine name
        agent, project = await setup_agent(svc, project_dir)

        async def one(turn: FakeTurn) -> dict:
            engine.add(turn)
            run = await svc.start_run(agent["id"], project["id"], "x")
            await wait_run(svc, run["id"], ("done",))
            return next(e for e in svc.bridge_status() if e["engine"] == "codex")

        ok = await one(FakeTurn(events=[], hello=True))
        assert ok["state"] == "ok" and ok["last_ok_at"] and ok["last_failure_at"] is None
        silent = await one(FakeTurn(events=[], gate=_gate(0.4)))  # never says hello
        assert silent["state"] == "failed" and silent["last_failure"] == STATUS_SILENT
        assert silent["last_failure_at"] and silent["last_ok_at"] == ok["last_ok_at"]
        refused = await one(FakeTurn(events=[("_bridge", {"state": "failed", "reason": "x"})], gate=_gate(0.3)))
        assert refused["state"] == "failed" and refused["last_failure"] == STATUS_REFUSED
        again = await one(FakeTurn(events=[], hello=True))
        assert again["state"] == "ok" and again["last_ok_at"] >= ok["last_ok_at"]
        assert again["last_failure"] == STATUS_REFUSED  # the last failure stays on record
        other = next(e for e in svc.bridge_status() if e["engine"] == "claude_code")
        assert other["state"] == "unknown"
        async with api(svc) as c:
            assert (await c.get("/agents/bridge/status")).json()["engines"][0]["state"] == "ok"
    finally:
        await svc.stop()


def _gate(seconds: float) -> asyncio.Event:
    gate = asyncio.Event()
    asyncio.get_running_loop().call_later(seconds, gate.set)
    return gate


# -- bridge test ----------------------------------------------------------------------------------------


async def bridge_service(store, *turns: FakeTurn, **settings: Any) -> tuple[AgentHarnessService, FakeEngine]:
    engine = FakeEngine("codex", turns=list(turns), bridge=True)
    svc = AgentHarnessService(store, make_settings(**settings), engines={"codex": engine}, heartbeat_s=0.2)
    engine.gateway = svc.gateway
    await svc.start()
    return svc, engine


async def count(svc: AgentHarnessService, table: str) -> int:
    return await svc._db(lambda c: c.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])


PING = ("ping", {"text": "ping"})


async def test_a_good_bridge_test_runs_one_turn_in_a_temporary_folder_and_reports_ok(store, project_dir):
    svc, engine = await bridge_service(store, FakeTurn(events=[], hello=True, gateway_calls=[PING]))
    try:
        project = await svc.create_project(name="Do dono", path=str(project_dir))
        frames = tap(svc)
        async with api(svc) as c:
            r = await c.post("/agents/bridge/test", json={"engine": "codex"})
        assert r.status_code == 200
        body = r.json()
        assert set(body) == {"ok", "detail", "took_ms"} and body["ok"] is True and isinstance(body["took_ms"], int)
        assert "ping" in body["detail"]
        ctx = engine.calls[0]["ctx"]
        assert ctx.prompt == BRIDGE_TEST_PROMPT and ctx.sandbox == "read-only"
        assert ctx.bridge is not None and ctx.bridge.token not in r.text and ctx.bridge.token not in json.dumps(body)
        assert ctx.project_path.name.startswith("seraphine-ponte-teste-")
        assert not ctx.project_path.exists()  # the temporary folder is gone
        assert project_dir not in ctx.project_path.parents and ctx.project_path != project_dir
        assert not Path(ctx.bridge.tools_file).exists()
        assert engine.gateway_results[0]["ok"] is True
        from seraphine.agents.gateway import BridgeUnauthorized
        with pytest.raises(BridgeUnauthorized):  # the token is dead afterwards
            await svc.gateway.authenticate(ctx.bridge.token)
        status = next(e for e in svc.bridge_status() if e["engine"] == "codex")
        assert status["state"] == "ok" and status["last_ok_at"]
        # nothing of it was shown anywhere: no run, no event, no message, no token row, no frame
        for table in ("agent_runs", "agent_run_events", "agent_messages", "agent_bridge_tokens", "agent_actions"):
            assert await count(svc, table) == 0, table
        assert await svc.list_messages(project["id"]) == [] and await svc.list_runs() == []
        assert drain(frames) == []
    finally:
        await svc.stop()


async def test_the_token_of_a_bridge_test_dies_with_it_and_only_opens_ping(store):
    svc, engine = await bridge_service(store, FakeTurn(
        events=[], hello=True, gateway_calls=[("create_note", {"title": "x"}), ("list_notes", {}), PING]))
    try:
        result = await svc.run_bridge_test("codex")
        assert result["ok"] is True
        refused = engine.gateway_results[:2]
        assert all(r["ok"] is False and "só a ferramenta ping" in r["error"] for r in refused)
        token = engine.calls[0]["ctx"].bridge.token
        from seraphine.agents.gateway import BridgeUnauthorized
        with pytest.raises(BridgeUnauthorized):
            await svc.gateway.authenticate(token)
    finally:
        await svc.stop()


async def test_a_failed_bridge_test_says_why(store):
    svc, engine = await bridge_service(
        store,
        FakeTurn(events=[], fail="o motor quebrou"),            # the engine failed
        FakeTurn(events=[]),                                    # the bridge never said hello
        FakeTurn(events=[], hello=True),                        # hello, but no ping
        FakeTurn(events=[("_bridge", {"state": "failed", "reason": "x"})]),  # the engine refused the server
        FakeTurn(events=[], silent=True),                       # never ends: the time limit
        agents_bridge_test_timeout_s=0.3)
    try:
        details = []
        for _ in range(5):
            r = await svc.run_bridge_test("codex")
            assert r["ok"] is False
            details.append(r["detail"])
        assert "o motor quebrou" in details[0] and details[0].startswith("O motor terminou com erro")
        assert "não avisou que estava presente" in details[1]
        assert "não chamou a ferramenta de teste" in details[2]
        assert "falhou ao iniciar" in details[3]
        assert details[4] == "O teste passou de 1 segundo e foi interrompido."
        status = next(e for e in svc.bridge_status() if e["engine"] == "codex")
        assert status["state"] == "failed" and status["last_failure"] == details[4]
        assert await count(svc, "agent_runs") == 0 and await count(svc, "agent_bridge_tokens") == 0
    finally:
        await svc.stop()


async def test_a_bridge_test_that_cannot_start_is_a_clean_failure_and_the_folder_is_removed(store, monkeypatch):
    svc, engine = await bridge_service(store)
    try:
        engine._ok, engine._reason = False, "Codex não está conectado"
        r = await svc.run_bridge_test("codex")
        assert r["ok"] is False and r["detail"] == "O motor não está pronto: Codex não está conectado"
        engine._ok = True

        async def boom(*a: Any, **k: Any):
            raise RuntimeError("quebrou")

        monkeypatch.setattr(engine, "run", boom)
        r = await svc.run_bridge_test("codex")
        assert r["ok"] is False and "erro interno" in r["detail"]
        assert svc._bridge_test_busy is False  # the next test may run
    finally:
        await svc.stop()


async def test_only_one_bridge_test_at_a_time(store):
    gate = asyncio.Event()
    svc, engine = await bridge_service(store, FakeTurn(events=[], hello=True, gate=gate, gateway_calls=[PING]))
    try:
        first = asyncio.ensure_future(svc.run_bridge_test("codex"))
        await wait_until(lambda: engine.active == 1)
        with pytest.raises(Conflict) as exc:
            await svc.run_bridge_test("codex")
        assert exc.value.code == "test_running"
        async with api(svc) as c:
            r = await c.post("/agents/bridge/test", json={"engine": "codex"})
            assert r.status_code == 409 and r.json()["code"] == "test_running"
        gate.set()
        assert (await first)["ok"] is True
        assert svc._bridge_test_busy is False
    finally:
        await svc.stop()


async def test_the_bridge_test_route_checks_the_engine_and_the_owner_token(store):
    svc, engine = await bridge_service(store)
    try:
        async with api(svc) as c:
            assert (await c.post("/agents/bridge/test", json={"engine": "gemini"})).status_code == 422
            assert (await c.post("/agents/bridge/test", json={})).status_code == 422
            # a known engine that is not wired in this service (and a chat runtime): refused, not run
            r = await c.post("/agents/bridge/test", json={"engine": "claude_code"})
            assert r.status_code == 422
        async with api(svc, token=False) as anon:
            assert (await anon.post("/agents/bridge/test", json={"engine": "codex"})).status_code == 401
        with pytest.raises(Invalid):
            await svc.run_bridge_test("chat")
        assert engine.calls == []
    finally:
        await svc.stop()


async def test_a_bridge_test_never_touches_a_project_of_the_owner(store, project_dir):
    svc, engine = await bridge_service(store, FakeTurn(events=[], hello=True, gateway_calls=[PING]))
    try:
        project = await svc.create_project(name="Do dono", path=str(project_dir))
        (project_dir / "arquivo.txt").write_text("meu", encoding="utf-8")
        before = sorted(p.name for p in project_dir.iterdir())
        assert (await svc.run_bridge_test("codex"))["ok"] is True
        assert sorted(p.name for p in project_dir.iterdir()) == before
        assert await svc.list_messages(project["id"]) == []
        assert len(await svc.list_projects()) == 1
        assert engine.calls[0]["ctx"].project_path != project_dir
    finally:
        await svc.stop()
