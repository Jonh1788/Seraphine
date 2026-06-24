"""Tests for the teacher optimizer (learning loop, Task 4).

The optimizer drives an injected async ``llm_call`` once to ask the teacher for
a small, safe policy refinement, then parses + clamps the JSON response into a
``Candidate``. Tests script ``llm_call`` to return fixed strings (ignoring the
prompt) and assert robust handling of clamping, garbage, errors, and bad types.
"""

from __future__ import annotations

import asyncio
from typing import Any

from seraphine.learning.optimizer import _summarize_traces, propose_candidate


def _scripted(reply: str):
    async def llm_call(messages: list[dict[str, str]]) -> str:
        return reply

    return llm_call


def _propose(llm_call) -> Any:
    return asyncio.run(
        propose_candidate(
            llm_call,
            traces=[{"user_msg": "oi", "assistant_msg": "ola", "signal": 0.2}],
            active_behavior="",
            active_tool_guidance="",
            active_knobs={},
        )
    )


def test_proposes_and_clamps():
    reply = (
        '{"behavior_addendum":"Seja mais conciso.",'
        '"tool_guidance":"Busque memória antes de responder sobre o passado.",'
        '"knobs":{"recall_fact_limit":999,"bogus_knob":5},'
        '"rationale":"traces curtos sugerem concisão"}'
    )
    cand = _propose(_scripted(reply))
    assert cand.behavior_addendum == "Seja mais conciso."
    assert cand.tool_guidance == "Busque memória antes de responder sobre o passado."
    assert cand.knobs == {"recall_fact_limit": 60}
    assert cand.rationale == "traces curtos sugerem concisão"


def test_garbage_returns_empty():
    cand = _propose(_scripted("não sei, desculpa"))
    assert cand.behavior_addendum == ""
    assert cand.tool_guidance == ""
    assert cand.knobs == {}
    assert cand.rationale == ""


def test_llm_error_marks_rationale():
    async def boom(messages: list[dict[str, str]]) -> str:
        raise RuntimeError("teacher boom")

    cand = _propose(boom)
    assert cand.rationale == "optimizer-llm-error"
    assert cand.behavior_addendum == ""
    assert cand.tool_guidance == ""
    assert cand.knobs == {}


def test_knobs_non_dict_ignored():
    reply = '{"behavior_addendum":"x","knobs":"notadict"}'
    cand = _propose(_scripted(reply))
    assert cand.knobs == {}
    assert cand.behavior_addendum == "x"


def test_summarize_traces_truncates():
    long_msg = "a" * 500
    summary = _summarize_traces([{"user_msg": long_msg, "assistant_msg": "b"}])
    assert long_msg not in summary
    assert ("a" * 200) in summary
    assert ("a" * 201) not in summary
