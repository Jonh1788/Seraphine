"""Phase 6c: proposal cards (normalising what the model wrote, applying, dismissing) with a fake brain."""

from __future__ import annotations

import json
from datetime import timedelta

from seraphine.agents import guide_proposals as gp

from .chat_helpers import (
    DAILY, agent_obj, api, fixed_clock, make_agent, p_create_agents, p_create_routine, p_update_agent,
    p_update_routine, propose, say, send,
)

APPLY = "/agents/guide/proposals/{}/apply"
DISMISS = "/agents/guide/proposals/{}/dismiss"


async def apply(hsvc, proposal):
    return await api(hsvc, "POST", APPLY.format(proposal["id"]))


# -- normalising the model's reply --------------------------------------------------------------------------------


async def test_update_agent_card_has_title_before_target_and_clipped_text(hsvc):
    a = await make_agent(hsvc, instructions="Antigas.", role="Antigo")
    [p] = await propose(hsvc, p_update_agent(a["id"], instructions="Novas instruções.", role="R" * 500,
                                             description="", name="  ", suggestions=["x", "x", "y", "z", "w"]))
    assert p["kind"] == "update_agent" and p["status"] == "pending"
    assert p["title"] == "Mudar o papel, as instruções e as sugestões de Bia"
    assert p["payload"]["agent_id"] == a["id"]
    assert p["payload"]["changes"] == {"role": "R" * 200, "instructions": "Novas instruções.",
                                       "suggestions": ["x", "y", "z"]}  # empty fields dropped, the rest cut
    assert p["before"] == {"role": "Antigo", "instructions": "Antigas.", "suggestions": []}
    assert p["target"] == {"agent_id": a["id"]} and p["decided_at"] is None and p["expires_at"] > p["created_at"]


async def test_update_agent_single_field_title_and_no_ops_dropped(hsvc):
    a = await make_agent(hsvc)
    [p] = await propose(hsvc, p_update_agent(a["id"], instructions="Outras.", role=a["role"]))
    assert p["title"] == "Mudar as instruções de Bia" and list(p["payload"]["changes"]) == ["instructions"]
    # a change equal to what is there is nothing: the proposal is dropped
    assert await propose(hsvc, p_update_agent(a["id"], role="Ajudante")) == []


async def test_forbidden_fields_are_dropped_when_normalising(hsvc):
    a = await make_agent(hsvc)
    evil = p_update_agent(a["id"], role="Nova", engine="codex", provider="openai", model="x", enabled=False,
                          perm_commands="blocked", perm_edit="blocked", grants={"notes": "write"},
                          daily_budget_usd=0, project_ids=[], delete=True)
    evil["engine"] = "codex"  # also outside "changes"
    [p] = await propose(hsvc, evil)
    assert p["payload"] == {"agent_id": a["id"], "changes": {"role": "Nova"}}
    # only forbidden fields: nothing is left, so the proposal does not exist
    code, out = await send(hsvc, say("Feito.", p_update_agent(a["id"], engine="codex", enabled=False)))
    assert out["proposals"] == [] and out["reply"]["body"].endswith(gp.NOT_BUILT_SENTENCE)
    routine = await hsvc.create_routine(agent_id=a["id"], title="R", prompt="p", schedule=DAILY)
    [q] = await propose(hsvc, p_update_routine(routine["id"], enabled=False, agent_id="x", project_id="y",
                                               next_run_at="z", origin="manual"))
    assert q["payload"]["changes"] == {"enabled": False}
    # a new draft cannot choose engine, provider, model or commands, and its grants are lowered
    [c] = await propose(hsvc, p_create_agents(agent_obj("Caio", engine="codex", provider="openai", model="m",
                                                        perm_commands="blocked",
                                                        grants={"memory": "write", "notes": "write", "wiki": "write"})))
    draft = c["payload"]["agents"][0]
    assert not ({"engine", "provider", "model", "perm_commands"} & set(draft))
    assert draft["grants"] == {"memory": "none", "notes": "write", "wiki": "read"}


