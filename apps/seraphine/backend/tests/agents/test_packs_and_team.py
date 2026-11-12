"""Phase 6a: ready-made teams (``GET /agents/packs``) and team creation (``POST /agents/team``)."""

from __future__ import annotations

from pathlib import Path

import pytest

from seraphine.agents import drafts, packs
from seraphine.agents.catalog import LEVEL_RANK

from .conftest import draft, make_api

PACK_IDS = ["dia_em_ordem", "estudos", "programacao", "pesquisa_escrita", "trabalho_autonomo", "casa"]
#: Since phase 6b "rotina" is allowed (teams carry routines); the Google calendar and finances never are.
FORBIDDEN = ("agenda do google", "google agenda", "calendário", "calendario", "todo dia",
             "toda semana", "todo mês", "agendad", "finanças", "financeiro", "extrato")
ROUTINE_FORBIDDEN = ("agenda do google", "google agenda", "calendário", "calendario", "finanças",
                     "financeiro", "extrato", "saldo")


async def test_packs_endpoint_shape(hsvc):
    async with make_api(hsvc) as c:
        r = await c.get("/agents/packs")
    assert r.status_code == 200
    got = r.json()["packs"]
    assert [p["id"] for p in got] == PACK_IDS
    for p in got:
        assert set(p) == {"id", "label", "summary", "detail", "areas", "agents"}
        assert p["label"] and p["summary"] and p["detail"] and p["areas"]
        assert len(p["agents"]) == 2


def test_every_pack_agent_is_valid_and_within_the_ceiling():
    names: list[str] = []
    banned_names = {"lodi", "rui", "duda", "clara"}
    for p in packs.PACKS:
        for a in p["agents"]:
            checked = drafts.check_draft(a)  # same rules as the page's body
            assert 1 <= len(a["name"]) <= 80 and a["name"].split()[0].lower() not in banned_names
            names.append(a["name"].casefold())
            assert len(a["role"]) <= 200 and len(a["description"]) <= 300
            assert 400 <= len(a["instructions"]) <= 1200, (a["name"], len(a["instructions"]))
            assert len(a["suggestions"]) == 3 and all(0 < len(s) <= 120 for s in a["suggestions"])
            assert a["color"] in drafts.PALETTE and a["perm_edit"] in ("free", "blocked")
            assert "perm_commands" not in a and "engine" not in a
            kept, lowered = drafts.lower_grants(a["name"], checked["grants"])
            assert lowered == [] and kept == a["grants"]
            for group, level in a["grants"].items():
                assert LEVEL_RANK[level] <= LEVEL_RANK[drafts.GRANT_CEILING[group]]
            assert a["grants"].get("memory", "none") == "none"
    assert len(names) == len(set(names)) == 12


def test_no_pack_text_promises_what_does_not_exist():
    for p in packs.PACKS:
        texts = [p["label"], p["summary"], p["detail"]]
        for a in p["agents"]:
            texts += [a["name"], a["role"], a["description"], a["instructions"], *a["suggestions"]]
        for text in texts:
            low = text.lower()
            for bad in FORBIDDEN:
                assert bad not in low, (p["id"], bad)
        for a in p["agents"]:  # the routines: "rotina" is fine, the calendar and finances are not
            for r in a["routines"]:
                low = (r["title"] + " " + r["prompt"]).lower()
                for bad in ROUTINE_FORBIDDEN:
                    assert bad not in low, (p["id"], bad)
    casa = {a["name"]: a for a in next(p for p in packs.PACKS if p["id"] == "casa")["agents"]}
    assert set(casa["Vitor"]["grants"]) <= {"reminders", "notes"}


async def test_team_happy_path_from_a_pack(hsvc, tmp_path):
    team = packs.packs_info()[0]
    async with make_api(hsvc) as c:
        r = await c.post("/agents/team", json={"origin": "pack:dia_em_ordem", "agents": team["agents"]})
    assert r.status_code == 200
    out = r.json()
    assert out["failed"] == [] and out["lowered"] == [] and len(out["created"]) == 2
    for item, src in zip(out["created"], team["agents"]):
        d, home = item["def"], item["home"]
        assert d["name"] == src["name"] and d["origin"] == "pack:dia_em_ordem"
        assert d["perm_commands"] == "ask" and d["grants"]["memory"] == "none"
        assert d["engine"] == "claude_code" and d["provider"] == "anthropic"  # nothing chosen: the fallback
        assert d["suggestions"] == src["suggestions"] and d["description"] == src["description"]
        for group, level in src["grants"].items():
            assert d["grants"][group] == level
        assert home["kind"] == "home" and home["agent_id"] == d["id"] and d["home_project_id"] == home["id"]
        assert Path(home["path"]).parent == (tmp_path / "casas").resolve()


