"""Tests for the planning LLM-polish pass (SDD 093).

Focus: the injected LLM is now actually used to write the plan summary and
focus-block reasons, and the plan is only flagged ``ai_generated`` when a real
model pass produced output. Heuristic-only plans must NOT claim AI authorship.
"""

from __future__ import annotations

import json

import pytest
import pytest_asyncio

from core_db import Store
from llm_adapters.types import Token

from seraphine.planning import schema as planning_schema
from seraphine.planning.service import PlanningService


class _FakeLLM:
    """Minimal stand-in matching the ``chat()`` streaming contract."""

    def __init__(self, payload: str | None, *, raise_exc: bool = False) -> None:
        self._payload = payload
        self._raise = raise_exc
        self.calls = 0

    async def chat(self, messages, *, temperature=0.7, **kwargs):
        self.calls += 1
        if self._raise:
            raise RuntimeError("boom")
        # Stream the payload in two chunks, terminated by a done token.
        text = self._payload or ""
        mid = len(text) // 2
        yield Token(text=text[:mid], done=False)
        yield Token(text=text[mid:], done=False)
        yield Token(text="", done=True)


@pytest_asyncio.fixture
async def store(tmp_path):
    s = Store(tmp_path / "planning.sqlite")
    s.register_migrator("seraphine_planning", planning_schema.migrate)
    await s.ensure_schema()
    yield s
    await s.aclose()


@pytest.mark.asyncio
async def test_no_llm_keeps_heuristic_and_flags_not_ai(store):
    """Without an LLM the plan is heuristic and ai_generated stays False."""
    svc = PlanningService(store, llm=None)
    plan = await svc.generate_plan()
    assert plan.context.ai_generated is False
    assert plan.context.summary is None
    # Focus blocks still carry a real heuristic reason (never empty/static).
    focus = [b for b in plan.time_blocks if b.type == "focus"]
    assert focus, "expected at least one heuristic focus block"
    assert all(b.reason for b in focus)


@pytest.mark.asyncio
async def test_llm_polish_sets_summary_reasons_and_flag(store):
    payload = json.dumps(
        {
            "summary": "Separei tempo de foco hoje. Aplico?",
            "focus_reasons": ["Manha protegida para o projeto"],
        }
    )
    llm = _FakeLLM(payload)
    svc = PlanningService(store, llm=llm)
    plan = await svc.generate_plan()

    assert llm.calls == 1
    assert plan.context.ai_generated is True
    assert plan.context.summary == "Separei tempo de foco hoje. Aplico?"
    # First focus block reason should come from the model.
    focus = [b for b in plan.time_blocks if b.type == "focus"]
    assert focus[0].reason == "Manha protegida para o projeto"


@pytest.mark.asyncio
async def test_llm_failure_falls_back_to_heuristic(store):
    llm = _FakeLLM(None, raise_exc=True)
    svc = PlanningService(store, llm=llm)
    plan = await svc.generate_plan()
    assert llm.calls == 1
    assert plan.context.ai_generated is False
    assert plan.context.summary is None


@pytest.mark.asyncio
async def test_llm_unparseable_output_does_not_claim_ai(store):
    llm = _FakeLLM("not json at all <think>hmm</think>")
    svc = PlanningService(store, llm=llm)
    plan = await svc.generate_plan()
    assert plan.context.ai_generated is False
    assert plan.context.summary is None


@pytest.mark.asyncio
async def test_llm_strips_think_and_code_fence(store):
    payload = (
        "<think>let me reason</think>```json\n"
        + json.dumps({"summary": "Foco garantido. Aplico?", "focus_reasons": []})
        + "\n```"
    )
    llm = _FakeLLM(payload)
    svc = PlanningService(store, llm=llm)
    plan = await svc.generate_plan()
    assert plan.context.ai_generated is True
    assert plan.context.summary == "Foco garantido. Aplico?"