async def test_unknown_ids_drop_only_that_proposal(hsvc):
    a = await make_agent(hsvc)
    routine = await hsvc.create_routine(agent_id=a["id"], title="R", prompt="p", schedule=DAILY)
    code, out = await send(hsvc, say(
        "Vários.", p_update_agent("nao-existe", role="x"), p_create_routine("nao-existe"),
        p_update_routine("nao-existe", enabled=False), p_update_agent(a["id"], role="Nova"),
        {"kind": "delete_agent", "agent_id": a["id"]}, {"kind": "update_agent"}, "texto", None,
        p_update_routine(routine["id"], enabled=False)))
    assert code == 200
    assert [p["kind"] for p in out["proposals"]] == ["update_agent", "update_routine"]
    assert out["reply"]["body"] == "Vários."  # something survived: no appended sentence


async def test_nothing_survives_appends_the_sentence_and_nothing_tried_does_not(hsvc):
    code, out = await send(hsvc, say("Vou propor.", p_update_agent("nao-existe", role="x")))
    assert code == 200 and out["proposals"] == []
    assert out["reply"]["body"] == "Vou propor. " + gp.NOT_BUILT_SENTENCE == "Vou propor. Não consegui montar a proposta. Pode descrever de outro jeito?"
    code, out = await send(hsvc, say("Só conversa."))
    assert out["reply"]["body"] == "Só conversa."
    # a say that is too long is cut so that the sentence still fits in the limit
    code, out = await send(hsvc, say("s" * 3000, {"kind": "create_agents", "agents": [{"name": "sem instruções"}]}))
    body = out["reply"]["body"]
    assert len(body) <= gp.SAY_MAX and body.endswith(gp.NOT_BUILT_SENTENCE)


async def test_at_most_four_proposals_and_say_is_cut(hsvc):
    agents = [await make_agent(hsvc, name=f"Ag{i}") for i in range(6)]
    code, out = await send(hsvc, say("d" * 2000, *[p_update_agent(a["id"], role="Novo") for a in agents]))
    assert len(out["proposals"]) == 4
    assert [p["target"]["agent_id"] for p in out["proposals"]] == [a["id"] for a in agents[:4]]
    assert len(out["reply"]["body"]) == 1200


async def test_same_target_and_kind_twice_in_one_reply_keeps_the_first(hsvc):
    a = await make_agent(hsvc)
    out = await propose(hsvc, p_update_agent(a["id"], role="Um"), p_update_agent(a["id"], role="Dois"),
                        p_create_routine(a["id"], title="A"), p_create_routine(a["id"], title="B"))
    assert [p["payload"].get("changes", {}).get("role") or p["payload"]["title"] for p in out] == ["Um", "A", "B"]


async def test_create_agents_card(hsvc):
    await make_agent(hsvc, "Existente")
    many = [agent_obj(f"N{i}") for i in range(7)]
    many[1]["routines"] = [{"title": "Diária", "prompt": "Faça.", "schedule": DAILY},
                           {"title": "Ruim", "prompt": "Faça.", "schedule": {"kind": "daily", "time": "99:00"}}]
    [p] = await propose(hsvc, p_create_agents(*many))
    assert p["kind"] == "create_agents" and p["before"] is None and p["target"] == {}
    assert p["title"] == "Criar 5 agentes" and len(p["payload"]["agents"]) == 5
    routines = p["payload"]["agents"][1]["routines"]
    assert [r["title"] for r in routines] == ["Diária"] and routines[0]["schedule_text"] == "Todo dia às 08:00"
    [one] = await propose(hsvc, p_create_agents(agent_obj("Só")))
    assert one["title"] == "Criar o agente Só"


