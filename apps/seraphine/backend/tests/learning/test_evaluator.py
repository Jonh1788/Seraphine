"""Tests for the regression-eval harness (learning loop, Task 3).

The harness drives an injected async ``llm_call`` twice per case: once as the
RESPONDER (system + user) and once as the JUDGE (a single user turn whose
content carries the rubric). Tests disambiguate the two turns by inspecting the
message list — the judge prompt contains ``"RUBRIC"`` and has no system role.
"""

from __future__ import annotations

import asyncio
from typing import Any

from seraphine.learning.evaluator import _parse_score, evaluate_policy


def _is_judge(messages: list[dict[str, str]]) -> bool:
    return "RUBRIC" in messages[-1]["content"]


def test_parse_score():
    assert _parse_score('{"score":0.8}') == 0.8
    assert _parse_score("7/10") == 0.7
    assert _parse_score("0.95") == 0.95
    assert _parse_score("garbage no number") == 0.5
    assert _parse_score('{"score": 1.5}') == 1.0  # clamp
    assert _parse_score("score is 8") == 0.8  # int 8 <= 10 -> /10


def test_empty_cases_neutral():
    async def any_call(messages: list[dict[str, str]]) -> str:
        raise AssertionError("llm_call should not run with no cases")

    result = asyncio.run(
        evaluate_policy(
            any_call,
            behavior_addendum="",
            tool_guidance="",
            eval_cases=[],
        )
    )
    assert result.score == 0.5
    assert result.n == 0
    assert result.per_case == []


def test_mean_of_scores():
    async def llm_call(messages: list[dict[str, str]]) -> str:
        if _is_judge(messages):
            return '{"score": 1.0}'
        return "resposta"

    cases: list[dict[str, Any]] = [
        {"id": "a", "input_text": "oi", "rubric": "be nice"},
        {"id": "b", "input_text": "tudo bem?", "rubric": "be nice"},
    ]
    result = asyncio.run(
        evaluate_policy(
            llm_call,
            behavior_addendum="addendum",
            tool_guidance="guidance",
            eval_cases=cases,
        )
    )
    assert result.score == 1.0
    assert result.n == 2
    assert len(result.per_case) == 2


def test_responder_error_scores_neutral():
    async def llm_call(messages: list[dict[str, str]]) -> str:
        if any(m["role"] == "system" for m in messages):
            raise RuntimeError("responder boom")
        return '{"score": 1.0}'

    cases = [{"id": "a", "input_text": "oi", "rubric": "be nice"}]
    result = asyncio.run(
        evaluate_policy(
            llm_call,
            behavior_addendum="addendum",
            tool_guidance="guidance",
            eval_cases=cases,
        )
    )
    assert result.score == 0.5
    assert result.n == 1
    assert result.per_case[0]["error"] == "responder"


def test_judge_error_scores_neutral():
    async def llm_call(messages: list[dict[str, str]]) -> str:
        if _is_judge(messages):
            raise RuntimeError("judge boom")
        return "resposta"

    cases = [{"id": "a", "input_text": "oi", "rubric": "be nice"}]
    result = asyncio.run(
        evaluate_policy(
            llm_call,
            behavior_addendum="addendum",
            tool_guidance="guidance",
            eval_cases=cases,
        )
    )
    assert result.score == 0.5
    assert result.n == 1
