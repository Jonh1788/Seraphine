"""Untrusted-framing + "do not volunteer" guard on injected memory (Task 4).

Injected memory (RAG-retrieved facts + conversation excerpts) is
user-derived / possibly-stale text. The model used to treat it as plain
trusted context, which caused over-eager recall (volunteering memories
off-topic) and is a prompt-injection surface (stored text could carry
instructions). The fix wraps the *retrieved* portion of
``_build_recall_block`` in an untrusted-content envelope with a guard
sentence ("use only if the user's message is about these topics").

IMPORTANT nuance: the pinned "Core facts about the user" block (Task 1)
is always-on IDENTITY grounding. It STAYS outside the untrusted frame and
must NOT carry the "do not volunteer" caveat — the assistant should always
know the user's name/location.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, AsyncIterator
from unittest.mock import AsyncMock, MagicMock

import pytest

from llm_adapters.types import Token
from seraphine.conversation.engine import (
    MEMORY_CONTEXT_BEGIN,
    MEMORY_CONTEXT_END,
    MEMORY_CONTEXT_GUARD,
    ConversationEngine,
)
from seraphine.memory.store import MemoryStore


# ---------------------------------------------------------------------------
# Test doubles
# ---------------------------------------------------------------------------


class _StubLLM:
    """Minimal LLM stub; async iterator over chunks (unused by recall)."""

    def __init__(self, chunks: list[str] | None = None) -> None:
        self._chunks = chunks or [""]

    async def chat(
        self,
        messages: list[Any],
        *,
        model: str | None = None,
        temperature: float = 0.7,
        **kwargs: Any,
    ) -> AsyncIterator[Token]:
        for c in self._chunks:
            yield Token(text=c, done=False)
        yield Token(text="", done=True)


class _Item:
    """Duck-typed stand-in for a Fact / Memory (only ``.text`` is read)."""

    def __init__(self, text: str, id: str = "") -> None:
        self.text = text
        self.id = id


async def _make_store(tmp_path: Path, name: str) -> MemoryStore:
    store = MemoryStore(tmp_path / name)
    await store.ensure_schema()
    return store


def _engine(
    store: MemoryStore,
    *,
    pinned: list[_Item],
    relevant: list[_Item],
    recalled: list[_Item],
) -> ConversationEngine:
    """Build an engine whose memory returns the three injection sources."""
    fake_memory = MagicMock()
    fake_memory.recall = AsyncMock(return_value=recalled)
    fake_memory.store = MagicMock()
    fake_memory.store.list_facts = AsyncMock(return_value=relevant)
    fake_memory.store.list_pinned_facts = AsyncMock(return_value=pinned)
    return ConversationEngine(llm=_StubLLM(), store=store, memory=fake_memory)


# ---------------------------------------------------------------------------
# 1. Pinned "Core facts" block is always-on and NOT framed / NOT caveated.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_pinned_core_facts_not_wrapped_in_untrusted_frame(
    tmp_path: Path,
) -> None:
    store = await _make_store(tmp_path, "framing_pinned.sqlite")
    engine = _engine(
        store,
        pinned=[_Item("usuário chama João", "p1")],
        relevant=[_Item("prefere chá verde", "r1")],
        recalled=[_Item("falou sobre a viagem a Lisboa")],
    )

    block = await engine._build_recall_block("oi")
    assert block is not None

    core_header = "Core facts about the user (always true):"
    assert core_header in block
    assert "usuário chama João" in block

    # The pinned identity line must sit BEFORE the untrusted frame opens —
    # i.e. outside the envelope, as always-on grounding.
    core_idx = block.index("usuário chama João")
    begin_idx = block.index(MEMORY_CONTEXT_BEGIN)
    assert core_idx < begin_idx, (
        "pinned identity facts must appear before the untrusted frame"
    )

    # And the core block must NOT carry the do-not-volunteer caveat.
    pre_frame = block[:begin_idx]
    assert MEMORY_CONTEXT_GUARD not in pre_frame
    assert "do not" not in pre_frame.lower()


# ---------------------------------------------------------------------------
# 2. Retrieved block IS wrapped + carries the do-not-volunteer guard.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_retrieved_block_is_framed_and_guarded(tmp_path: Path) -> None:
    store = await _make_store(tmp_path, "framing_retrieved.sqlite")
    engine = _engine(
        store,
        pinned=[_Item("usuário chama João", "p1")],
        relevant=[_Item("prefere chá verde", "r1")],
        recalled=[_Item("falou sobre a viagem a Lisboa")],
    )

    block = await engine._build_recall_block("oi")
    assert block is not None

    assert MEMORY_CONTEXT_BEGIN in block
    assert MEMORY_CONTEXT_END in block
    assert MEMORY_CONTEXT_GUARD in block

    begin_idx = block.index(MEMORY_CONTEXT_BEGIN)
    end_idx = block.index(MEMORY_CONTEXT_END)
    assert begin_idx < end_idx

    framed = block[begin_idx:end_idx]
    # The retrieved facts + excerpts live INSIDE the envelope.
    assert "The following facts about the user may be relevant:" in framed
    assert "prefere chá verde" in framed
    assert "Recent related conversation excerpts:" in framed
    assert "falou sobre a viagem a Lisboa" in framed

    # The guard's intent: use only when the message is about these topics.
    guard_lower = MEMORY_CONTEXT_GUARD.lower()
    assert "only" in guard_lower
    assert "do not volunteer" in guard_lower


# ---------------------------------------------------------------------------
# 3. Pinned-only: core block, no dangling untrusted frame.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_pinned_only_has_no_dangling_frame(tmp_path: Path) -> None:
    store = await _make_store(tmp_path, "framing_pinned_only.sqlite")
    engine = _engine(
        store,
        pinned=[_Item("usuário chama João", "p1")],
        relevant=[],
        recalled=[],
    )

    block = await engine._build_recall_block("oi")
    assert block is not None

    assert "Core facts about the user (always true):" in block
    assert "usuário chama João" in block
    # No retrieved content → no envelope and no guard.
    assert MEMORY_CONTEXT_BEGIN not in block
    assert MEMORY_CONTEXT_END not in block
    assert MEMORY_CONTEXT_GUARD not in block


# ---------------------------------------------------------------------------
# 4. Retrieved-only (no pinned): frame + guard present, no core block.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_retrieved_only_has_frame_and_guard(tmp_path: Path) -> None:
    store = await _make_store(tmp_path, "framing_retrieved_only.sqlite")
    engine = _engine(
        store,
        pinned=[],
        relevant=[_Item("prefere chá verde", "r1")],
        recalled=[_Item("falou sobre a viagem a Lisboa")],
    )

    block = await engine._build_recall_block("oi")
    assert block is not None

    assert "Core facts about the user (always true):" not in block
    assert MEMORY_CONTEXT_BEGIN in block
    assert MEMORY_CONTEXT_END in block
    assert MEMORY_CONTEXT_GUARD in block
    assert "prefere chá verde" in block
    assert "falou sobre a viagem a Lisboa" in block


# ---------------------------------------------------------------------------
# 5. The frame instructs the model to treat enclosed text as data, not
#    instructions (anti-prompt-injection), matching codebase wording.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_frame_marks_content_as_data_not_instructions(
    tmp_path: Path,
) -> None:
    store = await _make_store(tmp_path, "framing_data.sqlite")
    engine = _engine(
        store,
        pinned=[],
        relevant=[_Item("prefere chá verde", "r1")],
        recalled=[],
    )

    block = await engine._build_recall_block("oi")
    assert block is not None

    begin_lower = MEMORY_CONTEXT_BEGIN.lower()
    assert "untrusted" in begin_lower
    # Treat as data, not instructions — same intent as deepsearch's
    # UNTRUSTED_RULE ("DADO, não instrução").
    assert "data" in begin_lower
    assert "instruction" in begin_lower
