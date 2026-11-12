"""Human-in-the-loop approval flow."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from seraphine.agents.engines.fake import FakeEngine, FakeTurn
from seraphine.agents.errors import Conflict
from seraphine.agents.prompts import parse_approval_request
from seraphine.agents.service import MAX_APPROVALS_PER_RUN

from .conftest import setup_agent, wait_run, write_file_command


def _request(command: str, title: str = "Gravar arquivo") -> dict:
    return {"title": title, "command": command, "reason": "preciso disso"}


async def test_approve_runs_command_in_project_dir_and_resumes(svc, fake: FakeEngine, project_dir: Path):
    agent, project = await setup_agent(svc, project_dir)
    task = await svc.create_task(project_id=project["id"], title="T")
    cmd = write_file_command("approved.txt", "hello")
    fake.add(FakeTurn(final_message="Preciso gravar.", approval=_request(cmd)))
    fake.add(FakeTurn(final_message="Tudo pronto.", tokens_in=3))

    run = await svc.start_run(agent["id"], project["id"], "grave", task_id=task["id"])
    r = await wait_run(svc, run["id"], ("waiting_approval", "failed"))
    assert r["status"] == "waiting_approval" and r["approvals_used"] == 1
    assert not (project_dir / "approved.txt").exists()  # nothing ran yet
    assert (await svc.get_task(task["id"]))["status"] == "doing"

    pending = await svc.list_approvals(status="pending")
    assert len(pending) == 1 and pending[0]["command"] == cmd and pending[0]["run_id"] == run["id"]
    ov = await svc.overview()
    assert [a["id"] for a in ov["pending_approvals"]] == [pending[0]["id"]]
    assert [x["id"] for x in ov["active_runs"]] == [run["id"]]
    # the channel got a heads-up (without the raw fenced block)
    msgs = await svc.list_messages(project["id"])
    assert "Preciso da sua aprovação" in msgs[-1]["body"] and "```" not in msgs[-1]["body"]

    approval = await svc.decide_approval(pending[0]["id"], "approve", digest=pending[0]["command_digest"])
    assert approval["status"] == "approved"
    done = await wait_run(svc, run["id"], ("done", "failed"))
    assert done["status"] == "done", done
    assert done["result_summary"] == "Tudo pronto."

    # the harness itself ran exactly that command, in the project folder
    written = project_dir / "approved.txt"
    assert written.exists() and "hello" in written.read_text(errors="ignore")
    # the session was resumed (not restarted) with the exit code and output
    resume_calls = [c for c in fake.calls if c["op"] == "resume"]
    assert len(resume_calls) == 1
    assert resume_calls[0]["session_ref"] == done["session_ref"]
    assert "APROVOU" in resume_calls[0]["message"] and "código de saída 0" in resume_calls[0]["message"]
    assert cmd in resume_calls[0]["message"]

    events = await svc.list_events(run["id"])
    kinds = [e["kind"] for e in events]
    assert "approval_request" in kinds and "approval_result" in kinds
    harness_cmds = [e for e in events if e["kind"] == "command" and e["payload"].get("by") == "harness"]
    assert len(harness_cmds) == 1 and harness_cmds[0]["payload"]["exit_code"] == 0
    assert kinds.index("approval_request") < kinds.index("approval_result") < kinds.index("command", kinds.index("approval_result"))
    assert (await svc.get_task(task["id"]))["status"] == "review"
    stored = await svc.get_approval(pending[0]["id"])
    assert stored["status"] == "approved" and stored["output"] is not None and stored["decided_at"]
    assert (await svc.list_approvals(status="pending")) == []


async def test_command_output_is_captured_and_failure_code_reported(svc, fake: FakeEngine, project_dir: Path):
    agent, project = await setup_agent(svc, project_dir)
    cmd = "Write-Output 'saida-xyz'; exit 3" if os.name == "nt" else "echo saida-xyz; exit 3"
    fake.add(FakeTurn(approval=_request(cmd)))
    fake.add(FakeTurn(final_message="visto"))
    run = await svc.start_run(agent["id"], project["id"], "x")
    await wait_run(svc, run["id"], ("waiting_approval",))
    (a,) = await svc.list_approvals(status="pending")
    await svc.decide_approval(a["id"], "approve", digest=a["command_digest"])
    await wait_run(svc, run["id"], ("done",))
    msg = [c for c in fake.calls if c["op"] == "resume"][0]["message"]
    assert "saida-xyz" in msg and "código de saída 3" in msg


async def test_deny_resumes_without_running(svc, fake: FakeEngine, project_dir: Path):
    agent, project = await setup_agent(svc, project_dir)
    fake.add(FakeTurn(approval=_request(write_file_command("nope.txt"))))
    fake.add(FakeTurn(final_message="ok, sem isso"))
    run = await svc.start_run(agent["id"], project["id"], "x")
    await wait_run(svc, run["id"], ("waiting_approval",))
    (a,) = await svc.list_approvals(status="pending")
    out = await svc.decide_approval(a["id"], "deny")
    assert out["status"] == "denied"
    done = await wait_run(svc, run["id"], ("done",))
    assert done["result_summary"] == "ok, sem isso"
    assert not (project_dir / "nope.txt").exists()
    msg = [c for c in fake.calls if c["op"] == "resume"][0]["message"]
    assert "RECUSOU" in msg
    events = await svc.list_events(run["id"])
    assert not any(e["kind"] == "command" and e["payload"].get("by") == "harness" for e in events)


async def test_double_decide_conflicts_and_unknown_404(svc, fake: FakeEngine, project_dir: Path):
    from seraphine.agents.errors import NotFound

    agent, project = await setup_agent(svc, project_dir)
    fake.add(FakeTurn(approval=_request("echo x")))
    run = await svc.start_run(agent["id"], project["id"], "x")
    await wait_run(svc, run["id"], ("waiting_approval",))
    (a,) = await svc.list_approvals(status="pending")
    await svc.decide_approval(a["id"], "deny")
    with pytest.raises(Conflict):
        await svc.decide_approval(a["id"], "approve", digest=a["command_digest"])
    with pytest.raises(NotFound):
        await svc.decide_approval("nao-existe", "approve", digest="x")


async def test_cancel_waiting_run_closes_approval(svc, fake: FakeEngine, project_dir: Path):
    agent, project = await setup_agent(svc, project_dir)
    fake.add(FakeTurn(approval=_request("echo x")))
    run = await svc.start_run(agent["id"], project["id"], "x")
    await wait_run(svc, run["id"], ("waiting_approval",))
    assert (await svc.cancel_run(run["id"]))["status"] == "cancelled"
    assert await svc.list_approvals(status="pending") == []


async def test_approvals_cap_per_run(svc, fake: FakeEngine, project_dir: Path):
    agent, project = await setup_agent(svc, project_dir)
    for _ in range(MAX_APPROVALS_PER_RUN + 1):
        fake.add(FakeTurn(approval=_request("echo x")))
    run = await svc.start_run(agent["id"], project["id"], "x")
    for i in range(MAX_APPROVALS_PER_RUN):
        await wait_run(svc, run["id"], ("waiting_approval",))
        (a,) = await svc.list_approvals(status="pending")
        await svc.decide_approval(a["id"], "deny")
        if i < MAX_APPROVALS_PER_RUN - 1:
            await wait_for_next_wait(svc, run["id"], i + 2)
    final = await wait_run(svc, run["id"], ("failed",))
    assert final["error"] == "approval_limit"
    assert final["approvals_used"] == MAX_APPROVALS_PER_RUN
    assert await svc.list_approvals(status="pending") == []


async def wait_for_next_wait(svc, run_id: str, expected_used: int) -> None:
    import asyncio
    import time

    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        run = await svc.get_run(run_id)
        if run["status"] == "waiting_approval" and run["approvals_used"] == expected_used:
            return
        await asyncio.sleep(0.02)
    raise AssertionError("did not reach next approval round")


async def test_commands_blocked_ignores_block(svc, fake: FakeEngine, project_dir: Path):
    agent, project = await setup_agent(svc, project_dir, perm_commands="blocked")
    fake.add(FakeTurn(final_message="Queria rodar algo.", approval=_request(write_file_command("x.txt"))))
    run = await svc.start_run(agent["id"], project["id"], "x")
    done = await wait_run(svc, run["id"], ("done", "waiting_approval", "failed"))
    assert done["status"] == "done"
    assert await svc.list_approvals() == []
    assert not (project_dir / "x.txt").exists()
    assert "approval-request" not in fake.calls[0]["ctx"].prompt  # told it cannot ask
    events = await svc.list_events(run["id"])
    assert any(e["kind"] == "step" and e["payload"].get("type") == "note" for e in events)
    msgs = await svc.list_messages(project["id"])
    assert "```" not in msgs[-1]["body"]


async def test_invalid_block_is_ignored_with_note(svc, fake: FakeEngine, project_dir: Path):
    agent, project = await setup_agent(svc, project_dir)
    fake.add(FakeTurn(final_message="x\n\n```approval-request\n{not json}\n```"))
    run = await svc.start_run(agent["id"], project["id"], "x")
    await wait_run(svc, run["id"], ("done",))
    assert await svc.list_approvals() == []


async def test_approval_request_over_http_never_takes_command_from_client(svc, fake, project_dir: Path):
    """decide only accepts a decision; the stored command is what runs."""
    from seraphine.agents.routes import DecideBody
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        DecideBody(decision="approve", command="rm -rf /")  # type: ignore[call-arg]
    with pytest.raises(ValidationError):
        DecideBody(decision="yes")  # type: ignore[arg-type]


def test_parse_approval_request():
    text = 'ok\n```approval-request\n{"title": "T", "command": "git push", "reason": "r"}\n```\n'
    req, problem = parse_approval_request(text)
    assert problem is None and (req.title, req.command, req.reason) == ("T", "git push", "r")
    assert parse_approval_request("nada")[0] is None
    assert parse_approval_request("```approval-request\n{}\n```")[1] is not None
    assert parse_approval_request('```approval-request\n["x"]\n```')[1] is not None
    # last block wins; title defaults to the command
    two = ('```approval-request\n{"command": "a"}\n```\n```approval-request\n{"command": "b"}\n```')
    assert parse_approval_request(two)[0].command == "b"
    assert parse_approval_request(two)[0].title == "b"
