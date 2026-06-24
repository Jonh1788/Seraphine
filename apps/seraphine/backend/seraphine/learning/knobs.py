"""The bounded whitelist of execution knobs the learning loop may tune.

Only these knobs can ever be changed by a promoted policy, each clamped to a
safe range. The optimizer is shown this registry; promotion applies clamped
values. This is the *execution-path* half of "both" (behavior addendum is the
other half) — bounded + human-gated so a bad proposal can't run wild.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal


@dataclass(frozen=True)
class Knob:
    name: str
    kind: Literal["int", "bool"]
    default: Any
    lo: Any = None
    hi: Any = None
    description: str = ""


TUNABLE_KNOBS: list[Knob] = [
    Knob("recall_fact_limit", "int", 30, 5, 60,
         "How many fresh facts to inject into the recall block per turn."),
    Knob("smart_escalation_prompt_chars", "int", 1500, 400, 4000,
         "Prompt length (chars) above which a turn is treated as complex and may "
         "escalate to the smart model."),
    Knob("recall_enabled", "bool", True, None, None,
         "Whether to inject the semantic recall block at all."),
]
_BY_NAME = {k.name: k for k in TUNABLE_KNOBS}


def clamp_knobs(raw: dict[str, Any] | None) -> dict[str, Any]:
    """Drop unknown keys, coerce types, clamp ints to [lo, hi]. Never raises."""
    out: dict[str, Any] = {}
    for name, val in (raw or {}).items():
        k = _BY_NAME.get(name)
        if k is None:
            continue
        try:
            if k.kind == "int":
                iv = int(val)
                out[name] = max(k.lo, min(k.hi, iv))
            elif k.kind == "bool":
                out[name] = (
                    bool(val)
                    if not isinstance(val, str)
                    else val.strip().lower() in ("1", "true", "yes")
                )
        except Exception:
            continue
    return out


def effective_knobs(active: dict[str, Any] | None) -> dict[str, Any]:
    """Defaults overlaid with clamped active overrides — the values the engine reads."""
    out = {k.name: k.default for k in TUNABLE_KNOBS}
    out.update(clamp_knobs(active))
    return out


def knob_registry() -> list[dict[str, Any]]:
    """JSON-serializable registry for the optimizer prompt + the UI."""
    return [
        {"name": k.name, "kind": k.kind, "default": k.default,
         "lo": k.lo, "hi": k.hi, "description": k.description}
        for k in TUNABLE_KNOBS
    ]
