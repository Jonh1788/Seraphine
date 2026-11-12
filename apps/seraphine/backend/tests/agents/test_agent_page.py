"""Phase 6c part 2: ``GET /agents/defs/{id}/page`` and the checklist (``PUT /agents/defs/{id}/checklist``)."""

from __future__ import annotations

import json

from seraphine.agents import catalog
from seraphine.agents.engines.fake import FakeTurn

from .chat_helpers import DAILY, api, make_agent
from .conftest import draft, wait_run
from .page_helpers import add_run

PAGE = "/agents/defs/{}/page"
CHECKLIST = "/agents/defs/{}/checklist"


def item(page_or_checklist, item_id):
    checklist = page_or_checklist.get("checklist", page_or_checklist)
    return next(i for i in checklist["items"] if i["id"] == item_id)


async def page(hsvc, agent_id):
    code, out = await api(hsvc, "GET", PAGE.format(agent_id))
    assert code == 200, out
    return out


# -- the page --------------------------------------------------------------------------------------------------


async def test_page_of_a_fresh_agent(hsvc):
    a = await make_agent(hsvc)
    out = await page(hsvc, a["id"])
    assert set(out) == {"def", "home", "engine", "access", "routines", "activity", "checklist"}
    assert out["def"]["id"] == a["id"] and out["def"]["archived"] is False and out["home"] is None
    assert out["engine"]["ready"] is True and out["engine"]["how"] == "" and out["engine"]["label"]
    assert [x["group"] for x in out["access"]] == [g.id for g in catalog.GRANT_GROUPS]
    notes = next(x for x in out["access"] if x["group"] == "notes")
    assert notes == {"group": "notes", "label": "Notas", "level": "read"}
    assert next(x for x in out["access"] if x["group"] == "memory")["level"] == "none"
    assert out["routines"] == {"total": 0, "active": 0, "next_run_at": None}
    assert out["activity"] == {"runs": 0, "last_run_at": None, "tokens_in": 0, "tokens_out": 0}
    assert out["checklist"] == {
        "items": [{"id": "engine", "done": True, "optional": False},
                  {"id": "first_talk", "done": False, "optional": False},
                  {"id": "access", "done": False, "optional": False},
                  {"id": "routine", "done": False, "optional": True}],
        "done": 1, "total": 4, "dismissed": False}
    assert (await api(hsvc, "GET", PAGE.format("nao-existe")))[0] == 404


async def test_page_engine_not_ready_says_how_and_the_checklist_follows(hsvc):
    hsvc.cli_state["cli_ok"] = False
    a = await make_agent(hsvc, engine="claude_code", provider="anthropic")
    out = await page(hsvc, a["id"])
    assert out["engine"]["ready"] is False and out["engine"]["label"] == "Plano do Claude (Claude Code)"
    assert "Claude Code" in out["engine"]["how"] and out["engine"]["how"].endswith(".")
    assert item(out, "engine")["done"] is False and out["checklist"]["done"] == 0
    hsvc.cli_state["cli_ok"] = True
    hsvc.providers._cache.clear()
    out = await page(hsvc, a["id"])
    assert out["engine"] == {"ready": True, "label": "Plano do Claude (Claude Code)", "how": ""}
    assert item(out, "engine")["done"] is True


