"""Phase 6c part 2: undoing a freshly created team (``POST /agents/team/batches/{id}/undo``)."""

from __future__ import annotations

from datetime import timedelta
from pathlib import Path

from .chat_helpers import DAILY, agent_obj, api, fixed_clock, p_create_agents, propose
from .conftest import draft
from .page_helpers import add_run

TEAM = "/agents/team"


def with_routine(d):
    return {**d, "routines": [{"title": "Diária", "prompt": "Faça.", "schedule": DAILY}]}


async def make_team(hsvc, *drafts):
    code, out = await api(hsvc, "POST", TEAM, json={"origin": "guide", "agents": list(drafts)})
    assert code == 200, out
    return out


def ids(out):
    return [i["def"]["id"] for i in out["created"]]


async def undo(hsvc, batch_id):
    return await api(hsvc, "POST", f"{TEAM}/batches/{batch_id}/undo")


# -- the batch ---------------------------------------------------------------------------------------------------


async def test_the_team_route_returns_a_batch_and_the_batch_can_be_read(hsvc):
    clock = fixed_clock(hsvc)
    out = await make_team(hsvc, draft("Ana"), draft("Beto"))
    batch = out["batch"]
    assert set(batch) == {"id", "undo_until"}
    assert batch["undo_until"] == (clock["now"] + timedelta(seconds=86400)).isoformat(timespec="microseconds")
    code, got = await api(hsvc, "GET", f"{TEAM}/batches/{batch['id']}")
    assert code == 200
    assert got["batch"] == {"id": batch["id"], "undo_until": batch["undo_until"], "undone_at": None, "can_undo": True,
                            "agents": [{"agent_id": i, "name": n, "exists": True}
                                       for i, n in zip(ids(out), ("Ana", "Beto"))]}


async def test_no_batch_when_nothing_was_created_and_failed_agents_are_not_in_it(hsvc):
    first = await make_team(hsvc, draft("Ana"))
    out = await make_team(hsvc, draft("Ana"))  # the repeated click: nothing new
    assert out["created"] == [] and out["batch"] is None
    out = await make_team(hsvc, draft("Ana"), draft("Beto"))
    code, got = await api(hsvc, "GET", f"{TEAM}/batches/{out['batch']['id']}")
    assert [a["name"] for a in got["batch"]["agents"]] == ["Beto"]
    assert first["batch"]["id"] != out["batch"]["id"]


async def test_batch_window_follows_the_setting(hsvc):
    hsvc.team_undo_s = 60
    clock = fixed_clock(hsvc)
    out = await make_team(hsvc, draft("Ana"))
    assert out["batch"]["undo_until"] == (clock["now"] + timedelta(seconds=60)).isoformat(timespec="microseconds")


async def test_a_proposal_that_creates_agents_returns_its_batch_in_the_result(hsvc):
    [p] = await propose(hsvc, p_create_agents(agent_obj("Caio"), agent_obj("Dani")))
    code, out = await api(hsvc, "POST", f"/agents/guide/proposals/{p['id']}/apply")
    assert code == 200
    batch = out["proposal"]["result"]["batch"]
    assert set(batch) == {"id", "undo_until"} and out["proposal"]["result"]["agent_ids"]
    code, got = await api(hsvc, "GET", f"{TEAM}/batches/{batch['id']}")
    assert [a["name"] for a in got["batch"]["agents"]] == ["Caio", "Dani"]
    code, res = await undo(hsvc, batch["id"])
    assert code == 200 and [r["name"] for r in res["removed"]] == ["Caio", "Dani"]
    assert await hsvc.list_defs(include_archived=True) == []


async def test_a_proposal_that_created_nothing_has_no_batch(hsvc):
    await hsvc.create_def(name="Caio", engine="fake")
    [p] = await propose(hsvc, p_create_agents(agent_obj("Caio")))
    code, out = await api(hsvc, "POST", f"/agents/guide/proposals/{p['id']}/apply")
    assert out["proposal"]["status"] == "failed" and "batch" not in (out["proposal"]["result"] or {})


# -- the three outcomes ------------------------------------------------------------------------------------------


async def test_undo_deletes_agents_that_never_ran_with_their_routines_history_and_checklist(hsvc):
    out = await make_team(hsvc, with_routine(draft("Ana")), draft("Beto"))
    ana, beto = ids(out)
    home = out["created"][0]["home"]
    folder = Path(home["path"])
    assert folder.is_dir() and len(out["routines"]) == 1
    await api(hsvc, "PUT", f"/agents/defs/{ana}/checklist", json={"access_ok": True})
    assert await hsvc.store.get_kv(f"agents.checklist.{ana}") is not None
    versions = await hsvc._db(lambda c: c.execute("SELECT COUNT(*) FROM agent_versions WHERE agent_id = ?", (ana,)).fetchone()[0])
    assert versions == 1
    code, res = await undo(hsvc, out["batch"]["id"])
    assert code == 200
    assert res == {"removed": [{"agent_id": ana, "name": "Ana"}, {"agent_id": beto, "name": "Beto"}],
                   "archived": [], "kept": []}
    assert await hsvc.get_def(ana) is None and await hsvc.get_def(beto) is None
    assert await hsvc.list_routines() == []
    assert await hsvc._db(lambda c: c.execute("SELECT COUNT(*) FROM agent_versions").fetchone()[0]) == 0
    assert await hsvc.store.get_kv(f"agents.checklist.{ana}") is None
    archived_home = await hsvc.get_project(home["id"])
    assert archived_home["archived"] is True and archived_home["agent_id"] is None
    assert folder.is_dir()  # the folder on disk is never touched
    code, got = await api(hsvc, "GET", f"{TEAM}/batches/{out['batch']['id']}")
    assert got["batch"]["can_undo"] is False and got["batch"]["undone_at"]
    assert [a["exists"] for a in got["batch"]["agents"]] == [False, False]


