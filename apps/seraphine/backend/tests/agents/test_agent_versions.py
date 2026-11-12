"""Phase 6c: the version history of an agent's text (``/agents/defs/{id}/versions``)."""

from __future__ import annotations

from seraphine.agents import packs

from .chat_helpers import api, make_agent, p_update_agent, propose
from .conftest import draft

VERSION_KEYS = {"version", "name", "role", "description", "instructions", "suggestions", "changed_by", "note",
                "changed_fields", "created_at"}


async def versions(hsvc, agent_id):
    code, out = await api(hsvc, "GET", f"/agents/defs/{agent_id}/versions")
    assert code == 200, out
    return out["versions"]


async def legacy_agent(hsvc, agent_id="antigo"):
    """An agent that existed before the history did: inserted directly, with no version."""
    await hsvc._db(lambda c: c.execute(
        "INSERT INTO agent_defs (id, name, role, instructions, engine, created_at, updated_at)"
        " VALUES (?, 'Velho', 'Papel', 'Texto antigo.', 'fake', 't', 't')", (agent_id,)))
    return agent_id


async def test_creation_records_version_one(hsvc):
    code, out = await api(hsvc, "POST", "/agents/defs", json={
        "name": "Ana", "role": "R", "description": "D", "instructions": "I", "engine": "fake",
        "suggestions": ["a", "b"]})
    assert code == 200 and out["def"]["version"] == 1
    [v] = await versions(hsvc, out["def"]["id"])
    assert set(v) == VERSION_KEYS and v["version"] == 1 and v["changed_by"] == "owner" and v["note"] == "Criado."
    assert (v["name"], v["role"], v["description"], v["instructions"], v["suggestions"]) == (
        "Ana", "R", "D", "I", ["a", "b"])
    assert v["changed_fields"] == ["name", "role", "description", "instructions", "suggestions"]


async def test_each_field_change_makes_a_version_with_changed_fields(hsvc):
    a = await make_agent(hsvc, suggestions=["x"])
    changes = [("name", "Nova Bia"), ("role", "Outro papel"), ("description", "Outra descrição"),
               ("instructions", "Outras instruções."), ("suggestions", ["y", "z"])]
    for i, (field, value) in enumerate(changes, start=2):
        code, out = await api(hsvc, "PATCH", f"/agents/defs/{a['id']}", json={field: value})
        assert code == 200 and out["def"]["version"] == i
        [newest, *_] = await versions(hsvc, a["id"])
        assert newest["version"] == i and newest["changed_fields"] == [field] and newest["changed_by"] == "owner"
        assert newest["note"] == "Mudança feita por você." and newest[field] == value
    await api(hsvc, "PATCH", f"/agents/defs/{a['id']}", json={"role": "Z", "instructions": "Zzz"})
    [newest, *_] = await versions(hsvc, a["id"])
    assert newest["version"] == 7 and newest["changed_fields"] == ["role", "instructions"]
    # each version keeps the whole text as it was
    by_number = {v["version"]: v for v in await versions(hsvc, a["id"])}
    assert by_number[1]["name"] == "Bia" and by_number[2]["name"] == "Nova Bia" and by_number[2]["role"] == "Ajudante"
    assert [v["version"] for v in await versions(hsvc, a["id"])] == [7, 6, 5, 4, 3, 2, 1]


async def test_no_version_when_nothing_changed(hsvc):
    a = await make_agent(hsvc)
    # a change of something else, the same text again, and an empty patch
    for body in ({"color": "#112233"}, {"model": "m"}, {"perm_commands": "blocked"}, {"enabled": False},
                 {"role": "Ajudante"}, {"instructions": a["instructions"]}, {"suggestions": []}, {}):
        assert (await api(hsvc, "PATCH", f"/agents/defs/{a['id']}", json=body))[0] == 200
    assert [v["version"] for v in await versions(hsvc, a["id"])] == [1]
    assert (await hsvc.get_def(a["id"]))["version"] == 1