async def test_team_engine_order_draft_then_setup_then_fallback(hsvc):
    # no setup, no engine in the draft -> claude_code/anthropic
    out = await hsvc.create_team("guide", [draft("Um")])
    assert out["created"][0]["def"]["engine"] == "claude_code"
    # the setup's default engine
    await hsvc.update_setup(default_engine={"engine": "fake"})
    out = await hsvc.create_team("guide", [draft("Dois")])
    assert out["created"][0]["def"]["engine"] == "fake"
    # the draft's own engine wins
    out = await hsvc.create_team("guide", [draft("Tres", engine="claude_code", model="m1")])
    d = out["created"][0]["def"]
    assert d["engine"] == "claude_code" and d["model"] == "m1"


async def test_team_duplicate_name_and_repeated_click(hsvc):
    body = [draft("Ana"), draft(" ANA "), draft("Beto")]
    out = await hsvc.create_team("guide", body)
    assert [i["def"]["name"] for i in out["created"]] == ["Ana", "Beto"]
    assert out["failed"] == [{"name": "ANA", "detail": "Já existe um agente com esse nome."}]
    again = await hsvc.create_team("guide", [draft("Ana"), draft("beto")])
    assert again["created"] == [] and len(again["failed"]) == 2
    assert len(await hsvc.list_defs()) == 2  # the click that repeats creates nothing


async def test_team_partial_failure_is_isolated(hsvc):
    out = await hsvc.create_team("guide", [draft("Um"), draft("Dois", engine="motor-que-nao-existe"),
                                          draft("Tres")])
    assert [i["def"]["name"] for i in out["created"]] == ["Um", "Tres"]
    assert [f["name"] for f in out["failed"]] == ["Dois"] and out["failed"][0]["detail"]
    assert [a["name"] for a in await hsvc.list_defs()] == ["Um", "Tres"]
    # a home that cannot be created leaves no half-made agent behind
    import shutil
    blocker = Path(hsvc.home_dir())
    shutil.rmtree(blocker)  # a tmp folder; the parent of the homes becomes a plain file
    blocker.write_text("arquivo")
    out = await hsvc.create_team("guide", [draft("Quatro")])
    assert out["created"] == [] and out["failed"][0]["name"] == "Quatro"
    assert "Quatro" not in [a["name"] for a in await hsvc.list_defs()]
    blocker.unlink()
    out = await hsvc.create_team("guide", [draft("Quatro")])  # a retry is not "already exists"
    assert len(out["created"]) == 1


async def test_team_lowers_grants_and_reports(hsvc):
    asked = {"memory": "read", "wiki": "write", "notes": "write", "reminders": "read"}
    out = await hsvc.create_team("guide", [draft("Ana", grants=asked)])
    d = out["created"][0]["def"]
    assert d["grants"]["memory"] == "none" and d["grants"]["wiki"] == "read"
    assert d["grants"]["notes"] == "write" and d["grants"]["reminders"] == "read"
    assert sorted((x["group"], x["asked"], x["got"]) for x in out["lowered"]) == [
        ("memory", "read", "none"), ("wiki", "write", "read")]
    assert all(x["name"] == "Ana" for x in out["lowered"])


async def test_team_body_validation(hsvc):
    async with make_api(hsvc) as c:
        url = "/agents/team"
        good = draft("Ana")
        cases = [
            {"origin": "outro", "agents": [good]},
            {"origin": "pack:nao_existe", "agents": [good]},
            {"origin": "guide", "agents": []},
            {"origin": "guide", "agents": [good] * 7},
            {"origin": "guide", "agents": [draft("x" * 81)]},
            {"origin": "guide", "agents": [draft("A", description="d" * 301)]},
            {"origin": "guide", "agents": [draft("A", color="verde")]},
            {"origin": "guide", "agents": [draft("A", instructions="")]},
            {"origin": "guide", "agents": [draft("A", suggestions=["a", "b", "c", "d"])]},
            {"origin": "guide", "agents": [draft("A", grants={"inexistente": "read"})]},
            {"origin": "guide", "agents": [draft("A", grants={"notes": "tudo"})]},
            {"origin": "guide", "agents": [{**good, "perm_commands": "ask"}]},  # not a draft field
            {"origin": "guide", "agents": [{**good, "campo": 1}]},
            {"origin": "guide"},
        ]
        for body in cases:
            assert (await c.post(url, json=body)).status_code == 422, body
        assert await hsvc.list_defs() == []
        # every draft failing still answers 200
        await hsvc.create_def(name="Ana", engine="fake")
        r = await c.post(url, json={"origin": "guide", "agents": [good]})
        assert r.status_code == 200 and r.json()["created"] == [] and len(r.json()["failed"]) == 1