async def test_undo_archives_an_agent_that_already_ran_and_keeps_what_it_had(hsvc):
    out = await make_team(hsvc, with_routine(draft("Ana", grants={"notes": "write"})), draft("Beto"))
    ana, beto = ids(out)
    home = out["created"][0]["home"]
    await add_run(hsvc, ana, home["id"], created_at="2026-11-12T10:00:00+00:00", status="done")
    before = await hsvc.get_def(ana)
    code, res = await undo(hsvc, out["batch"]["id"])
    assert code == 200
    assert res == {"removed": [{"agent_id": beto, "name": "Beto"}],
                   "archived": [{"agent_id": ana, "name": "Ana"}], "kept": []}
    after = await hsvc.get_def(ana)
    assert after["archived"] is True and after["grants"] == before["grants"] and after["engine"] == before["engine"]
    assert (await hsvc.get_project(home["id"]))["archived"] is True
    assert len(await hsvc.list_routines(ana)) == 1 and await hsvc.get_def(beto) is None
    code, got = await api(hsvc, "GET", f"{TEAM}/batches/{out['batch']['id']}")
    assert [a["exists"] for a in got["batch"]["agents"]] == [True, False]  # archived still exists


async def test_undo_keeps_an_agent_with_a_run_in_progress(hsvc):
    out = await make_team(hsvc, draft("Ana"), draft("Beto"))
    ana, beto = ids(out)
    await add_run(hsvc, ana, out["created"][0]["home"]["id"], created_at="2026-11-12T10:00:00+00:00",
                  status="running")
    code, res = await undo(hsvc, out["batch"]["id"])
    assert code == 200 and res["removed"] == [{"agent_id": beto, "name": "Beto"}] and res["archived"] == []
    assert len(res["kept"]) == 1 and res["kept"][0]["agent_id"] == ana and res["kept"][0]["detail"]
    kept = await hsvc.get_def(ana)
    assert kept is not None and kept["archived"] is False
    code, again = await undo(hsvc, out["batch"]["id"])  # the batch is spent even though one was kept
    assert code == 409 and again["code"] == "already_undone"


async def test_an_agent_the_owner_already_deleted_or_archived_is_handled(hsvc):
    out = await make_team(hsvc, draft("Ana"), draft("Beto"), draft("Caio"))
    ana, beto, caio = ids(out)
    await hsvc.delete_def(ana)
    await hsvc.archive_def(beto)
    code, res = await undo(hsvc, out["batch"]["id"])
    assert code == 200
    assert [r["name"] for r in res["removed"]] == ["Beto", "Caio"]  # an archived agent that never ran goes too
    assert res["archived"] == [] and res["kept"] == []


# -- the refusals ------------------------------------------------------------------------------------------------


async def test_undo_expires(hsvc):
    clock = fixed_clock(hsvc)
    out = await make_team(hsvc, draft("Ana"))
    clock["now"] += timedelta(seconds=86399)
    code, got = await api(hsvc, "GET", f"{TEAM}/batches/{out['batch']['id']}")
    assert got["batch"]["can_undo"] is True
    clock["now"] += timedelta(seconds=2)
    code, got = await api(hsvc, "GET", f"{TEAM}/batches/{out['batch']['id']}")
    assert got["batch"]["can_undo"] is False and got["batch"]["undone_at"] is None
    code, res = await undo(hsvc, out["batch"]["id"])
    assert code == 409 and res["code"] == "undo_expired"
    assert await hsvc.get_def(ids(out)[0]) is not None  # nothing was touched


async def test_double_undo_and_unknown_batch(hsvc):
    out = await make_team(hsvc, draft("Ana"))
    assert (await undo(hsvc, out["batch"]["id"]))[0] == 200
    code, res = await undo(hsvc, out["batch"]["id"])
    assert code == 409 and res["code"] == "already_undone"
    assert (await undo(hsvc, "nao-existe"))[0] == 404
    assert (await api(hsvc, "GET", f"{TEAM}/batches/nao-existe"))[0] == 404


async def test_the_second_undo_is_already_undone_even_after_the_window(hsvc):
    clock = fixed_clock(hsvc)
    out = await make_team(hsvc, draft("Ana"))
    await undo(hsvc, out["batch"]["id"])
    clock["now"] += timedelta(days=3)
    code, res = await undo(hsvc, out["batch"]["id"])
    assert code == 409 and res["code"] == "already_undone"


async def test_undo_never_changes_the_access_of_what_stays(hsvc):
    out = await make_team(hsvc, draft("Ana", grants={"notes": "write", "wiki": "read"}))
    ana = ids(out)[0]
    await add_run(hsvc, ana, out["created"][0]["home"]["id"], created_at="2026-11-12T10:00:00+00:00")
    before = await hsvc.get_grants(ana)
    await undo(hsvc, out["batch"]["id"])
    assert await hsvc.get_grants(ana) == before
    assert await hsvc.store.get_kv(f"agents.checklist.{ana}") is None  # and it did not count as the owner's look
