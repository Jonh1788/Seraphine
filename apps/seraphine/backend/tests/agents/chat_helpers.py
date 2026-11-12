"""Helpers shared by the phase 6c tests (conversation with the guide, proposals, agent history)."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from seraphine.agents import routines

from .conftest import Brain, make_api

DAILY = {"kind": "daily", "time": "08:00"}
NOON = datetime(2026, 11, 12, 15, 0, tzinfo=timezone.utc)


def say(text: str = "Certo.", *proposals: Any) -> str:
    """A brain reply: the JSON the guide asks for."""
    return json.dumps({"say": text, "proposals": list(proposals)}, ensure_ascii=False)


def agent_obj(name: str = "Ana", **over: Any) -> dict[str, Any]:
    base = {"name": name, "role": "Contas", "description": "Lembra das contas.",
            "instructions": "Você lembra o dono das contas da casa.", "suggestions": ["a", "b", "c"],
            "grants": {"reminders": "write"}}
    base.update(over)
    return base


def p_create_agents(*agents: dict[str, Any]) -> dict[str, Any]:
    return {"kind": "create_agents", "agents": list(agents) or [agent_obj()]}


def p_update_agent(agent_id: str, **changes: Any) -> dict[str, Any]:
    return {"kind": "update_agent", "agent_id": agent_id, "changes": changes}


def p_create_routine(agent_id: str, **over: Any) -> dict[str, Any]:
    base = {"kind": "create_routine", "agent_id": agent_id, "title": "Revisão do dia",
            "prompt": "Revise o dia e liste o que ficou pendente.", "schedule": DAILY, "report": "news"}
    base.update(over)
    return base


def p_update_routine(routine_id: str, **changes: Any) -> dict[str, Any]:
    return {"kind": "update_routine", "routine_id": routine_id, "changes": changes}


def fixed_clock(svc: Any, moment: datetime = NOON) -> dict[str, datetime]:
    """Freeze the service clock (and the local time at UTC); returns a dict whose ``now`` can be moved."""
    state = {"now": moment}
    svc.now = lambda: state["now"]
    svc.local_time = routines.FixedOffset(0)
    return state


async def send(svc: Any, reply: str | None, body: str = "oi", about: dict[str, Any] | None = None,
               brain: Brain | None = None) -> tuple[int, dict[str, Any]]:
    """POST a message with a brain that answers ``reply`` (or the given ``brain``)."""
    the_brain = brain or Brain(reply if reply is not None else say())
    svc.llm_getter = lambda: the_brain
    payload: dict[str, Any] = {"body": body}
    if about is not None:
        payload["about"] = about
    async with make_api(svc) as c:
        r = await c.post("/agents/guide/messages", json=payload)
    return r.status_code, r.json()


async def propose(svc: Any, *proposals: dict[str, Any], text: str = "Pronto.") -> list[dict[str, Any]]:
    """Run one conversation turn whose brain proposes ``proposals``; returns the stored proposal objects."""
    code, out = await send(svc, say(text, *proposals))
    assert code == 200, out
    return out["proposals"]


async def api(svc: Any, method: str, url: str, **kw: Any) -> tuple[int, dict[str, Any]]:
    async with make_api(svc) as c:
        r = await c.request(method, url, **kw)
    return r.status_code, r.json()


async def make_agent(svc: Any, name: str = "Bia", **over: Any) -> dict[str, Any]:
    fields: dict[str, Any] = dict(name=name, role="Ajudante", description="Ajuda.",
                                  instructions="Você ajuda o dono com tarefas simples.", engine="fake")
    fields.update(over)
    return await svc.create_def(**fields)
