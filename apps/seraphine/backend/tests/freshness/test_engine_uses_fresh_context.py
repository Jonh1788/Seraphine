"""Per-turn engine context blocks must use fresh_only=True.

The conversation engine assembles a context bundle on every user turn
that goes into the LLM prompt:

  - open_loops block       (OpenLoopsService.prompt_block)
  - recall block            (ConversationEngine._build_recall_block,
                             which calls memory.store.list_facts)
  - user profile summary    (UserProfile.get_profile_summary, which
                             reads a cache rebuilt by .rebuild() /
                             .rebuild_if_stale() — those rebuilds read
                             list_facts and must opt into fresh_only)

Each of these helpers is single-purpose (only the engine's context
builder consumes them in this code path), so we hardcode
``fresh_only=True`` inside the helper rather than threading a kwarg
through every layer.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, AsyncIterator
from unittest.mock import AsyncMock, MagicMock

import pytest

from llm_adapters.types import ChatMessage, Token
from seraphine.conversation.engine import ConversationEngine
from seraphine.memory.open_loops import OpenLoopsService
from seraphine.memory.profile import UserProfile
from seraphine.memory.store import MemoryStore


# ---------------------------------------------------------------------------
# Test doubles
# ---------------------------------------------------------------------------


class _StubLLM:
    """Minimal LLM stub; async iterator over chunks."""

    def __init__(self, chunks: list[str] | None = None) -> None:
        self._chunks = chunks or [""]

    async def chat(
        self,
        messages: list[ChatMessage],
        *,
        model: str | None = None,
        temperature: float = 0.7,
        **kwargs: Any,
    ) -> AsyncIterator[Token]:
        for c in self._chunks:
            yield Token(text=c, done=False)
        yield Token(text="", done=True)


# ---------------------------------------------------------------------------
# 1. open_loops.prompt_block — uses fresh_only=True
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_open_loops_prompt_block_uses_fresh_only() -> None:
    """OpenLoopsService.prompt_block must call list_open_loops with
    fresh_only=True so per-turn loop injection never surfaces stale
    debts."""
    spy = AsyncMock(return_value=[])
    fake_store = MagicMock()
    fake_store.list_open_loops = spy
    fake_store.bump_open_loop_injection = AsyncMock()
    fake_store.resolve_open_loop = AsyncMock()

    svc = OpenLoopsService(fake_store, llm=None)
    await svc.prompt_block()

    assert spy.await_count >= 1, "list_open_loops was not awaited"
    fresh_call = any(
        call.kwargs.get("fresh_only") is True
        for call in spy.call_args_list
    )
    assert fresh_call, (
        "OpenLoopsService.prompt_block did not pass fresh_only=True to "
        f"list_open_loops. Calls: {spy.call_args_list}"
    )


# ---------------------------------------------------------------------------
# 2. ConversationEngine._build_recall_block — list_facts with fresh_only=True
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_engine_recall_block_uses_fresh_only_facts(
    tmp_path: Path,
) -> None:
    """The engine's recall_block must request fresh-only facts so a
    confabulated stale fact never leaks back into mid-conversation
    context."""
    store = MemoryStore(tmp_path / "engine_recall.sqlite")
    await store.ensure_schema()

    # MemoryManager-like double — recall returns nothing; the store
    # itself is the spy.
    fake_memory = MagicMock()
    fake_memory.recall = AsyncMock(return_value=[])
    spy_list_facts = AsyncMock(return_value=[])
    fake_memory.store = MagicMock()
    fake_memory.store.list_facts = spy_list_facts

    engine = ConversationEngine(
        llm=_StubLLM(), store=store, memory=fake_memory,
    )
    await engine._build_recall_block("oi")

    assert spy_list_facts.await_count >= 1, "list_facts was not awaited"
    fresh_call = any(
        call.kwargs.get("fresh_only") is True
        for call in spy_list_facts.call_args_list
    )
    assert fresh_call, (
        "ConversationEngine._build_recall_block did not pass fresh_only=True "
        f"to list_facts. Calls: {spy_list_facts.call_args_list}"
    )


@pytest.mark.asyncio
async def test_engine_recall_block_uses_fresh_only_vector_recall(
    tmp_path: Path,
) -> None:
    """The engine's recall_block must call ``memory.recall(..., fresh_only=
    True)`` so the vector pipeline applies the recency cutoff (Task 10).
    Without this, months-old chat snippets can resurface as "relevant
    excerpts" in mid-conversation context."""
    store = MemoryStore(tmp_path / "engine_recall_vec.sqlite")
    await store.ensure_schema()

    spy_recall = AsyncMock(return_value=[])
    fake_memory = MagicMock()
    fake_memory.recall = spy_recall
    fake_memory.store = MagicMock()
    fake_memory.store.list_facts = AsyncMock(return_value=[])

    engine = ConversationEngine(
        llm=_StubLLM(), store=store, memory=fake_memory,
    )
    await engine._build_recall_block("oi")

    assert spy_recall.await_count >= 1, "memory.recall was not awaited"
    fresh_call = any(
        call.kwargs.get("fresh_only") is True
        for call in spy_recall.call_args_list
    )
    assert fresh_call, (
        "ConversationEngine._build_recall_block did not pass fresh_only=True "
        f"to memory.recall. Calls: {spy_recall.call_args_list}"
    )