async def test_create_routine_card_and_invalid_routines_dropped(hsvc):
    a = await make_agent(hsvc, "Lia")
    [p] = await propose(hsvc, p_create_routine(a["id"], report="xyz", prompt="q" * 5000, title="T" * 300))
    assert p["title"].startswith("Nova rotina de Lia: ") and p["before"] is None
    assert p["target"] == {"agent_id": a["id"]}
    assert p["payload"]["report"] == "news" and len(p["payload"]["prompt"]) == 2000 and len(p["payload"]["title"]) == 120
    assert p["payload"]["schedule"] == DAILY and p["payload"]["schedule_text"] == "Todo dia às 08:00"
    for bad in ({"kind": "daily", "time": "25:00"}, {"kind": "interval", "every_minutes": 1}, "toda hora", None,
                {"kind": "once", "at": "2001-01-01T10:00"}):
        assert await propose(hsvc, p_create_routine(a["id"], schedule=bad)) == []


async def test_update_routine_card_before_and_titles(hsvc):
    a = await make_agent(hsvc, "Lia")
    r = await hsvc.create_routine(agent_id=a["id"], title="Revisão", prompt="Revise.", schedule=DAILY)
    [p] = await propose(hsvc, p_update_routine(r["id"], schedule={"kind": "weekdays", "time": "07:00", "lixo": 1},
                                               title="Revisão da manhã", report="always", prompt="Revise."))
    assert p["title"] == "Mudar o título, o horário e o relato da rotina «Revisão»"
    assert p["payload"]["changes"] == {"title": "Revisão da manhã", "report": "always",
                                       "schedule": {"kind": "weekdays", "time": "07:00"}}
    assert p["payload"]["schedule_text"] == "Todo dia útil às 07:00"
    assert p["before"] == {"title": "Revisão", "report": "news", "schedule": DAILY,
                           "schedule_text": "Todo dia às 08:00"}
    assert p["target"] == {"routine_id": r["id"]}
    [pause] = await propose(hsvc, p_update_routine(r["id"], enabled=False))
    assert pause["title"] == "Pausar a rotina «Revisão»" and pause["before"] == {"enabled": True}
    both = (await propose(hsvc, p_update_routine(r["id"], enabled=False, title="Nova")))[0]
    assert both["title"] == "Mudar o título e pausar da rotina «Revisão»"
    assert await propose(hsvc, p_update_routine(r["id"], enabled=True, schedule={"kind": "weekly"})) == []


async def test_resume_title(hsvc):
    a = await make_agent(hsvc)
    r = await hsvc.create_routine(agent_id=a["id"], title="Rot", prompt="p", schedule=DAILY, enabled=False)
    [p] = await propose(hsvc, p_update_routine(r["id"], enabled=True))
    assert p["title"] == "Retomar a rotina «Rot»"


async def test_nested_payload_is_accepted(hsvc):
    a = await make_agent(hsvc)
    [p] = await propose(hsvc, {"kind": "update_agent", "payload": {"agent_id": a["id"], "changes": {"role": "Z"}}})
    assert p["payload"]["changes"] == {"role": "Z"}


# -- applying ---------------------------------------------------------------------------------------------------


async def test_apply_create_agents(hsvc):
    hsvc.guide_history = 12
    [p] = await propose(hsvc, p_create_agents(
        agent_obj("Ana", grants={"memory": "write", "wiki": "write", "notes": "write"},
                  routines=[{"title": "Diária", "prompt": "Faça.", "schedule": DAILY}]),
        agent_obj("Beto")))
    code, out = await apply(hsvc, p)
    assert code == 200 and out["proposal"]["status"] == "applied" and out["routines"][0]["origin"] == "guide"
    assert [a["name"] for a in out["agents"]] == ["Ana", "Beto"] and out["agents"][0]["origin"] == "guide"
    ana = out["agents"][0]
    assert ana["perm_commands"] == "ask" and ana["version"] == 1
    assert (await hsvc.get_grants(ana["id"]))["memory"] == "none" and (await hsvc.get_grants(ana["id"]))["wiki"] == "read"
    res = out["proposal"]["result"]
    assert res["agent_ids"] == [a["id"] for a in out["agents"]] and res["routine_ids"] == [out["routines"][0]["id"]]
    assert "failed" not in res and out["proposal"]["decided_at"]
    assert (await hsvc.list_versions(ana["id"]))[0]["changed_by"] == "guide"