async def test_whitespace_only_change_is_not_a_change(hsvc):
    a = await make_agent(hsvc, name="Bia")
    await api(hsvc, "PATCH", f"/agents/defs/{a['id']}", json={"name": "  Bia  "})
    assert len(await versions(hsvc, a["id"])) == 1


async def test_lazy_version_one_for_an_agent_that_existed_before(hsvc):
    agent_id = await legacy_agent(hsvc)
    assert (await hsvc.get_def(agent_id))["version"] == 0
    assert (await api(hsvc, "GET", "/agents/defs"))[1]["defs"][0]["version"] == 0
    [v] = await versions(hsvc, agent_id)
    assert v["version"] == 1 and v["note"] == "Como estava quando o histórico começou."
    assert v["changed_fields"] == [] and v["instructions"] == "Texto antigo."
    assert (await hsvc.get_def(agent_id))["version"] == 1
    await versions(hsvc, agent_id)  # reading again adds nothing
    assert len(await versions(hsvc, agent_id)) == 1


async def test_lazy_version_one_on_the_first_change(hsvc):
    agent_id = await legacy_agent(hsvc)
    code, out = await api(hsvc, "PATCH", f"/agents/defs/{agent_id}", json={"instructions": "Texto novo."})
    assert code == 200 and out["def"]["version"] == 2
    one, two = reversed(await versions(hsvc, agent_id))
    assert (one["version"], one["instructions"], one["note"]) == (1, "Texto antigo.", "Como estava quando o histórico começou.")
    assert (two["version"], two["instructions"], two["changed_fields"]) == (2, "Texto novo.", ["instructions"])
    # a patch that changes nothing on another legacy agent leaves no history behind
    other = await legacy_agent(hsvc, "antigo2")
    await api(hsvc, "PATCH", f"/agents/defs/{other}", json={"color": "#112233"})
    assert (await hsvc.get_def(other))["version"] == 0


async def test_restore_makes_a_new_version(hsvc):
    a = await make_agent(hsvc, instructions="Primeiras.", suggestions=["s"])
    await api(hsvc, "PATCH", f"/agents/defs/{a['id']}", json={"instructions": "Segundas.", "role": "Outro",
                                                               "suggestions": ["t"]})
    code, out = await api(hsvc, "POST", f"/agents/defs/{a['id']}/versions/1/restore")
    assert code == 200
    assert out["def"]["instructions"] == "Primeiras." and out["def"]["role"] == "Ajudante"
    assert out["def"]["suggestions"] == ["s"] and out["def"]["version"] == 3
    v = out["version"]
    assert set(v) == VERSION_KEYS and v["version"] == 3 and v["changed_by"] == "restore"
    assert v["note"] == "Voltou para a versão 1." and v["changed_fields"] == ["role", "instructions", "suggestions"]
    assert v["instructions"] == "Primeiras."
    assert len(await versions(hsvc, a["id"])) == 3  # nothing was rewritten: the old ones stay


async def test_restore_current_is_409_and_unknown_is_404(hsvc):
    a = await make_agent(hsvc)
    code, out = await api(hsvc, "POST", f"/agents/defs/{a['id']}/versions/1/restore")
    assert code == 409 and out["code"] == "version_current"
    await api(hsvc, "PATCH", f"/agents/defs/{a['id']}", json={"role": "Outro"})
    assert (await api(hsvc, "POST", f"/agents/defs/{a['id']}/versions/2/restore"))[1]["code"] == "version_current"
    assert (await api(hsvc, "POST", f"/agents/defs/{a['id']}/versions/1/restore"))[0] == 200
    # version 3 is equal to version 1 now: also "current"
    assert (await api(hsvc, "POST", f"/agents/defs/{a['id']}/versions/1/restore"))[1]["code"] == "version_current"
    assert (await api(hsvc, "POST", f"/agents/defs/{a['id']}/versions/99/restore"))[0] == 404
    assert (await api(hsvc, "POST", f"/agents/defs/{a['id']}/versions/0/restore"))[0] == 404
    assert (await api(hsvc, "POST", "/agents/defs/nao-existe/versions/1/restore"))[0] == 404
    assert (await api(hsvc, "GET", "/agents/defs/nao-existe/versions"))[0] == 404


