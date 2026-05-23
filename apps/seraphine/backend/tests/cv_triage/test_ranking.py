"""Tests for the cv_triage.ranking module."""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from seraphine.cv_triage.ranking import (
    SCORE_TOOL,
    ScoreResult,
    rank_one,
)


def test_tool_schema_contract() -> None:
    assert SCORE_TOOL["name"] == "score_candidate"
    props = SCORE_TOOL["input_schema"]["properties"]
    for k in (
        "candidate_name",
        "score",
        "match_pct",
        "strengths",
        "gaps",
        "justification",
    ):
        assert k in props
    assert SCORE_TOOL["input_schema"]["properties"]["score"]["maximum"] == 100


@pytest.mark.asyncio
async def test_rank_one_parses_tool_use() -> None:
    client = AsyncMock()
    client.tool_call_json.return_value = {
        "candidate_name": "João Silva",
        "score": 87.5,
        "match_pct": 84,
        "strengths": ["Python", "FastAPI", "fintech"],
        "gaps": ["sem experiência K8s"],
        "justification": "Forte fit em backend python.",
    }
    res = await rank_one(
        client, rubric="vaga py senior", cv_text="cv...", model="claude-sonnet-4-6"
    )
    assert isinstance(res, ScoreResult)
    assert res.candidate_name == "João Silva"
    assert res.score == 87.5
    assert res.strengths == ["Python", "FastAPI", "fintech"]
    client.tool_call_json.assert_awaited_once()


@pytest.mark.asyncio
async def test_rank_one_clamps_score_bounds() -> None:
    client = AsyncMock()
    client.tool_call_json.return_value = {
        "candidate_name": "X",
        "score": 150,
        "match_pct": -5,
        "strengths": [],
        "gaps": [],
        "justification": "ok",
    }
    res = await rank_one(client, rubric="r", cv_text="t", model="m")
    assert res.score == 100
    assert res.match_pct == 0