async def test_apply_create_agents_partial_failure_and_total_failure(hsvc):
    await make_agent(hsvc, "Ana")
    [p] = await propose(hsvc, p_create_agents(agent_obj("Ana"), agent_obj("Beto")))
    code, out = await apply(hsvc, p)
    assert code == 200 and out["proposal"]["status"] == "applied"
    assert [a["name"] for a in out["agents"]] == ["Beto"]
    assert out["proposal"]["result"]["failed"] == [{"name": "Ana", "detail": "Já existe um agente com esse nome."}]
    [q] = await propose(hsvc, p_create_agents(agent_obj("Ana")))
    code, out = await apply(hsvc, q)
    assert code == 200 and out["proposal"]["status"] == "failed" and out["agents"] == []
    assert "Já existe" in out["proposal"]["detail"] and out["proposal"]["result"]["failed"][0]["name"] == "Ana"
    assert (await apply(hsvc, q))[0] == 409  # a failed proposal is decided


async def test_apply_update_agent_records_a_guide_version(hsvc):
    a = await make_agent(hsvc, instructions="Antigas.")
    [p] = await propose(hsvc, p_update_agent(a["id"], instructions="Novas, mais diretas.", role="Direta"))
    code, out = await apply(hsvc, p)
    assert code == 200 and out["proposal"]["status"] == "applied" and out["routines"] == []
    assert out["agents"][0]["instructions"] == "Novas, mais diretas." and out["agents"][0]["role"] == "Direta"
    assert out["agents"][0]["version"] == 2  # 1 = created, 2 = this change
    versions = await hsvc.list_versions(a["id"])
    assert versions[0]["changed_by"] == "guide" and versions[0]["note"] == "Mudança pedida na conversa com a Seraphine."
    assert versions[0]["changed_fields"] == ["role", "instructions"]
    assert out["proposal"]["result"] == {"agent_ids": [a["id"]]}
    # nothing else of the agent moved
    now = await hsvc.get_def(a["id"])
    assert (now["engine"], now["perm_commands"], now["perm_edit"], now["enabled"], now["daily_budget_usd"]) == (
        a["engine"], a["perm_commands"], a["perm_edit"], a["enabled"], a["daily_budget_usd"])


async def test_apply_create_routine(hsvc):
    a = await make_agent(hsvc, "Lia")
    [p] = await propose(hsvc, p_create_routine(a["id"]))
    code, out = await apply(hsvc, p)
    assert code == 200 and out["agents"] == [] and out["proposal"]["status"] == "applied"
    [r] = out["routines"]
    assert r["agent_id"] == a["id"] and r["origin"] == "guide" and r["enabled"] is True and r["title"] == "Revisão do dia"
    assert out["proposal"]["result"] == {"routine_ids": [r["id"]]}
    assert [x["id"] for x in await hsvc.list_routines()] == [r["id"]]


async def test_apply_update_routine_changes_and_pauses(hsvc):
    a = await make_agent(hsvc, "Lia")
    r = await hsvc.create_routine(agent_id=a["id"], title="Revisão", prompt="Revise.", schedule=DAILY)
    [p] = await propose(hsvc, p_update_routine(r["id"], schedule={"kind": "daily", "time": "07:00"}, title="Cedo"))
    code, out = await apply(hsvc, p)
    assert code == 200 and out["agents"] == []
    assert out["routines"][0]["title"] == "Cedo" and out["routines"][0]["schedule"]["time"] == "07:00"
    [q] = await propose(hsvc, p_update_routine(r["id"], enabled=False))
    code, out = await apply(hsvc, q)
    assert code == 200 and out["routines"][0]["enabled"] is False and out["routines"][0]["next_run_at"] is None
    assert out["proposal"]["result"] == {"routine_ids": [r["id"]]}
    [back] = await propose(hsvc, p_update_routine(r["id"], enabled=True))
    assert (await apply(hsvc, back))[1]["routines"][0]["enabled"] is True