# ---------------------------------------------------------------------------
# 3. UserProfile rebuilds — list_facts with fresh_only=True
# ---------------------------------------------------------------------------
#
# get_profile_summary() itself reads a cache (get_cached) — it does
# not call list_facts directly. The cache is populated by rebuild()
# and rebuild_if_stale(), which are the calls the engine ticks. For
# the injected profile to reflect fresh facts, those rebuilds must
# opt into fresh_only=True.


class _LLMNoOp:
    """An LLM stub that returns an empty stream — rebuild() will bail
    early via the JSON-parse failure path but still get past the
    list_facts call we want to assert on."""

    async def chat(
        self,
        messages: list[ChatMessage],
        *,
        model: str | None = None,
        temperature: float = 0.7,
        **kwargs: Any,
    ) -> AsyncIterator[Token]:
        yield Token(text="", done=True)


@pytest.mark.asyncio
async def test_profile_rebuild_uses_fresh_only_facts() -> None:
    """UserProfile.rebuild must request fresh-only facts so the cached
    profile feeding get_profile_summary stays free of stale priors."""
    # rebuild() bails early if list_facts returns [] (no LLM call needed)
    # via the set_user_profile({}, 0) branch — so empty is fine.
    spy = AsyncMock(return_value=[])
    fake_store = MagicMock()
    fake_store.list_facts = spy
    fake_store.set_user_profile = AsyncMock()

    profile = UserProfile(fake_store, llm=_LLMNoOp())
    await profile.rebuild()

    assert spy.await_count >= 1
    fresh_call = any(
        call.kwargs.get("fresh_only") is True
        for call in spy.call_args_list
    )
    assert fresh_call, (
        "UserProfile.rebuild did not pass fresh_only=True to list_facts. "
        f"Calls: {spy.call_args_list}"
    )


@pytest.mark.asyncio
async def test_profile_rebuild_if_stale_uses_fresh_only_facts() -> None:
    """rebuild_if_stale also reads list_facts (to compute the staleness
    counter) — that call must opt into fresh_only too, otherwise its
    fact_count would include facts the rebuild itself would drop, and
    the cache would never appear 'stale' relative to its own input."""
    spy = AsyncMock(return_value=[])
    fake_store = MagicMock()
    fake_store.list_facts = spy
    fake_store.get_user_profile = AsyncMock(return_value=None)
    fake_store.set_user_profile = AsyncMock()

    profile = UserProfile(fake_store, llm=_LLMNoOp())
    await profile.rebuild_if_stale()

    assert spy.await_count >= 1
    fresh_call = any(
        call.kwargs.get("fresh_only") is True
        for call in spy.call_args_list
    )
    assert fresh_call, (
        "UserProfile.rebuild_if_stale did not pass fresh_only=True to "
        f"list_facts. Calls: {spy.call_args_list}"
    )
