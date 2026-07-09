"""Tests for LearningService (learning loop, Task 5).

The service orchestrates one improvement cycle (evaluate active -> propose ->
evaluate candidate -> regression gate -> store pending/rejected) plus the
human-gated rollout primitives (promote/reject/rollback). ``llm_call`` is
scripted so every turn is deterministic:

- optimizer turn:  "WHITELISTED KNOBS" in messages[0]["content"]
- judge turn:      "RUBRIC" in messages[-1]["content"]
- else:            responder
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from core_db import Store

from seraphine.learning import schema as learning_schema
from seraphine.learning.service import LearningService
from seraphine.learning.traces import record_trace


def _make_store(tmp_path: Path, name: str = "service.sqlite") -> Store:
    store = Store(tmp_path / name)
    store.register_migrator("learning", learning_schema.migrate)
    asyncio.run(store.ensure_schema())
    return store


def make_llm(judge_score=0.9, optimizer_json=None, sentinel_low=None):
    """Deterministic scripted llm_call branching on message content."""
    OPT = optimizer_json or (
        '{"behavior_addendum":"Seja conciso.","tool_guidance":"",'
        '"knobs":{"recall_fact_limit":12},"rationale":"r"}'
    )

    async def llm(messages):
        last = messages[-1]["content"]
        first = messages[0]["content"]
        if "WHITELISTED KNOBS" in first:
            return OPT
        if "RUBRIC" in last:
            if sentinel_low and sentinel_low in last:
                return '{"score": 0.3}'
            return '{"score": %s}' % judge_score
        return "uma resposta"  # responder

    return llm


def make_echo_llm():
    """Optimizer injects a sentinel addendum; responder echoes the system
    prompt so the judge can detect the sentinel and score the regressing
    candidate low. Baseline policy has an empty addendum -> no sentinel -> 0.9.
    """

    async def llm(messages):
        first = messages[0]["content"]
        last = messages[-1]["content"]
        if "WHITELISTED KNOBS" in first:
            return (
                '{"behavior_addendum":"SENTINEL_BAD","tool_guidance":"",'
                '"knobs":{},"rationale":"r"}'
            )
        if "RUBRIC" in last:
            return '{"score": 0.3}' if "SENTINEL_BAD" in last else '{"score": 0.9}'
        return first  # responder echoes the system prompt

    return llm


def make_good_llm(base_score=0.85, cand_score=0.95):
    """Candidate policy carries SENTINEL_GOOD in its addendum; the responder
    echoes the system prompt so the judge sees the sentinel and scores the
    candidate higher than the (sentinel-less) baseline."""

    async def llm(messages):
        first = messages[0]["content"]
        last = messages[-1]["content"]
        if "WHITELISTED KNOBS" in first:
            return (
                '{"behavior_addendum":"SENTINEL_GOOD","tool_guidance":"",'
                '"knobs":{},"rationale":"melhora"}'
            )
        if "RUBRIC" in last:
            return '{"score": %s}' % (cand_score if "SENTINEL_GOOD" in last else base_score)
        return first  # responder echoes the system prompt

    return llm


def make_addendum_llm(addendum, base_score=0.80, cand_score=0.95):
    """Optimizer proposes `addendum`; the responder echoes the system prompt so
    the judge scores the candidate high (cand_score) when its addendum is
    present and the (addendum-less) baseline low (base_score). Lets a two-cycle
    promote/rollback test produce a DISTINCT pending candidate per cycle that
    still beats the margin gate."""

    opt = (
        '{"behavior_addendum":"%s","tool_guidance":"",'
        '"knobs":{},"rationale":"r"}'
    ) % addendum

    async def llm(messages):
        first = messages[0]["content"]
        last = messages[-1]["content"]
        if "WHITELISTED KNOBS" in first:
            return opt
        if "RUBRIC" in last:
            return '{"score": %s}' % (cand_score if addendum in last else base_score)
        return first  # responder echoes the system prompt

    return llm


def _seed_traces(store: Store, n: int) -> None:
    for i in range(n):
        asyncio.run(
            record_trace(
                store,
                conversation_id=f"c{i}",
                turn_id=f"t{i}",
                user_msg=f"pergunta {i}",
                assistant_msg=f"resposta {i}",
                signal=None,
            )
        )


def test_run_cycle_stores_pending_when_beats_margin(tmp_path: Path):
    store = _make_store(tmp_path)
    _seed_traces(store, 8)
    svc = LearningService(store, make_good_llm(base_score=0.85, cand_score=0.95))

    result = asyncio.run(svc.run_cycle())

    assert result["status"] == "pending"
    assert result["passed"] is True
    pending = asyncio.run(svc.list_candidates(status="pending"))
    assert len(pending) == 1
    assert pending[0]["candidate_score"] is not None


def test_run_cycle_rejects_on_regression(tmp_path: Path):
    store = _make_store(tmp_path)
    _seed_traces(store, 8)
    svc = LearningService(store, make_echo_llm())

    result = asyncio.run(svc.run_cycle())

    assert result["status"] == "rejected"
    assert result["passed"] is False
    assert result["baseline_score"] == pytest.approx(0.9)
    assert result["candidate_score"] == pytest.approx(0.3)
    assert "below margin" in result["rationale"]


def test_gate_pending_when_beats_margin(tmp_path: Path):
    store = _make_store(tmp_path)
    _seed_traces(store, 8)  # 8 traces / 8 convs — passes evidence
    svc = LearningService(store, make_good_llm(base_score=0.85, cand_score=0.95))

    result = asyncio.run(svc.run_cycle())

    assert result["status"] == "pending"
    assert result["candidate_score"] >= result["baseline_score"] + 0.05
    assert len(asyncio.run(svc.list_candidates(status="pending"))) == 1


def test_gate_rejects_on_tie(tmp_path: Path):
    store = _make_store(tmp_path)
    _seed_traces(store, 8)
    # candidate scores the SAME as baseline (tie) → does not beat the margin
    svc = LearningService(store, make_good_llm(base_score=0.85, cand_score=0.85))

    result = asyncio.run(svc.run_cycle())

    assert result["status"] == "rejected"
    assert "below margin" in result["rationale"]
    assert asyncio.run(svc.list_candidates(status="pending")) == []


def test_gate_skips_low_evidence(tmp_path: Path):
    store = _make_store(tmp_path)
    _seed_traces(store, 2)  # 2 < learning_min_traces (5)
    svc = LearningService(store, make_good_llm())

    result = asyncio.run(svc.run_cycle())

    assert result["status"] == "skipped_low_evidence"
    # no candidate row was created
    assert asyncio.run(svc.list_candidates()) == []


def test_gate_skips_no_new_traces(tmp_path: Path):
    store = _make_store(tmp_path)
    _seed_traces(store, 8)
    svc = LearningService(store, make_good_llm())

    first = asyncio.run(svc.run_cycle())
    assert first["status"] in ("pending", "rejected")  # a candidate row now exists
    # no new traces since that candidate → second cycle is skipped
    second = asyncio.run(svc.run_cycle())
    assert second["status"] == "skipped_no_new"
    assert len(asyncio.run(svc.list_candidates())) == 1  # no extra row


def test_promote_creates_active_version(tmp_path: Path):
    store = _make_store(tmp_path)
    _seed_traces(store, 8)
    svc = LearningService(store, make_good_llm(base_score=0.80, cand_score=0.95))

    asyncio.run(svc.run_cycle())
    cid = asyncio.run(svc.list_candidates(status="pending"))[0]["id"]

    version = asyncio.run(svc.promote(cid))
    assert version >= 1

    active = asyncio.run(svc.get_active_policy())
    assert active["version"] == version
    assert active["behavior_addendum"] == "SENTINEL_GOOD"
    assert active["knobs"] == {}

    cand = asyncio.run(svc.get_candidate(cid))
    assert cand["status"] == "promoted"


def test_promote_then_rollback(tmp_path: Path):
    store = _make_store(tmp_path)
    _seed_traces(store, 8)
    svc = LearningService(store, make_addendum_llm("Addendum A"))

    svc._llm_call = make_addendum_llm("Addendum A")
    asyncio.run(svc.run_cycle())
    cid_a = asyncio.run(svc.list_candidates(status="pending"))[0]["id"]
    v1 = asyncio.run(svc.promote(cid_a))

    # New traces so the second cycle passes the novelty gate.
    _seed_traces(store, 4)
    svc._llm_call = make_addendum_llm("Addendum B")
    asyncio.run(svc.run_cycle())
    cid_b = asyncio.run(svc.list_candidates(status="pending"))[0]["id"]
    v2 = asyncio.run(svc.promote(cid_b))

    assert v2 > v1
    assert asyncio.run(svc.get_active_policy())["version"] == v2

    asyncio.run(svc.rollback(v1))
    active = asyncio.run(svc.get_active_policy())
    assert active["version"] == v1
    assert active["behavior_addendum"] == "Addendum A"


def test_reject_sets_status(tmp_path: Path):
    store = _make_store(tmp_path)
    _seed_traces(store, 8)
    svc = LearningService(store, make_good_llm(base_score=0.80, cand_score=0.95))

    asyncio.run(svc.run_cycle())
    cid = asyncio.run(svc.list_candidates(status="pending"))[0]["id"]

    asyncio.run(svc.reject(cid))
    assert asyncio.run(svc.get_candidate(cid))["status"] == "rejected"


def test_promote_non_pending_raises(tmp_path: Path):
    store = _make_store(tmp_path)
    _seed_traces(store, 8)
    svc = LearningService(store, make_good_llm(base_score=0.80, cand_score=0.95))

    asyncio.run(svc.run_cycle())
    cid = asyncio.run(svc.list_candidates(status="pending"))[0]["id"]
    asyncio.run(svc.reject(cid))

    with pytest.raises(ValueError):
        asyncio.run(svc.promote(cid))

    with pytest.raises(ValueError):
        asyncio.run(svc.promote("nonexistent"))


def test_ensure_eval_set_samples_traces(tmp_path: Path):
    store = _make_store(tmp_path)
    _seed_traces(store, 10)
    svc = LearningService(store, make_llm())

    count = asyncio.run(svc.ensure_eval_set(min_cases=8))
    assert count >= 8

    cases = asyncio.run(svc.list_eval_cases())
    assert len(cases) >= 8
