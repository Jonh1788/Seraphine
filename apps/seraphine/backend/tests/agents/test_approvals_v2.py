"""Approvals v2: digest, risk, expiry, automatic refusal, denial note, clean child env."""

from __future__ import annotations

import asyncio
import os
import sqlite3
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from seraphine.agents import schema as agents_schema
from seraphine.agents.engines.fake import FakeEngine, FakeTurn
from seraphine.agents.errors import Conflict, Invalid
from seraphine.agents.procutil import clean_env, run_shell_command
from seraphine.agents.routes import TOKEN_HEADER, router
from seraphine.agents.service import (
    MAX_APPROVALS_PER_RUN, AgentHarnessService, command_digest, _now,
)

from .conftest import ORIGIN, setup_agent, wait_run, write_file_command

PAST = "2000-01-01T00:00:00.000000+00:00"
CONTRACT_FIELDS = ("risk_level", "risk_reasons", "command_digest", "expires_at", "decided_by",
                   "decision_note")


def _request(command: str, title: str = "Rodar") -> dict:
    return {"title": title, "command": command, "reason": "preciso"}


async def _waiting(svc, fake, project_dir: Path, command: str, extra_turns=()):
    agent, project = await setup_agent(svc, project_dir)
    fake.add(FakeTurn(approval=_request(command)))
    for turn in extra_turns:
        fake.add(turn)
    run = await svc.start_run(agent["id"], project["id"], "x")
    await wait_run(svc, run["id"], ("waiting_approval", "failed", "done"))
    (a,) = await svc.list_approvals(status="pending")
    return run, a


async def _expire_now(svc, approval_id: str) -> None:
    await svc._db(lambda c: c.execute(
        "UPDATE agent_approvals SET expires_at = ? WHERE id = ?", (PAST, approval_id)))


def _resume_messages(fake: FakeEngine) -> list[str]:
    return [c["message"] for c in fake.calls if c["op"] == "resume"]


async def test_new_approval_has_every_contract_field(svc, fake, project_dir: Path):
    run, a = await _waiting(svc, fake, project_dir, write_file_command("a.txt"))
    for key in CONTRACT_FIELDS:
        assert key in a
    assert a["risk_level"] == "medium" and a["risk_reasons"] and a["decided_by"] is None
    assert a["decision_note"] is None
    assert a["command_digest"] == command_digest(run["id"], a["id"], a["command"])
    assert len(a["command_digest"]) == 64 and a["command_digest"] == a["command_digest"].lower()
    assert a["expires_at"] > a["created_at"]
    events = await svc.list_events(run["id"])
    req = next(e for e in events if e["kind"] == "approval_request")["payload"]
    assert req["digest"] == a["command_digest"] and req["risk_level"] == "medium"
    assert req["expires_at"] == a["expires_at"] and isinstance(req["risk_reasons"], list)


async def test_digest_match_approves_and_records_owner(svc, fake, project_dir: Path):
    run, a = await _waiting(svc, fake, project_dir, write_file_command("ok.txt"),
                            [FakeTurn(final_message="fim")])
    out = await svc.decide_approval(a["id"], "approve", digest=a["command_digest"], note="  pode  ")
    assert out["status"] == "approved" and out["decided_by"] == "owner" and out["decision_note"] == "pode"
    await wait_run(svc, run["id"], ("done",))
    assert (project_dir / "ok.txt").exists()
    result = [e for e in await svc.list_events(run["id"]) if e["kind"] == "approval_result"][0]["payload"]
    assert result["decided_by"] == "owner" and result["note"] == "pode" and result["decision"] == "approved"


async def test_digest_mismatch_and_missing(svc, fake, project_dir: Path):
    run, a = await _waiting(svc, fake, project_dir, write_file_command("no.txt"))
    with pytest.raises(Conflict) as ei:
        await svc.decide_approval(a["id"], "approve", digest="0" * 64)
    assert ei.value.code == "digest_mismatch"
    with pytest.raises(Invalid):
        await svc.decide_approval(a["id"], "approve")
    assert (await svc.get_approval(a["id"]))["status"] == "pending"
    assert (await svc.get_run(run["id"]))["status"] == "waiting_approval"
    # a denial does not need the digest
    assert (await svc.decide_approval(a["id"], "deny"))["status"] == "denied"


