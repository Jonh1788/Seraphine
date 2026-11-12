"""Agent drafts (phase 6a): the shape shared by ready-made teams, the guided proposal and team creation.

A draft is what the owner sees before anything is created. Two ways in:

* ``normalize_draft`` -- for text the model wrote (untrusted): never raises, cuts, drops, lowers.
* ``check_draft`` -- for a body the page sends: strict, answers 422 with a pt-BR sentence.

Both end in the same place: grants never above ``GRANT_CEILING``, ``perm_commands`` is not a draft
field at all (agents created from drafts always ask), and an engine chosen by the model is ignored.
"""

from __future__ import annotations

import re
from typing import Any

from datetime import datetime

from seraphine.agents import routines as routines_mod
from seraphine.agents.catalog import GRANT_GROUPS, LEVEL_RANK, LEVELS
from seraphine.agents.errors import Invalid

NAME_MAX = 80
ROLE_MAX = 200
DESCRIPTION_MAX = 300
INSTRUCTIONS_MAX = 20_000
SUGGESTIONS_MAX = 3
SUGGESTION_MAX = 120
SAY_MAX = 600
#: Most agents one guided proposal may carry.
PROPOSAL_MAX_AGENTS = 5

COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
#: The colours the page offers (``AGENT_COLORS`` in ``frontend/src/agents/lib.ts``); used when a draft has none.
PALETTE = ("#f2a65a", "#7fb2ff", "#6fdcaa", "#f29bc0", "#9a93ff")
PERM_EDIT_VALUES = ("free", "blocked")

#: How far a draft may reach into the Seraphine tools. Anything asked above is lowered, without error.
GRANT_CEILING: dict[str, str] = {
    "notes": "write", "reminders": "write", "project_tasks": "write", "wiki": "read", "memory": "none",
}
KNOWN_GROUPS = tuple(g.id for g in GRANT_GROUPS)
DRAFT_FIELDS = ("name", "role", "description", "instructions", "suggestions", "color", "perm_edit",
                "grants", "engine", "provider", "model", "routines")
#: Fields of a routine inside a draft (``schedule_text`` is output only; the page may send it back).
ROUTINE_DRAFT_FIELDS = ("title", "prompt", "schedule", "report", "schedule_text")
#: Draft fields a model may NOT decide (ignored when it sends them).
MODEL_BLOCKED = ("engine", "provider", "model")


def color_for(index: int) -> str:
    return PALETTE[index % len(PALETTE)]


def lower_grants(name: str, asked: dict[str, str]) -> tuple[dict[str, str], list[dict[str, str]]]:
    """``(grants kept, lowered report)``. A group missing from the ceiling counts as ``none``."""
    kept: dict[str, str] = {}
    lowered: list[dict[str, str]] = []
    for group, level in asked.items():
        top = GRANT_CEILING.get(group, "none")
        if LEVEL_RANK[level] > LEVEL_RANK[top]:
            lowered.append({"name": name, "group": group, "asked": level, "got": top})
            level = top
        kept[group] = level
    return kept, lowered


def _clip(value: Any, limit: int) -> str:
    return str(value if value is not None else "").strip()[:limit].strip()


def normalize_draft(raw: Any, index: int = 0, *, now_local: datetime | None = None,
                    min_interval: int = routines_mod.DEFAULT_MIN_INTERVAL_MIN,
                    local: routines_mod.LocalTime = routines_mod.SYSTEM_LOCAL) -> dict[str, Any] | None:
    """A draft from untrusted data (the model's JSON), or ``None`` when it has no usable name or
    instructions. Everything is cut to the limits; unknown fields and ``engine``/``provider``/``model``
    are dropped; ``grants`` are lowered to the ceiling (silently: the owner sees the final access).
    ``routines``: invalid ones are dropped (the agent stays), at most ``MODEL_ROUTINES_MAX`` are kept."""
    if not isinstance(raw, dict):
        return None
    name = _clip(raw.get("name"), NAME_MAX)
    instructions = str(raw.get("instructions") or "").strip()[:INSTRUCTIONS_MAX].strip()
    if not name or not instructions:
        return None
    suggestions: list[str] = []
    raw_sug = raw.get("suggestions")
    if isinstance(raw_sug, list):
        for item in raw_sug:
            text = _clip(item, SUGGESTION_MAX) if isinstance(item, str) else ""
            if text and text not in suggestions:
                suggestions.append(text)
            if len(suggestions) == SUGGESTIONS_MAX:
                break
    color = raw.get("color")
    color = color.strip().lower() if isinstance(color, str) and COLOR_RE.match(color.strip()) else color_for(index)
    perm_edit = raw.get("perm_edit")
    asked: dict[str, str] = {}
    if isinstance(raw.get("grants"), dict):
        for group, level in raw["grants"].items():
            if group in KNOWN_GROUPS and level in LEVELS:
                asked[group] = level
    grants, _ = lower_grants(name, asked)
    return {
        "name": name, "role": _clip(raw.get("role"), ROLE_MAX),
        "description": _clip(raw.get("description"), DESCRIPTION_MAX),
        "instructions": instructions, "suggestions": suggestions, "color": color,
        "perm_edit": perm_edit if perm_edit in PERM_EDIT_VALUES else "free",
        "grants": grants,
        "routines": routines_mod.normalize_routines(raw.get("routines"), now_local=now_local,
                                                    min_interval=min_interval, local=local),
    }