async def test_double_apply_is_409_not_pending_and_dismiss(hsvc):
    a = await make_agent(hsvc)
    [p] = await propose(hsvc, p_update_agent(a["id"], role="Nova"))
    assert (await apply(hsvc, p))[0] == 200
    code, out = await apply(hsvc, p)
    assert code == 409 and out["code"] == "proposal_not_pending"
    code, out = await api(hsvc, "POST", DISMISS.format(p["id"]))
    assert code == 409 and out["code"] == "proposal_not_pending"
    [q] = await propose(hsvc, p_update_agent(a["id"], role="Outra"))
    code, out = await api(hsvc, "POST", DISMISS.format(q["id"]))
    assert code == 200 and out["proposal"]["status"] == "dismissed" and out["proposal"]["decided_at"]
    assert (await hsvc.get_def(a["id"]))["role"] == "Nova"  # dismissing changes nothing
    assert (await apply(hsvc, q))[1]["code"] == "proposal_not_pending"
    assert (await api(hsvc, "POST", DISMISS.format(q["id"])))[0] == 409
    for url in (APPLY, DISMISS):
        assert (await api(hsvc, "POST", url.format("nao-existe")))[0] == 404


async def test_stale_when_the_target_changed_or_vanished(hsvc):
    a = await make_agent(hsvc)
    [p] = await propose(hsvc, p_update_agent(a["id"], role="Nova"))
    await hsvc.update_def(a["id"], instructions="O dono mudou antes.")
    code, out = await apply(hsvc, p)
    assert code == 409 and out["code"] == "proposal_stale" and out["detail"]
    got = await hsvc.get_proposal(p["id"])
    assert got["status"] == "stale" and got["detail"] == out["detail"] and got["decided_at"]
    assert (await hsvc.get_def(a["id"]))["role"] == "Ajudante"
    assert (await apply(hsvc, p))[1]["code"] == "proposal_not_pending"
    # changing what a proposal does not talk about does not make it stale
    [q] = await propose(hsvc, p_update_agent(a["id"], role="Outra"))
    await hsvc.update_def(a["id"], model="outro", perm_commands="blocked", color="#112233")
    assert (await apply(hsvc, q))[0] == 200
    # vanished agent, vanished routine, changed routine
    [gone] = await propose(hsvc, p_update_agent(a["id"], role="Terceira"))
    r = await hsvc.create_routine(agent_id=a["id"], title="R", prompt="p", schedule=DAILY)
    [rp] = await propose(hsvc, p_update_routine(r["id"], enabled=False))
    [cp] = await propose(hsvc, p_create_routine(a["id"]))
    await hsvc.update_routine(r["id"], title="Mudou")
    assert (await apply(hsvc, rp))[1]["code"] == "proposal_stale"
    await hsvc.delete_def(a["id"])
    for item in (gone, cp):
        code, out = await apply(hsvc, item)
        assert code == 409 and out["code"] == "proposal_stale"
        assert (await hsvc.get_proposal(item["id"]))["status"] == "stale"
    b = await make_agent(hsvc, "Outro")
    r2 = await hsvc.create_routine(agent_id=b["id"], title="R2", prompt="p", schedule=DAILY)
    [vp] = await propose(hsvc, p_update_routine(r2["id"], enabled=False))
    await hsvc.delete_routine(r2["id"])
    assert (await apply(hsvc, vp))[1]["code"] == "proposal_stale"


async def test_expiry_on_read_and_apply(hsvc):
    clock = fixed_clock(hsvc)
    a = await make_agent(hsvc)
    [p] = await propose(hsvc, p_update_agent(a["id"], role="Nova"))
    assert p["expires_at"] == (clock["now"] + timedelta(seconds=86400)).isoformat(timespec="microseconds")
    clock["now"] += timedelta(hours=23)
    assert (await hsvc.get_proposal(p["id"]))["status"] == "pending"
    clock["now"] += timedelta(hours=2)
    _, listed = await api(hsvc, "GET", "/agents/guide/messages")
    assert listed["proposals"][0]["status"] == "expired" and listed["proposals"][0]["detail"]
    code, out = await apply(hsvc, p)
    assert code == 409 and out["code"] == "proposal_not_pending"
    assert (await hsvc.get_def(a["id"]))["role"] == "Ajudante"