async def test_high_risk_needs_confirmation(svc, fake, project_dir: Path):
    run, a = await _waiting(svc, fake, project_dir, "echo $HOME", [FakeTurn(final_message="fim")])
    assert a["risk_level"] == "high" and a["risk_reasons"]
    with pytest.raises(Conflict) as ei:
        await svc.decide_approval(a["id"], "approve", digest=a["command_digest"])
    assert ei.value.code == "high_risk_unconfirmed"
    assert (await svc.get_approval(a["id"]))["status"] == "pending"
    out = await svc.decide_approval(a["id"], "approve", digest=a["command_digest"],
                                    confirm_high_risk=True)
    assert out["status"] == "approved"
    await wait_run(svc, run["id"], ("done",))


async def test_expiry_by_sweep(svc, fake, project_dir: Path):
    run, a = await _waiting(svc, fake, project_dir, write_file_command("e.txt"))
    assert await svc.expire_overdue_approvals() == 0
    await _expire_now(svc, a["id"])
    assert await svc.expire_overdue_approvals() == 1
    stored = await svc.get_approval(a["id"])
    assert stored["status"] == "expired" and stored["decided_by"] == "harness"
    assert stored["decision_note"]
    failed = await svc.get_run(run["id"])
    assert failed["status"] == "failed" and failed["error"] == "approval_expired"
    events = await svc.list_events(run["id"])
    result = [e for e in events if e["kind"] == "approval_result"][0]["payload"]
    assert result["decision"] == "expired" and result["decided_by"] == "harness"
    assert "expirou" in (await svc.list_messages(run["project_id"]))[-1]["body"]
    assert await svc.list_approvals(status="pending") == []
    assert [x["id"] for x in await svc.list_approvals(status="expired")] == [a["id"]]
    assert await svc.expire_overdue_approvals() == 0  # idempotent


async def test_expiry_found_when_listing(svc, fake, project_dir: Path):
    run, a = await _waiting(svc, fake, project_dir, write_file_command("l.txt"))
    await _expire_now(svc, a["id"])
    assert await svc.list_approvals(status="pending") == []  # swept before listing
    assert (await svc.get_run(run["id"]))["error"] == "approval_expired"


async def test_expiry_at_decide_time(svc, fake, project_dir: Path):
    run, a = await _waiting(svc, fake, project_dir, write_file_command("d.txt"))
    await _expire_now(svc, a["id"])
    with pytest.raises(Conflict) as ei:
        await svc.decide_approval(a["id"], "approve", digest=a["command_digest"])
    assert ei.value.code == "approval_expired"
    assert (await svc.get_approval(a["id"]))["status"] == "expired"
    failed = await svc.get_run(run["id"])
    assert failed["status"] == "failed" and failed["error"] == "approval_expired"
    assert not (project_dir / "d.txt").exists()


async def test_background_sweeper_expires_without_anyone_asking(svc, fake, project_dir: Path):
    svc.approval_sweep_s = 0.05
    await svc.stop()
    await svc.start()
    run, a = await _waiting(svc, fake, project_dir, write_file_command("s.txt"))
    await _expire_now(svc, a["id"])
    for _ in range(100):
        row = await svc._db(lambda c: c.execute(
            "SELECT status FROM agent_approvals WHERE id = ?", (a["id"],)).fetchone())
        if row[0] == "expired":
            break
        await asyncio.sleep(0.05)
    assert row[0] == "expired"


async def test_blocked_command_is_refused_automatically(svc, fake, project_dir: Path):
    agent, project = await setup_agent(svc, project_dir)
    fake.add(FakeTurn(approval=_request("powershell -EncodedCommand SQBFAFgA", "Truque")))
    fake.add(FakeTurn(final_message="entendi"))
    run = await svc.start_run(agent["id"], project["id"], "x")
    done = await wait_run(svc, run["id"], ("done", "failed"))
    assert done["status"] == "done" and done["approvals_used"] == 1
    assert await svc.list_approvals(status="pending") == []
    (a,) = await svc.list_approvals(status="denied")
    assert a["decided_by"] == "harness" and a["risk_level"] == "high" and a["decision_note"]
    assert a["status"] == "denied"
    (msg,) = _resume_messages(fake)
    assert "RECUSOU" in msg and a["decision_note"] in msg
    kinds = [e["kind"] for e in await svc.list_events(run["id"])]
    assert "approval_request" in kinds and "approval_result" in kinds
    assert not any(e["kind"] == "command" and e["payload"].get("by") == "harness"
                   for e in await svc.list_events(run["id"]))


