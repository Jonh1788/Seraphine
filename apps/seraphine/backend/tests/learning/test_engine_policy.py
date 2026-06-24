"""Task 7: active-policy injection + knob application in the chat engine.

Covers the two seams wired this task:
  - the router threshold param (classify_complexity long_prompt_chars), and
  - the engine's guarded per-turn policy refresh + computed effective knobs.

Engine assertions stay lightweight on purpose — we exercise the guarded
_refresh_active_policy path and the knob plumbing, NOT a full turn.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, AsyncIterator

import pytest

from llm_adapters.types import ChatMessage, Token
from seraphine.conversation.engine import ConversationEngine
from seraphine.learning.knobs import effective_knobs
from seraphine.routing.router import RouteInputs, classify_complexity
from seraphine.memory.store import MemoryStore


# ---------------------------------------------------------------------------
# Part A — router threshold param
# ---------------------------------------------------------------------------


def test_classify_default_threshold_keeps_500char_simple() -> None:
    # 500 chars < default 1500 → simple (no tool iterations, no think/images).
    inp = RouteInputs(prompt="x" * 500, think=False, has_images=False, tool_iteration=0)
    assert classify_complexity(inp) == "simple"


def test_classify_lowered_threshold_makes_500char_complex() -> None:
    inp = RouteInputs(prompt="x" * 500, think=False, has_images=False, tool_iteration=0)
    assert classify_complexity(inp, long_prompt_chars=400) == "complex"


def test_classify_threshold_is_inclusive() -> None:
    # len == threshold is treated as complex (>=).
    inp = RouteInputs(prompt="x" * 400, think=False, has_images=False, tool_iteration=0)
    assert classify_complexity(inp, long_prompt_chars=400) == "complex"
    assert classify_complexity(inp, long_prompt_chars=401) == "simple"


# ---------------------------------------------------------------------------
# Part B — engine knob threading + guarded policy refresh
# ---------------------------------------------------------------------------


class _FakeLLM:
    async def chat(
        self,
        messages: list[ChatMessage],
        *,
        model: str | None = None,
        temperature: float = 0.7,
        **kwargs: Any,
    ) -> AsyncIterator[Token]:
        yield Token(text="", done=True)


async def _build_engine(tmp_path: Path) -> ConversationEngine:
    store = MemoryStore(tmp_path / "t.sqlite")
    await store.ensure_schema()
    return ConversationEngine(_FakeLLM(), store)


def test_effective_knobs_can_be_set_on_engine(tmp_path: Path) -> None:
    import asyncio

    engine = asyncio.run(_build_engine(tmp_path))
    engine._effective_knobs = {
        "recall_fact_limit": 7,
        "recall_enabled": True,
        "smart_escalation_prompt_chars": 400,
    }
    assert engine._effective_knobs["recall_fact_limit"] == 7
    assert engine._effective_knobs["smart_escalation_prompt_chars"] == 400


@pytest.mark.asyncio
async def test_refresh_active_policy_guarded_default_when_no_service(
    tmp_path: Path,
) -> None:
    engine = await _build_engine(tmp_path)
    engine._learning_service = None

    await engine._refresh_active_policy()

    assert engine._active_policy_cache == {
        "version": 0,
        "behavior_addendum": "",
        "tool_guidance": "",
        "knobs": {},
    }
    # No active overrides → all knob defaults.
    assert engine._effective_knobs == effective_knobs({})


@pytest.mark.asyncio
async def test_refresh_active_policy_swallows_service_error(tmp_path: Path) -> None:
    engine = await _build_engine(tmp_path)

    class _BoomService:
        async def get_active_policy(self) -> dict:
            raise RuntimeError("db down")

    engine._learning_service = _BoomService()

    # Must not raise — falls back to the empty-policy defaults.
    await engine._refresh_active_policy()

    assert engine._active_policy_cache["version"] == 0
    assert engine._effective_knobs == effective_knobs({})


@pytest.mark.asyncio
async def test_refresh_active_policy_applies_service_knobs(tmp_path: Path) -> None:
    engine = await _build_engine(tmp_path)

    class _Service:
        async def get_active_policy(self) -> dict:
            return {
                "version": 3,
                "behavior_addendum": "be terse",
                "tool_guidance": "prefer the calendar tool",
                "knobs": {"recall_fact_limit": 7, "recall_enabled": False},
            }

    engine._learning_service = _Service()

    await engine._refresh_active_policy()

    assert engine._active_policy_cache["version"] == 3
    assert engine._active_policy_cache["behavior_addendum"] == "be terse"
    # Knobs are computed via effective_knobs (defaults overlaid w/ clamped).
    assert engine._effective_knobs["recall_fact_limit"] == 7
    assert engine._effective_knobs["recall_enabled"] is False
    # Untouched knob falls back to its default.
    assert engine._effective_knobs["smart_escalation_prompt_chars"] == 1500


@pytest.mark.asyncio
async def test_recall_block_disabled_by_knob(tmp_path: Path) -> None:
    engine = await _build_engine(tmp_path)
    # memory is None on this minimal engine, but the knob gate is checked
    # after the memory guard; set a sentinel memory to reach it.
    engine.memory = object()
    engine._effective_knobs = {"recall_enabled": False}

    assert await engine._build_recall_block("hi") is None
