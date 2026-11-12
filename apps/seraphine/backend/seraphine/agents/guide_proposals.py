"""Proposal cards of the conversation with the guide (phase 6c): pure functions, no database, no clock.

The model's reply is DATA. ``normalize_reply`` turns it into proposals the owner can apply, field by field and
leniently (text is cut, an invalid proposal is dropped, an id that does not exist invalidates only that
proposal). A proposal can only ever carry the fields of rule 2 of the contract: the text of an agent, new
agents (through the 6a draft rules), a new routine, and a routine's title, request, schedule, report and
``enabled``. Anything else (engine, provider, model, permissions, grants of an existing agent, budget,
projects, an agent's ``enabled``, deleting) is dropped here and REFUSED by the ``check_*`` functions when a
stored proposal is applied, in case a payload somehow carried it.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime
from typing import Any

from seraphine.agents import routines as routines_mod
from seraphine.agents.agent_versions import VERSION_FIELDS, text_state
from seraphine.agents.drafts import (
    DESCRIPTION_MAX, INSTRUCTIONS_MAX, NAME_MAX, PROPOSAL_MAX_AGENTS, ROLE_MAX, SUGGESTION_MAX, SUGGESTIONS_MAX,
    normalize_draft,
)
from seraphine.agents.errors import Invalid

KINDS = ("create_agents", "update_agent", "create_routine", "update_routine")
STATUSES = ("pending", "applied", "dismissed", "expired", "stale", "failed")
#: Most proposals one reply may carry, and the longest ``say``.
MAX_PROPOSALS = 4
SAY_MAX = 1200
NOT_BUILT_SENTENCE = "Não consegui montar a proposta. Pode descrever de outro jeito?"
DEFAULT_SAY = "Pronto."

AGENT_CHANGE_FIELDS = VERSION_FIELDS  # name, role, description, instructions, suggestions
ROUTINE_CHANGE_FIELDS = ("title", "prompt", "schedule", "report", "enabled")
#: What a stored ``create_agents`` draft may carry (``engine``, ``provider``, ``model`` and the like are refused).
DRAFT_ALLOWED = ("name", "role", "description", "instructions", "suggestions", "color", "perm_edit", "grants",
                 "routines")
ROUTINE_DRAFT_ALLOWED = ("title", "prompt", "schedule", "report", "schedule_text")
CREATE_ROUTINE_ALLOWED = ("agent_id", "title", "prompt", "schedule", "report", "schedule_text")
FORBIDDEN_TEXT = "Esta proposta traz um campo que a Seraphine não pode mudar: {field}."

AGENT_LABELS = {"name": "o nome", "role": "o papel", "description": "a descrição",
                "instructions": "as instruções", "suggestions": "as sugestões"}
ROUTINE_LABELS = {"title": "o título", "prompt": "o pedido", "schedule": "o horário", "report": "o relato"}


def _clip(value: Any, limit: int) -> str:
    return str(value if value is not None else "").strip()[:limit].strip()


def _join(items: list[str]) -> str:
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " e " + items[-1]


def _digest(parts: list[Any]) -> str:
    return hashlib.sha256(json.dumps(parts, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()


# -- fingerprints --------------------------------------------------------------------------------------


def agent_fingerprint_text(agent: dict[str, Any]) -> str:
    """The state of an agent a proposal talks about: its five text fields (engine, access and the rest do
    not matter to a proposal, so changing them does not make it stale)."""
    state = text_state(agent)
    return _digest([state[f] for f in VERSION_FIELDS])


def routine_fingerprint(routine: dict[str, Any]) -> str:
    """The state of a routine a proposal talks about: what a proposal may change (its run history does not count)."""
    return _digest([routine.get("title"), routine.get("prompt"), routine.get("schedule"), routine.get("report"),
                    bool(routine.get("enabled"))])


# -- titles ---------------------------------------------------------------------------------------------


def title_create_agents(agents: list[dict[str, Any]]) -> str:
    if len(agents) == 1:
        return f"Criar o agente {agents[0]['name']}"
    return f"Criar {len(agents)} agentes"


def title_update_agent(agent_name: str, fields: list[str]) -> str:
    labels = [AGENT_LABELS[f] for f in AGENT_CHANGE_FIELDS if f in fields]
    return f"Mudar {_join(labels)} de {agent_name}"


def title_create_routine(agent_name: str, title: str) -> str:
    return f"Nova rotina de {agent_name}: {title}"


def title_update_routine(routine_title: str, fields: list[str], enabled: bool | None) -> str:
    labels = [ROUTINE_LABELS[f] for f in ("title", "prompt", "schedule", "report") if f in fields]
    if not labels:
        return f"{'Retomar' if enabled else 'Pausar'} a rotina «{routine_title}»"
    text = f"Mudar {_join(labels)}"
    if enabled is not None:
        text += f" e {'retomar' if enabled else 'pausar'}"
    return f"{text} da rotina «{routine_title}»"


# -- changes: lenient (model) ----------------------------------------------------------------------------


def clean_agent_changes(raw: Any, current: dict[str, Any]) -> dict[str, Any]:
    """The changes to an agent's text a model asked for: only the five fields, cut to the 6a limits, empty
    values and values equal to the current ones dropped."""
    out: dict[str, Any] = {}
    if not isinstance(raw, dict):
        return out
    now = text_state(current)
    for field, limit in (("name", NAME_MAX), ("role", ROLE_MAX), ("description", DESCRIPTION_MAX),
                         ("instructions", INSTRUCTIONS_MAX)):
        value = raw.get(field)
        if isinstance(value, str):
            text = _clip(value, limit)
            if text and text != now[field]:
                out[field] = text
    sug = raw.get("suggestions")
    if isinstance(sug, list):
        items: list[str] = []
        for item in sug:
            text = _clip(item, SUGGESTION_MAX) if isinstance(item, str) else ""
            if text and text not in items:
                items.append(text)
            if len(items) == SUGGESTIONS_MAX:
                break
        if items and items != now["suggestions"]:
            out["suggestions"] = items
    return out


def _schedule_fields(raw: Any) -> Any:
    if isinstance(raw, dict) and raw.get("kind") in routines_mod.KIND_FIELDS:
        keep = {"kind", *routines_mod.KIND_FIELDS[raw["kind"]]}
        return {k: v for k, v in raw.items() if k in keep}
    return raw


def clean_routine_changes(raw: Any, current: dict[str, Any], *, now_local: datetime | None,
                          min_interval: int) -> dict[str, Any]:
    """The changes to a routine a model asked for: title, request, schedule, report and ``enabled``; anything
    invalid (a schedule that does not validate, a bad report) or equal to the current value is dropped."""
    out: dict[str, Any] = {}
    if not isinstance(raw, dict):
        return out
    for field, limit in (("title", routines_mod.TITLE_MAX), ("prompt", routines_mod.PROMPT_MAX)):
        value = raw.get(field)
        if isinstance(value, str):
            text = _clip(value, limit)
            if text and text != current.get(field):
                out[field] = text
    if raw.get("report") in routines_mod.REPORTS and raw["report"] != current.get("report"):
        out["report"] = raw["report"]
    if isinstance(raw.get("enabled"), bool) and raw["enabled"] != bool(current.get("enabled")):
        out["enabled"] = raw["enabled"]
    if "schedule" in raw:
        try:
            schedule = routines_mod.check_schedule(_schedule_fields(raw["schedule"]), now_local=now_local,
                                                   min_interval=min_interval)
        except Invalid:
            schedule = None
        if schedule is not None and schedule != current.get("schedule"):
            out["schedule"] = schedule
    return out


# -- the reply: lenient ------------------------------------------------------------------------------------


def _payload_source(raw: dict[str, Any]) -> dict[str, Any]:
    """The fields of a proposal: flat, or nested under ``payload`` (both are accepted)."""
    nested = raw.get("payload")
    return nested if isinstance(nested, dict) else raw


def _proposal(kind: str, payload: dict[str, Any], title: str, before: dict[str, Any] | None,
              target: dict[str, str], fingerprint: str | None) -> dict[str, Any]:
    return {"kind": kind, "payload": payload, "title": title, "before": before, "target": target,
            "fingerprint": fingerprint}


def _one_proposal(raw: Any, agents: dict[str, dict[str, Any]], routines: dict[str, dict[str, Any]],
                  now_local: datetime | None, min_interval: int) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    kind = raw.get("kind")
    src = _payload_source(raw)
    if kind == "create_agents":
        drafts: list[dict[str, Any]] = []
        names: set[str] = set()
        items = src.get("agents")
        for i, item in enumerate(items if isinstance(items, list) else []):
            d = normalize_draft(item, len(drafts), now_local=now_local, min_interval=min_interval)
            if d is None or d["name"].casefold() in names:
                continue
            names.add(d["name"].casefold())
            drafts.append(d)
            if len(drafts) == PROPOSAL_MAX_AGENTS:
                break
        if not drafts:
            return None
        return _proposal(kind, {"agents": drafts}, title_create_agents(drafts), None, {}, None)
    if kind == "update_agent":
        agent = agents.get(str(src.get("agent_id") or ""))
        if agent is None:
            return None
        changes = clean_agent_changes(src.get("changes"), agent)
        if not changes:
            return None
        now = text_state(agent)
        return _proposal(kind, {"agent_id": agent["id"], "changes": changes},
                         title_update_agent(agent["name"], list(changes)), {f: now[f] for f in changes},
                         {"agent_id": agent["id"]}, agent_fingerprint_text(agent))
    if kind == "create_routine":
        agent = agents.get(str(src.get("agent_id") or ""))
        if agent is None:
            return None
        draft = routines_mod.normalize_routine(src, now_local=now_local, min_interval=min_interval)
        if draft is None:
            return None
        payload = {"agent_id": agent["id"], "title": draft["title"], "prompt": draft["prompt"],
                   "schedule": draft["schedule"], "report": draft["report"],
                   "schedule_text": draft["schedule_text"]}
        return _proposal(kind, payload, title_create_routine(agent["name"], draft["title"]), None,
                         {"agent_id": agent["id"]}, None)
    if kind == "update_routine":
        routine = routines.get(str(src.get("routine_id") or ""))
        if routine is None:
            return None
        changes = clean_routine_changes(src.get("changes"), routine, now_local=now_local,
                                        min_interval=min_interval)
        if not changes:
            return None
        before = {f: routine.get(f) for f in changes}
        payload: dict[str, Any] = {"routine_id": routine["id"], "changes": changes}
        if "schedule" in changes:  # the phrases, for the card (output only: ignored when applying)
            before["schedule_text"] = routine.get("schedule_text") or routines_mod.schedule_text(routine["schedule"])
            payload["schedule_text"] = routines_mod.schedule_text(changes["schedule"])
        return _proposal(kind, payload, title_update_routine(routine["title"], list(changes), changes.get("enabled")),
                         before, {"routine_id": routine["id"]}, routine_fingerprint(routine))
    return None


def normalize_reply(obj: Any, *, agents: list[dict[str, Any]], routines: list[dict[str, Any]],
                    now_local: datetime | None, min_interval: int) -> dict[str, Any] | None:
    """``{"say", "proposals": [<proposal, with title/before/target/fingerprint>]}`` from a parsed reply, or
    ``None`` when it is not an answer at all (no ``say`` and no ``proposals``: the attempt is retried).
    At most ``MAX_PROPOSALS`` valid proposals are kept; two for the same target and kind in one reply keep the
    first. When the model tried to propose and nothing survived, ``say`` ends with ``NOT_BUILT_SENTENCE``."""
    if not isinstance(obj, dict) or ("say" not in obj and "proposals" not in obj):
        return None
    by_agent = {str(a["id"]): a for a in agents}
    by_routine = {str(r["id"]): r for r in routines}
    raw_list = obj.get("proposals")
    raw_list = raw_list if isinstance(raw_list, list) else []
    kept: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for raw in raw_list:
        item = _one_proposal(raw, by_agent, by_routine, now_local, min_interval)
        if item is None:
            continue
        target = item["target"]
        key = (item["kind"], target.get("agent_id") or target.get("routine_id") or "")
        if item["kind"] == "create_routine":  # several routines for one agent are fine, the same one twice is not
            key = (item["kind"], f"{key[1]}|{str(item['payload']['title']).casefold()}")
        if target and key in seen:
            continue
        seen.add(key)
        kept.append(item)
        if len(kept) == MAX_PROPOSALS:
            break
    say = " ".join(str(obj.get("say") or "").split())
    if raw_list and not kept:
        room = SAY_MAX - len(NOT_BUILT_SENTENCE) - 1
        say = f"{say[:room].strip()} {NOT_BUILT_SENTENCE}".strip()
    else:
        say = say[:SAY_MAX].strip()
    return {"say": say or DEFAULT_SAY, "proposals": kept}


# -- a stored payload: strict (applying) -------------------------------------------------------------------


def _forbid(keys: Any, allowed: tuple[str, ...]) -> None:
    for key in keys:
        if key not in allowed:
            raise Invalid(FORBIDDEN_TEXT.format(field=key))


def check_agent_changes(changes: Any) -> dict[str, Any]:
    """``changes`` of a stored ``update_agent``: only the five text fields, at least one, each of the right type."""
    if not isinstance(changes, dict) or not changes:
        raise Invalid("A proposta não traz nenhuma mudança.")
    _forbid(changes, AGENT_CHANGE_FIELDS)
    for field, value in changes.items():
        if field == "suggestions":
            if not isinstance(value, list) or not all(isinstance(x, str) for x in value):
                raise Invalid("As sugestões precisam ser uma lista de textos.")
        elif not isinstance(value, str):
            raise Invalid(f"O campo {field} precisa ser um texto.")
    return dict(changes)


def check_routine_changes(changes: Any) -> dict[str, Any]:
    """``changes`` of a stored ``update_routine``: title, request, schedule, report, ``enabled``; at least one."""
    if not isinstance(changes, dict) or not changes:
        raise Invalid("A proposta não traz nenhuma mudança.")
    _forbid(changes, ROUTINE_CHANGE_FIELDS)
    if "enabled" in changes and not isinstance(changes["enabled"], bool):
        raise Invalid("«enabled» precisa ser verdadeiro ou falso.")
    if "schedule" in changes and not isinstance(changes["schedule"], dict):
        raise Invalid("O horário precisa ser um objeto.")
    for field in ("title", "prompt", "report"):
        if field in changes and not isinstance(changes[field], str):
            raise Invalid(f"O campo {field} precisa ser um texto.")
    return dict(changes)


def check_new_agents(payload: Any) -> list[dict[str, Any]]:
    """The drafts of a stored ``create_agents``, with only the fields of a 6a draft (a stored ``engine``,
    ``provider``, ``model`` or ``perm_commands`` is refused). The strict draft rules are applied by the team creation."""
    items = payload.get("agents") if isinstance(payload, dict) else None
    if not isinstance(items, list) or not 1 <= len(items) <= PROPOSAL_MAX_AGENTS:
        raise Invalid("A proposta não traz agentes válidos.")
    out: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            raise Invalid("A proposta não traz agentes válidos.")
        _forbid(item, DRAFT_ALLOWED)
        draft = dict(item)
        routines_raw = draft.get("routines") or []
        if not isinstance(routines_raw, list):
            raise Invalid("As rotinas do agente precisam ser uma lista.")
        for r in routines_raw:
            if not isinstance(r, dict):
                raise Invalid("Cada rotina precisa ser um objeto.")
            _forbid(r, ROUTINE_DRAFT_ALLOWED)
        draft["routines"] = routines_raw
        out.append(draft)
    return out


def check_new_routine(payload: Any) -> dict[str, Any]:
    """A stored ``create_routine``: only its agent, title, request, schedule and report."""
    if not isinstance(payload, dict):
        raise Invalid("A proposta não traz uma rotina válida.")
    _forbid(payload, CREATE_ROUTINE_ALLOWED)
    return {k: payload.get(k) for k in ("agent_id", "title", "prompt", "schedule", "report")}