async def test_blocked_commands_count_toward_the_limit(svc, fake, project_dir: Path):
    agent, project = await setup_agent(svc, project_dir)
    for _ in range(MAX_APPROVALS_PER_RUN + 1):
        fake.add(FakeTurn(approval=_request("diskpart")))
    run = await svc.start_run(agent["id"], project["id"], "x")
    final = await wait_run(svc, run["id"], ("failed", "done"))
    assert final["status"] == "failed" and final["error"] == "approval_limit"
    assert final["approvals_used"] == MAX_APPROVALS_PER_RUN
    assert len(_resume_messages(fake)) == MAX_APPROVALS_PER_RUN


async def test_data_dir_reference_is_blocked(store, fake, tmp_path: Path, project_dir: Path):
    from .conftest import make_settings

    data = tmp_path / "seraphine-data"
    data.mkdir()
    s = AgentHarnessService(store, make_settings(sqlite_path=data / "seraphine.sqlite"),
                            engines={"fake": fake}, heartbeat_s=0.2)
    await s.start()
    try:
        agent, project = await setup_agent(s, project_dir)
        fake.add(FakeTurn(approval=_request(f'Get-Content "{data / "seraphine.sqlite"}"')))
        fake.add(FakeTurn(final_message="ok"))
        run = await s.start_run(agent["id"], project["id"], "x")
        await wait_run(s, run["id"], ("done", "failed"))
        (a,) = await s.list_approvals(status="denied")
        assert a["decided_by"] == "harness" and "Seraphine" in a["decision_note"]
    finally:
        await s.stop()


async def test_denial_note_reaches_the_agent(svc, fake, project_dir: Path):
    run, a = await _waiting(svc, fake, project_dir, write_file_command("n.txt"),
                            [FakeTurn(final_message="ok")])
    out = await svc.decide_approval(a["id"], "deny", note="  use outro arquivo  ")
    assert out["decision_note"] == "use outro arquivo" and out["decided_by"] == "owner"
    await wait_run(svc, run["id"], ("done",))
    (msg,) = _resume_messages(fake)
    assert "RECUSOU" in msg and "use outro arquivo" in msg


async def test_tampered_command_is_not_run(svc, fake, project_dir: Path):
    run, a = await _waiting(svc, fake, project_dir, write_file_command("original.txt"))
    await svc._db(lambda c: c.execute(
        "UPDATE agent_approvals SET command = ? WHERE id = ?",
        (write_file_command("trocado.txt"), a["id"])))
    await svc.decide_approval(a["id"], "approve", digest=a["command_digest"])
    failed = await wait_run(svc, run["id"], ("failed", "done"))
    assert failed["status"] == "failed" and failed["error"] == "approval_tampered"
    assert not (project_dir / "trocado.txt").exists() and not (project_dir / "original.txt").exists()
    assert _resume_messages(fake) == []


async def test_pre_migration_rows_come_back_complete(svc, fake, project_dir: Path):
    agent, project = await setup_agent(svc, project_dir)

    def seed(conn):
        conn.execute(
            "INSERT INTO agent_runs (id, agent_id, project_id, goal, status, engine, session_ref,"
            " created_at) VALUES ('r1', ?, ?, 'g', 'waiting_approval', 'fake', 's', ?)",
            (agent["id"], project["id"], _now()))
        for aid, status, cmd in (("old-pending", "pending", "git push --force"),
                                 ("old-done", "approved", "echo hi")):
            conn.execute(
                "INSERT INTO agent_approvals (id, run_id, agent_id, project_id, title, command, reason,"
                " status, output, created_at) VALUES (?, 'r1', ?, ?, 't', ?, '', ?, ?, ?)",
                (aid, agent["id"], project["id"], cmd, status,
                 None if status == "pending" else "ok", _now()))

    await svc._db(seed)
    for read in (lambda: svc.list_approvals(), None):  # live read, then after a restart-style backfill
        if read is None:
            await svc._backfill_approvals()
            raw = await svc._db(lambda c: c.execute(
                "SELECT command_digest, risk_level, expires_at FROM agent_approvals"
                " WHERE id = 'old-pending'").fetchone())
            assert all(raw)
        rows = {r["id"]: r for r in await svc.list_approvals()}
        old = rows["old-pending"]
        for key in CONTRACT_FIELDS:
            assert key in old
        assert old["risk_level"] == "high" and old["risk_reasons"] and old["decided_by"] is None
        assert old["command_digest"] == command_digest("r1", "old-pending", "git push --force")
        assert old["expires_at"] > old["created_at"]
        assert rows["old-done"]["decided_by"] == "owner" and rows["old-done"]["risk_level"] == "low"
    # the legacy pending row can be decided with the computed digest
    out = await svc.decide_approval("old-pending", "deny")
    assert out["status"] == "denied"