def check_draft(raw: dict[str, Any], index: int = 0) -> dict[str, Any]:
    """A draft the page sent, checked strictly (422 in pt-BR). ``grants`` are returned as asked: the
    caller lowers them and reports what was lowered. Unknown fields are refused by the body model."""
    where = f"agente {index + 1}: "
    name = str(raw.get("name") or "").strip()
    if not name:
        raise Invalid(where + "o nome é obrigatório")
    if len(name) > NAME_MAX:
        raise Invalid(where + f"o nome pode ter até {NAME_MAX} caracteres")
    role = str(raw.get("role") or "").strip()
    if len(role) > ROLE_MAX:
        raise Invalid(where + f"o papel pode ter até {ROLE_MAX} caracteres")
    description = str(raw.get("description") or "").strip()
    if len(description) > DESCRIPTION_MAX:
        raise Invalid(where + f"a descrição pode ter até {DESCRIPTION_MAX} caracteres")
    instructions = str(raw.get("instructions") or "").strip()
    if not instructions:
        raise Invalid(where + "as instruções são obrigatórias")
    if len(instructions) > INSTRUCTIONS_MAX:
        raise Invalid(where + f"as instruções podem ter até {INSTRUCTIONS_MAX} caracteres")
    suggestions = [str(s).strip() for s in (raw.get("suggestions") or []) if str(s).strip()]
    if len(suggestions) > SUGGESTIONS_MAX:
        raise Invalid(where + f"use no máximo {SUGGESTIONS_MAX} sugestões")
    if any(len(s) > SUGGESTION_MAX for s in suggestions):
        raise Invalid(where + f"cada sugestão pode ter até {SUGGESTION_MAX} caracteres")
    color = raw.get("color")
    if color is not None and not COLOR_RE.match(str(color)):
        raise Invalid(where + "a cor precisa ter o formato #rrggbb")
    grants = raw.get("grants") or {}
    for group, level in grants.items():
        if group not in KNOWN_GROUPS:
            raise Invalid(where + f"grupo de ferramentas desconhecido: {group}")
        if level not in LEVELS:
            raise Invalid(where + f"nível inválido para {group}: use none, read ou write")
    routines = list(raw.get("routines") or [])
    if len(routines) > routines_mod.PAGE_ROUTINES_MAX:
        raise Invalid(where + f"use no máximo {routines_mod.PAGE_ROUTINES_MAX} rotinas")
    kept: list[dict[str, Any]] = []
    for item in routines:
        if not isinstance(item, dict):
            raise Invalid(where + "cada rotina precisa ser um objeto")
        # Only the structure is checked here; the rules of the schedule are applied when the routine is
        # created, so one bad routine is reported without refusing the whole team.
        kept.append({k: item.get(k) for k in ROUTINE_DRAFT_FIELDS if k in item and k != "schedule_text"})
    return {"name": name, "role": role, "description": description, "instructions": instructions,
            "suggestions": suggestions, "color": str(color).lower() if color else color_for(index),
            "perm_edit": raw.get("perm_edit") or "free", "grants": dict(grants),
            "engine": raw.get("engine"), "provider": raw.get("provider"), "model": raw.get("model"),
            "routines": kept}