async def test_page_with_runs_routines_home_and_changed_grants(hsvc):
    a = await make_agent(hsvc)
    home = await hsvc.ensure_home(a["id"])
    hsvc.engines["fake"].add(FakeTurn(tokens_in=120, tokens_out=30, cost_usd=0.25))
    posted = await hsvc.post_message(home["id"], "Oi")
    await wait_run(hsvc, posted["run"]["id"], ("done",))
    await add_run(hsvc, a["id"], home["id"], created_at="2030-01-01T10:00:00+00:00", status="failed",
                  tokens_in=5, tokens_out=7)
    on = await hsvc.create_routine(agent_id=a["id"], title="Ligada", prompt="p", schedule=DAILY)
    await hsvc.create_routine(agent_id=a["id"], title="Pausada", prompt="p", schedule=DAILY, enabled=False)
    code, grants = await api(hsvc, "PUT", f"/agents/defs/{a['id']}/grants", json={"grants": {"notes": "write"}})
    assert code == 200
    out = await page(hsvc, a["id"])
    assert out["home"]["id"] == home["id"] and out["home"]["kind"] == "home"
    assert out["def"]["home_project_id"] == home["id"]
    assert out["routines"] == {"total": 2, "active": 1, "next_run_at": on["next_run_at"]}
    assert out["activity"]["runs"] == 2 and out["activity"]["last_run_at"] == "2030-01-01T10:00:00+00:00"
    assert out["activity"]["tokens_in"] == 125 and out["activity"]["tokens_out"] == 37
    assert next(x for x in out["access"] if x["group"] == "notes")["level"] == "write"
    assert [(i["id"], i["done"]) for i in out["checklist"]["items"]] == [
        ("engine", True), ("first_talk", True), ("access", True), ("routine", True)]
    assert out["checklist"]["done"] == 4 and out["checklist"]["total"] == 4


async def test_first_talk_needs_a_finished_run_not_a_failed_one(hsvc):
    a = await make_agent(hsvc)
    home = await hsvc.ensure_home(a["id"])
    await add_run(hsvc, a["id"], home["id"], created_at="2026-11-12T10:00:00+00:00", status="failed")
    assert item(await page(hsvc, a["id"]), "first_talk")["done"] is False
    await add_run(hsvc, a["id"], home["id"], created_at="2026-11-12T11:00:00+00:00", status="done")
    assert item(await page(hsvc, a["id"]), "first_talk")["done"] is True


async def test_the_page_of_an_archived_agent_is_readable(hsvc):
    a = await make_agent(hsvc)
    await hsvc.archive_def(a["id"])
    out = await page(hsvc, a["id"])
    assert out["def"]["archived"] is True and out["def"]["archived_at"]


# -- the access item ---------------------------------------------------------------------------------------------


async def test_access_done_only_by_the_owners_hand_not_by_a_team_or_a_direct_call(hsvc):
    out = await hsvc.create_team("guide", [draft("Ana", grants={"notes": "write", "wiki": "read"})])
    ana = out["created"][0]["def"]
    assert ana["grants"]["notes"] == "write"
    assert item(await page(hsvc, ana["id"]), "access")["done"] is False  # a team set the first grants
    await hsvc.set_grants(ana["id"], {"wiki": "none"})  # service call without the owner's hand
    assert item(await page(hsvc, ana["id"]), "access")["done"] is False
    assert await hsvc.store.get_kv(f"agents.checklist.{ana['id']}") is None
    code, _ = await api(hsvc, "PUT", f"/agents/defs/{ana['id']}/grants", json={"grants": {"wiki": "read"}})
    assert code == 200
    assert item(await page(hsvc, ana["id"]), "access")["done"] is True
    # an invalid change is refused and counts for nothing
    b = await make_agent(hsvc, "Beto")
    code, _ = await api(hsvc, "PUT", f"/agents/defs/{b['id']}/grants", json={"grants": {"notes": "admin"}})
    assert code == 422 and item(await page(hsvc, b["id"]), "access")["done"] is False


async def test_a_proposal_that_creates_agents_does_not_count_as_the_owner_checking_access(hsvc):
    from .chat_helpers import agent_obj, p_create_agents, propose

    [p] = await propose(hsvc, p_create_agents(agent_obj("Caio", grants={"reminders": "write"})))
    code, out = await api(hsvc, "POST", f"/agents/guide/proposals/{p['id']}/apply")
    assert code == 200
    caio = out["agents"][0]
    assert caio["grants"]["reminders"] == "write"
    assert item(await page(hsvc, caio["id"]), "access")["done"] is False