def test_migration_adds_columns_to_an_old_table():
    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE TABLE agent_approvals (id TEXT PRIMARY KEY, run_id TEXT NOT NULL,"
                 " agent_id TEXT NOT NULL, project_id TEXT NOT NULL, title TEXT NOT NULL,"
                 " command TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',"
                 " status TEXT NOT NULL DEFAULT 'pending', output TEXT, created_at TEXT NOT NULL,"
                 " decided_at TEXT)")
    agents_schema.migrate(conn)
    agents_schema.migrate(conn)  # idempotent
    cols = {r[1] for r in conn.execute("PRAGMA table_info(agent_approvals)")}
    assert set(CONTRACT_FIELDS) <= cols


# -- clean child environment + redaction ---------------------------------------


def _echo_env_command() -> str:
    if os.name == "nt":
        return 'Write-Output "[$env:SERAPHINE_FAKE_SECRET][$env:X_API_KEY]"'
    return 'echo "[$SERAPHINE_FAKE_SECRET][$X_API_KEY]"'


async def test_child_env_has_no_secrets_and_output_is_redacted(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("SERAPHINE_FAKE_SECRET", "segredo-super-secreto-1")
    monkeypatch.setenv("X_API_KEY", "chave-do-provedor-2")
    env = clean_env()
    assert "SERAPHINE_FAKE_SECRET" not in env and "X_API_KEY" not in env
    assert not any(k.upper().startswith("SERAPHINE_") for k in env)
    assert "PATH" in {k.upper() for k in env}

    code, out, timed_out, _ = await run_shell_command(
        _echo_env_command(), cwd=str(tmp_path), timeout_s=60, cancel=asyncio.Event())
    assert code == 0 and not timed_out
    assert "[][]" in out  # neither variable reached the child

    literal = "Write-Output 'chave-do-provedor-2 e segredo-super-secreto-1'" if os.name == "nt" \
        else "echo 'chave-do-provedor-2 e segredo-super-secreto-1'"
    _, out2, _, _ = await run_shell_command(
        literal, cwd=str(tmp_path), timeout_s=60, cancel=asyncio.Event())
    assert "[oculto] e [oculto]" in out2
    assert "chave-do-provedor-2" not in out2 and "segredo-super-secreto-1" not in out2


async def test_short_secret_values_are_not_redacted(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("X_API_KEY", "abc")
    cmd = "Write-Output 'abc'" if os.name == "nt" else "echo abc"
    _, out, _, _ = await run_shell_command(cmd, cwd=str(tmp_path), timeout_s=60, cancel=asyncio.Event())
    assert out.strip() == "abc"


# -- HTTP ---------------------------------------------------------------------


async def test_http_decide_errors_carry_code_and_no_store(svc, fake, project_dir: Path):
    app = FastAPI()
    app.include_router(router)
    app.state.agent_harness = svc
    run, a = await _waiting(svc, fake, project_dir, "echo $HOME", [FakeTurn(final_message="fim")])
    transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 5000))
    async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8000",
                                 headers={TOKEN_HEADER: svc.token, "Origin": ORIGIN}) as c:
        url = f"/agents/approvals/{a['id']}/decide"
        r = await c.post(url, json={"decision": "approve", "digest": "bad"})
        assert r.status_code == 409 and r.json()["code"] == "digest_mismatch" and r.json()["detail"]
        assert r.headers["cache-control"] == "no-store"
        r = await c.post(url, json={"decision": "approve", "digest": a["command_digest"]})
        assert r.status_code == 409 and r.json()["code"] == "high_risk_unconfirmed"
        assert (await c.post(url, json={"decision": "approve"})).status_code == 422
        assert (await c.post(url, json={"decision": "deny", "note": "x" * 501})).status_code == 422
        r = await c.post(url, json={"decision": "approve", "digest": a["command_digest"],
                                    "confirm_high_risk": True, "note": "ok"})
        assert r.status_code == 200 and r.json()["approval"]["status"] == "approved"
        assert r.headers["cache-control"] == "no-store"
        r = await c.post(url, json={"decision": "deny"})
        assert r.status_code == 409 and r.json()["code"] == "already_decided"
        listed = await c.get("/agents/approvals?status=approved")
        assert [x["id"] for x in listed.json()["approvals"]] == [a["id"]]
        assert (await c.get("/agents/approvals?status=expired")).status_code == 200
        assert (await c.get("/agents/approvals?status=bogus")).status_code == 422
    await wait_run(svc, run["id"], ("done",))