async def test_expiry_found_by_apply_without_a_read(hsvc):
    clock = fixed_clock(hsvc)
    hsvc.proposal_ttl_s = 60
    a = await make_agent(hsvc)
    [p] = await propose(hsvc, p_update_agent(a["id"], role="Nova"))
    clock["now"] += timedelta(seconds=61)
    assert (await apply(hsvc, p))[1]["code"] == "proposal_not_pending"
    assert (await hsvc.get_proposal(p["id"]))["status"] == "expired"


async def test_a_newer_proposal_replaces_the_pending_one_for_the_same_target_and_kind(hsvc):
    a = await make_agent(hsvc, "Ana")
    b = await make_agent(hsvc, "Bia")
    [first] = await propose(hsvc, p_update_agent(a["id"], role="Um"))
    [other_agent] = await propose(hsvc, p_update_agent(b["id"], role="Outro"))
    [routine_first] = await propose(hsvc, p_create_routine(a["id"]))
    [second] = await propose(hsvc, p_update_agent(a["id"], role="Dois"))
    got = {p["id"]: p for p in (await api(hsvc, "GET", "/agents/guide/messages"))[1]["proposals"]}
    assert got[first["id"]]["status"] == "dismissed"
    assert got[first["id"]]["detail"] == "substituída por uma proposta mais nova"
    assert got[other_agent["id"]]["status"] == "pending" and got[routine_first["id"]]["status"] == "pending"
    assert got[second["id"]]["status"] == "pending"
    [routine_second] = await propose(hsvc, p_create_routine(a["id"], title="Outra"))
    assert (await hsvc.get_proposal(routine_first["id"]))["status"] == "dismissed"
    assert (await apply(hsvc, first))[1]["code"] == "proposal_not_pending"
    # an applied proposal is not touched by a later one
    assert (await apply(hsvc, second))[0] == 200
    await propose(hsvc, p_update_agent(a["id"], role="Três"))
    assert (await hsvc.get_proposal(second["id"]))["status"] == "applied"
    assert routine_second["status"] == "pending"


async def test_routine_limit_makes_the_proposal_failed(hsvc):
    hsvc.routine_max_active = 1
    a = await make_agent(hsvc, "Lia")
    await hsvc.create_routine(agent_id=a["id"], title="Uma", prompt="p", schedule=DAILY)
    [p] = await propose(hsvc, p_create_routine(a["id"]))
    code, out = await apply(hsvc, p)
    assert code == 409 and out["code"] == "routine_limit"
    got = await hsvc.get_proposal(p["id"])
    assert got["status"] == "failed" and "rotinas ativas" in got["detail"]
    r = await hsvc.create_routine(agent_id=a["id"], title="Pausada", prompt="p", schedule=DAILY, enabled=False)
    [q] = await propose(hsvc, p_update_routine(r["id"], enabled=True))
    code, out = await apply(hsvc, q)
    assert code == 409 and out["code"] == "routine_limit" and (await hsvc.get_proposal(q["id"]))["status"] == "failed"


async def test_a_validation_error_on_apply_makes_it_failed_422(hsvc):
    clock = fixed_clock(hsvc)
    hsvc.proposal_ttl_s = 10 * 86400
    a = await make_agent(hsvc, "Lia")
    [p] = await propose(hsvc, p_create_routine(a["id"], schedule={"kind": "once", "at": "2026-11-13T10:00"}))
    assert p["payload"]["schedule"] == {"kind": "once", "at": "2026-11-13T10:00"}
    clock["now"] += timedelta(days=2)  # the time has passed when the owner clicks
    code, out = await apply(hsvc, p)
    assert code == 422 and out["code"] == "invalid" and "passou" in out["detail"]
    got = await hsvc.get_proposal(p["id"])
    assert got["status"] == "failed" and "passou" in got["detail"] and await hsvc.list_routines() == []


