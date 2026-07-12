"""Trilhas — geração de curso em 3 estágios (pesquisa → outline → lições).

Validação pura + wrappers de LLM (tool-call, grounded) + orquestração.
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger("seraphine.courses")

EX_TYPES = {"mcq", "cloze", "type", "match"}


def _s(v: Any, n: int) -> str:
    return (str(v) if v is not None else "").strip()[:n]


def valid_exercise(raw: dict) -> dict | None:
    """Valida/normaliza um exercício por tipo. Retorna dict normalizado ou None."""
    if not isinstance(raw, dict):
        return None
    etype = _s(raw.get("type"), 10)
    prompt = _s(raw.get("prompt"), 300)
    if etype not in EX_TYPES or len(prompt) < 3:
        return None
    payload_in = raw.get("payload") if isinstance(raw.get("payload"), dict) else {}
    explanation = _s(raw.get("explanation"), 500)
    concept_key = _s(raw.get("concept_key"), 120)
    payload: dict[str, Any]

    if etype == "mcq":
        options = [_s(o, 200) for o in (payload_in.get("options") or []) if _s(o, 200)]
        idx = payload_in.get("answer_idx")
        if len(options) < 2 or len(options) > 6 or not isinstance(idx, int):
            return None
        if idx < 0 or idx >= len(options):
            return None
        payload = {"options": options, "answer_idx": idx}

    elif etype == "cloze":
        text = _s(payload_in.get("text"), 300)
        answers = [_s(a, 100) for a in (payload_in.get("answers") or []) if _s(a, 100)]
        if "___" not in text or not answers:
            return None
        payload = {"text": text, "answers": answers}
        opts = [_s(o, 100) for o in (payload_in.get("options") or []) if _s(o, 100)]
        if opts:
            payload["options"] = opts

    elif etype == "type":
        accepted = [_s(a, 200) for a in (payload_in.get("accepted") or []) if _s(a, 200)]
        if not accepted:
            return None
        payload = {"accepted": accepted, "rubric": _s(payload_in.get("rubric"), 300)}

    else:  # match
        pairs_in = payload_in.get("pairs")
        steps_in = payload_in.get("steps")
        if isinstance(pairs_in, list) and len(pairs_in) >= 2:
            pairs = []
            for p in pairs_in:
                if isinstance(p, (list, tuple)) and len(p) == 2:
                    a, b = _s(p[0], 120), _s(p[1], 120)
                    if a and b:
                        pairs.append([a, b])
            if len(pairs) < 2:
                return None
            payload = {"pairs": pairs}
        elif isinstance(steps_in, list) and len(steps_in) >= 2:
            steps = [_s(x, 160) for x in steps_in if _s(x, 160)]
            if len(steps) < 2:
                return None
            payload = {"steps": steps}
        else:
            return None

    return {
        "type": etype, "prompt": prompt, "payload": payload,
        "explanation": explanation, "concept_key": concept_key,
    }


def clamp_outline(raw: list, *, lo: int = 5, hi: int = 12) -> list[dict]:
    out: list[dict] = []
    seen: set[str] = set()
    for it in raw or []:
        if not isinstance(it, dict):
            continue
        title = _s(it.get("title"), 120)
        objective = _s(it.get("objective"), 300)
        if len(title) < 3:
            continue
        key = title.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append({"title": title, "objective": objective})
        if len(out) >= hi:
            break
    return out