async def test_restore_of_a_legacy_agent_uses_its_lazy_version_one(hsvc):
    agent_id = await legacy_agent(hsvc)
    await api(hsvc, "PATCH", f"/agents/defs/{agent_id}", json={"role": "Mudado"})
    code, out = await api(hsvc, "POST", f"/agents/defs/{agent_id}/versions/1/restore")
    assert code == 200 and out["def"]["role"] == "Papel" and out["version"]["version"] == 3


async def test_versions_are_deleted_with_the_agent(hsvc):
    a = await make_agent(hsvc, "Ana")
    await api(hsvc, "PATCH", f"/agents/defs/{a['id']}", json={"role": "Outro"})
    other = await make_agent(hsvc, "Beto")
    assert (await api(hsvc, "DELETE", f"/agents/defs/{a['id']}"))[0] == 200
    left = await hsvc._db(lambda c: c.execute("SELECT agent_id, COUNT(*) FROM agent_versions GROUP BY agent_id").fetchall())
    assert left == [(other["id"], 1)]
    again = await make_agent(hsvc, "Ana")  # the same id is reused: a fresh history
    assert again["id"] == a["id"] and [v["version"] for v in await versions(hsvc, again["id"])] == [1]


async def test_version_is_on_every_agent_payload(hsvc):
    a = await make_agent(hsvc)
    await api(hsvc, "PATCH", f"/agents/defs/{a['id']}", json={"role": "Outro"})
    assert (await api(hsvc, "GET", f"/agents/defs/{a['id']}"))[1]["def"]["version"] == 2
    assert (await api(hsvc, "GET", "/agents/defs"))[1]["defs"][0]["version"] == 2
    assert (await api(hsvc, "PATCH", f"/agents/defs/{a['id']}", json={"role": "Mais"}))[1]["def"]["version"] == 3


async def test_list_is_newest_first_and_capped_at_fifty(hsvc):
    a = await make_agent(hsvc)
    for i in range(55):
        await hsvc.update_def(a["id"], role=f"Papel {i}")
    listed = await versions(hsvc, a["id"])
    assert len(listed) == 50 and listed[0]["version"] == 56 and listed[-1]["version"] == 7
    assert (await hsvc.get_def(a["id"]))["version"] == 56


async def test_team_creation_records_pack_and_guide(hsvc):
    pack_id = packs.packs_info()[0]["id"]
    out = await hsvc.create_team(f"pack:{pack_id}", [draft("Ana")])
    [v] = await versions(hsvc, out["created"][0]["def"]["id"])
    assert v["changed_by"] == "pack" and v["version"] == 1 and out["created"][0]["def"]["version"] == 1
    out = await hsvc.create_team("guide", [draft("Beto")])
    [v] = await versions(hsvc, out["created"][0]["def"]["id"])
    assert v["changed_by"] == "guide" and v["version"] == 1
    out = await hsvc.create_team("guide", [draft("Beto"), draft("Caio", instructions="Outro texto.")])
    assert [x["def"]["name"] for x in out["created"]] == ["Caio"]  # a refused name leaves no version behind
    rows = await hsvc._db(lambda c: c.execute("SELECT COUNT(*) FROM agent_versions").fetchone())
    assert rows[0] == 3


async def test_guide_proposal_records_guide_and_owner_form_records_owner(hsvc):
    a = await make_agent(hsvc, instructions="Antigas.")
    [p] = await propose(hsvc, p_update_agent(a["id"], instructions="Novas."))
    assert (await api(hsvc, "POST", f"/agents/guide/proposals/{p['id']}/apply"))[0] == 200
    await api(hsvc, "PATCH", f"/agents/defs/{a['id']}", json={"instructions": "Do dono."})
    assert [(v["version"], v["changed_by"]) for v in await versions(hsvc, a["id"])] == [
        (3, "owner"), (2, "guide"), (1, "owner")]
    code, out = await api(hsvc, "POST", f"/agents/defs/{a['id']}/versions/2/restore")
    assert out["version"]["changed_by"] == "restore" and out["def"]["instructions"] == "Novas."