async def test_a_stored_payload_with_forbidden_fields_is_refused_on_apply(hsvc):
    a = await make_agent(hsvc, "Ana")
    r = await hsvc.create_routine(agent_id=a["id"], title="R", prompt="p", schedule=DAILY)
    [good] = await propose(hsvc, p_update_agent(a["id"], role="Nova"))
    fp = "x"

    async def plant(kind, payload, target, fingerprint=None):
        pid = f"planted-{kind}-{len(json.dumps(payload))}"
        await hsvc._db(lambda c: c.execute(
            "INSERT INTO agent_guide_proposals (id, kind, status, title, payload, target, fingerprint, created_at,"
            " expires_at) VALUES (?, ?, 'pending', 't', ?, ?, ?, ?, ?)",
            (pid, kind, json.dumps(payload), json.dumps(target), fingerprint, "2026-01-01", "2999-01-01")))
        return pid

    plants = [
        ("update_agent", {"agent_id": a["id"], "changes": {"role": "x", "engine": "codex"}}, {"agent_id": a["id"]}),
        ("update_agent", {"agent_id": a["id"], "changes": {"enabled": False}}, {"agent_id": a["id"]}),
        ("update_agent", {"agent_id": a["id"], "changes": {"perm_commands": "blocked"}}, {"agent_id": a["id"]}),
        ("update_agent", {"agent_id": a["id"], "changes": {"role": 5}}, {"agent_id": a["id"]}),
        ("update_agent", {"agent_id": a["id"], "changes": {}}, {"agent_id": a["id"]}),
        ("update_agent", {"agent_id": a["id"], "changes": {"role": "x"}}, {"agent_id": "outro"}),
        ("update_routine", {"routine_id": r["id"], "changes": {"agent_id": "z"}}, {"routine_id": r["id"]}),
        ("update_routine", {"routine_id": r["id"], "changes": {"enabled": "sim"}}, {"routine_id": r["id"]}),
        ("create_routine", {"agent_id": a["id"], "title": "t", "prompt": "p", "schedule": DAILY, "enabled": False},
         {"agent_id": a["id"]}),
        ("create_agents", {"agents": [agent_obj("Zed", engine="codex")]}, {}),
        ("create_agents", {"agents": [agent_obj("Zed", perm_commands="blocked")]}, {}),
        ("create_agents", {"agents": [agent_obj("Zed", routines=[{"title": "t", "prompt": "p", "schedule": DAILY,
                                                                  "enabled": False}])]}, {}),
        ("create_agents", {"agents": []}, {}),
        ("delete_agent", {"agent_id": a["id"]}, {}),
    ]
    for kind, payload, target in plants:
        # the fingerprint of the real target so that the refusal is about the content, not about staleness
        fingerprint = gp.agent_fingerprint_text(a) if kind == "update_agent" else (
            gp.routine_fingerprint(r) if kind == "update_routine" else None)
        pid = await plant(kind, payload, target, fingerprint)
        code, out = await api(hsvc, "POST", APPLY.format(pid))
        assert code == 422, (kind, payload, out)
        assert (await hsvc.get_proposal(pid))["status"] == "failed"
    now = await hsvc.get_def(a["id"])
    assert (now["role"], now["enabled"], now["perm_commands"], now["engine"]) == ("Ajudante", True, "ask", "fake")
    assert [x["name"] for x in await hsvc.list_defs()] == ["Ana"] and len(await hsvc.list_routines()) == 1
    assert (await hsvc.get_proposal(good["id"]))["status"] == "pending" and fp


async def test_apply_runs_while_the_guide_is_busy_without_touching_it(hsvc):
    """Applying and dismissing never call the brain, so they work while a conversation is running."""
    a = await make_agent(hsvc)
    [p] = await propose(hsvc, p_update_agent(a["id"], role="Nova"))
    hsvc.guide._busy = True
    try:
        assert (await apply(hsvc, p))[0] == 200
    finally:
        hsvc.guide._busy = False