# -- the checklist ---------------------------------------------------------------------------------------------


async def test_put_checklist_flags_flip_the_items_and_come_back_in_the_page(hsvc):
    a = await make_agent(hsvc)
    code, out = await api(hsvc, "PUT", CHECKLIST.format(a["id"]), json={})
    assert code == 200 and out["checklist"]["done"] == 1 and out["checklist"]["dismissed"] is False
    code, out = await api(hsvc, "PUT", CHECKLIST.format(a["id"]), json={"access_ok": True})
    assert item(out, "access")["done"] is True and out["checklist"]["done"] == 2
    code, out = await api(hsvc, "PUT", CHECKLIST.format(a["id"]), json={"routine_skipped": True})
    assert item(out, "routine")["done"] is True and item(out, "access")["done"] is True  # a partial body keeps the rest
    assert out["checklist"]["done"] == 3
    code, out = await api(hsvc, "PUT", CHECKLIST.format(a["id"]), json={"dismissed": True})
    assert out["checklist"]["dismissed"] is True
    assert (await page(hsvc, a["id"]))["checklist"] == out["checklist"]
    code, out = await api(hsvc, "PUT", CHECKLIST.format(a["id"]),
                          json={"access_ok": False, "routine_skipped": False, "dismissed": False})
    assert out["checklist"] == {"items": [{"id": "engine", "done": True, "optional": False},
                                          {"id": "first_talk", "done": False, "optional": False},
                                          {"id": "access", "done": False, "optional": False},
                                          {"id": "routine", "done": False, "optional": True}],
                                "done": 1, "total": 4, "dismissed": False}


async def test_the_routine_item_follows_real_routines_and_the_stored_flag_survives_them(hsvc):
    a = await make_agent(hsvc)
    assert item(await page(hsvc, a["id"]), "routine")["done"] is False
    routine = await hsvc.create_routine(agent_id=a["id"], title="T", prompt="p", schedule=DAILY, enabled=False)
    assert item(await page(hsvc, a["id"]), "routine")["done"] is True  # a paused routine still counts
    await hsvc.delete_routine(routine["id"])
    assert item(await page(hsvc, a["id"]), "routine")["done"] is False
    await api(hsvc, "PUT", CHECKLIST.format(a["id"]), json={"routine_skipped": True})
    assert item(await page(hsvc, a["id"]), "routine")["done"] is True


async def test_checklist_is_stored_under_its_key_and_removed_with_the_agent(hsvc):
    a = await make_agent(hsvc)
    await api(hsvc, "PUT", CHECKLIST.format(a["id"]), json={"access_ok": True, "dismissed": True})
    raw = await hsvc.store.get_kv(f"agents.checklist.{a['id']}")
    assert raw is not None and json.loads(raw)["access_ok"] is True and json.loads(raw)["dismissed"] is True
    code, _ = await api(hsvc, "DELETE", f"/agents/defs/{a['id']}")
    assert code == 200
    assert await hsvc.store.get_kv(f"agents.checklist.{a['id']}") is None
    assert (await api(hsvc, "PUT", CHECKLIST.format(a["id"]), json={"access_ok": True}))[0] == 404
    assert await hsvc.store.get_kv(f"agents.checklist.{a['id']}") is None  # a 404 stores nothing


async def test_put_checklist_validation(hsvc):
    a = await make_agent(hsvc)
    for body in ({"access_ok": "sim"}, {"dismissed": 1}, {"outra": True}, {"routine_skipped": None}):
        assert (await api(hsvc, "PUT", CHECKLIST.format(a["id"]), json=body))[0] == 422
    assert (await api(hsvc, "PUT", CHECKLIST.format("nao-existe"), json={}))[0] == 404
    assert await hsvc.store.get_kv(f"agents.checklist.{a['id']}") is None
