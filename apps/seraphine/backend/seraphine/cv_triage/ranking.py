"""Rank a single CV against a free-text job rubric using Claude's tool-use.

`rank_one(client, rubric, cv_text, model)` issues a single forced tool
call (`score_candidate`) and returns a clamped, length-bounded `ScoreResult`.
The rubric is sent as a cacheable system block — the same rubric is reused
across all CVs in a triage job, so prompt-cache hits dominate after the first.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

SCORE_TOOL: dict[str, Any] = {
    "name": "score_candidate",
    "description": "Avalia um currículo contra a vaga e atribui pontuação.",
    "input_schema": {
        "type": "object",
        "required": [
            "candidate_name",
            "score",
            "match_pct",
            "strengths",
            "gaps",
            "justification",
        ],
        "properties": {
            "candidate_name": {"type": "string", "maxLength": 120},
            "score": {"type": "number", "minimum": 0, "maximum": 100},
            "match_pct": {"type": "number", "minimum": 0, "maximum": 100},
            "strengths": {
                "type": "array",
                "items": {"type": "string"},
                "maxItems": 5,
            },
            "gaps": {
                "type": "array",
                "items": {"type": "string"},
                "maxItems": 5,
            },
            "justification": {"type": "string", "maxLength": 400},
        },
    },
}


@dataclass
class ScoreResult:
    candidate_name: str
    score: float
    match_pct: float
    strengths: list[str]
    gaps: list[str]
    justification: str


def _clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, float(x)))


async def rank_one(
    client: Any, *, rubric: str, cv_text: str, model: str
) -> ScoreResult:
    """Score a single CV against the rubric via a forced ``score_candidate``
    tool call. Returns a clamped, length-bounded :class:`ScoreResult`."""
    system = (
        "Você é um recrutador técnico rigoroso. Avalie o currículo abaixo "
        "contra a vaga. Use a tool score_candidate; não responda em texto livre."
    )
    user = (
        f"<vaga>\n{rubric}\n</vaga>\n\n"
        f"<curriculo>\n{cv_text[:18000]}\n</curriculo>"
    )
    payload = await client.tool_call_json(
        model=model,
        system=system,
        user=user,
        tool=SCORE_TOOL,
        cache_system=True,
        max_tokens=1024,
    )
    return ScoreResult(
        candidate_name=str(payload["candidate_name"])[:120],
        score=_clamp(payload["score"], 0, 100),
        match_pct=_clamp(payload["match_pct"], 0, 100),
        strengths=list(payload.get("strengths") or [])[:5],
        gaps=list(payload.get("gaps") or [])[:5],
        justification=str(payload.get("justification") or "")[:400],
    )
