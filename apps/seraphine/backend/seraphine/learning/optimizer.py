"""The teacher optimizer: ask an LLM for a small, safe policy refinement.

Given recent conversation traces and the active policy, this asks an injected
async ``llm_call`` (the "teacher") to propose a refined ``Candidate``. The
proposal is parsed defensively — malformed JSON, missing keys, oversized text,
and out-of-bounds/unknown knobs are all tolerated — so a bad teacher response
can never crash or escape the bounded knob whitelist.

PURE module: no I/O, no globals, ``llm_call`` is injected by the caller.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from seraphine.learning.knobs import clamp_knobs, knob_registry

logger = logging.getLogger(__name__)
LLMCall = Callable[[list[dict[str, str]]], Awaitable[str]]


@dataclass
class Candidate:
    behavior_addendum: str = ""
    tool_guidance: str = ""
    knobs: dict[str, Any] = field(default_factory=dict)
    rationale: str = ""


def _extract_json(text: str) -> dict[str, Any]:
    try:
        m = re.search(r'\{.*\}', text or "", re.S)
        return json.loads(m.group(0)) if m else {}
    except Exception:
        return {}


def _summarize_traces(traces: list[dict[str, Any]], limit: int = 25) -> str:
    out = []
    for t in traces[:limit]:
        sig = t.get("signal")
        tag = "" if sig is None else f" [signal={sig}]"
        out.append(
            f"- U: {(t.get('user_msg') or '')[:200]}\n"
            f"  A: {(t.get('assistant_msg') or '')[:200]}{tag}"
        )
    return "\n".join(out)


async def propose_candidate(
    llm_call: LLMCall,
    *,
    traces: list[dict[str, Any]],
    active_behavior: str,
    active_tool_guidance: str,
    active_knobs: dict[str, Any],
) -> Candidate:
    """Ask the teacher for an improved policy. Robust to malformed output."""
    prompt = (
        "You are improving the assistant 'Seraphine' from real conversation "
        "traces. Propose a SMALL, SAFE refinement. Output ONLY JSON with keys: "
        '"behavior_addendum" (concise guidance appended to the system prompt), '
        '"tool_guidance" (concise guidance on WHEN to use tools like memory '
        "recall, calendar, search), "
        '"knobs" (object; ONLY the whitelisted knobs below, within bounds), '
        '"rationale" (1-2 sentences).\n\n'
        f"WHITELISTED KNOBS:\n{json.dumps(knob_registry(), ensure_ascii=False)}\n\n"
        f"CURRENT behavior_addendum:\n{active_behavior or '(none)'}\n\n"
        f"CURRENT tool_guidance:\n{active_tool_guidance or '(none)'}\n\n"
        f"CURRENT knobs:\n{json.dumps(active_knobs)}\n\n"
        "RECENT TRACES (prioritize fixing low-signal ones):\n"
        f"{_summarize_traces(traces)}"
    )
    try:
        raw = await llm_call([{"role": "user", "content": prompt}])
    except Exception as e:  # noqa: BLE001
        logger.warning("optimizer LLM failed: %s", e)
        return Candidate(rationale="optimizer-llm-error")
    data = _extract_json(raw)
    raw_knobs = data.get("knobs")
    return Candidate(
        behavior_addendum=str(data.get("behavior_addendum", "") or "")[:2000],
        tool_guidance=str(data.get("tool_guidance", "") or "")[:2000],
        knobs=clamp_knobs(raw_knobs if isinstance(raw_knobs, dict) else {}),
        rationale=str(data.get("rationale", "") or "")[:500],
    )
