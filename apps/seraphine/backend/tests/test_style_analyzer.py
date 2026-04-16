"""Tests for SDD 011-A: Communication Style Analyzer."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, AsyncIterator

import pytest

from llm_adapters.types import ChatMessage, Token
from seraphine.memory.store import MemoryStore
from seraphine.memory.style_analyzer import (
    STYLE_FACT_PREFIX,
    analyze_and_update_style,
    build_style_context,
    get_style_data,
)


@pytest.fixture
async def store(tmp_path: Path) -> MemoryStore:
    s = MemoryStore(tmp_path / "test.sqlite")
    await s.ensure_schema()
    return s


class FakeLLM:
    """Fake LLM that returns a canned style analysis JSON."""

    def __init__(self, response: str) -> None:
        self._response = response

    async def chat(
        self,
        messages: list[ChatMessage],
        *,
        model: str | None = None,
        temperature: float = 0.0,
        **kwargs: Any,
    ) -> AsyncIterator[Token]:
        yield Token(text=self._response)


class FailingLLM:
    """LLM that raises on every call."""

    async def chat(
        self,
        messages: list[ChatMessage],
        *,
        model: str | None = None,
        temperature: float = 0.0,
        **kwargs: Any,
    ) -> AsyncIterator[Token]:
        raise ConnectionError("LLM unavailable")
        yield  # make it a generator  # noqa: E501


# ---------------------------------------------------------------------------
# get_style_data — no data yet
# ---------------------------------------------------------------------------


async def test_get_style_data_empty(store: MemoryStore) -> None:
    result = await get_style_data(store)
    assert result is None


# ---------------------------------------------------------------------------
# analyze_and_update_style — happy path
# ---------------------------------------------------------------------------


async def test_analyze_happy_path(store: MemoryStore) -> None:
    # Seed enough user turns
    conv_id = await store.create_conversation()
    for i in range(10):
        await store.add_turn(conv_id, "user", f"mensagem de teste numero {i} com conteudo")
        await store.add_turn(conv_id, "assistant", f"resposta {i}")

    style_json = json.dumps({
        "formality": "informal",
        "humor": "sarcastic",
        "energy": "energetic",
        "directness": "direct",
        "language_quirks": "usa girias e abreviacoes",
    })
    llm = FakeLLM(style_json)

    result = await analyze_and_update_style(store, llm)
    assert result is not None
    assert result["formality"] == "informal"
    assert result["humor"] == "sarcastic"

    # Verify stored in facts
    stored = await get_style_data(store)
    assert stored is not None
    assert stored["formality"] == "informal"


async def test_analyze_updates_existing(store: MemoryStore) -> None:
    """Second analysis should supersede the first fact."""
    conv_id = await store.create_conversation()
    for i in range(10):
        await store.add_turn(conv_id, "user", f"mensagem teste {i} conteudo longo")
        await store.add_turn(conv_id, "assistant", f"resposta {i}")

    # First analysis
    style1 = json.dumps({
        "formality": "formal",
        "humor": "none",
        "energy": "calm",
        "directness": "verbose",
        "language_quirks": "",
    })
    await analyze_and_update_style(store, FakeLLM(style1))

    # Second analysis (different style)
    style2 = json.dumps({
        "formality": "very_informal",
        "humor": "playful",
        "energy": "energetic",
        "directness": "direct",
        "language_quirks": "muitas abreviacoes",
    })
    await analyze_and_update_style(store, FakeLLM(style2))

    stored = await get_style_data(store)
    assert stored is not None
    assert stored["formality"] == "very_informal"

    # Only one non-superseded style fact should exist
    facts = await store.list_facts(limit=100)
    style_facts = [f for f in facts if f.text.startswith(STYLE_FACT_PREFIX)]
    assert len(style_facts) == 1


# ---------------------------------------------------------------------------
# analyze — not enough data
# ---------------------------------------------------------------------------


async def test_analyze_insufficient_data(store: MemoryStore) -> None:
    # Only 2 turns — not enough
    conv_id = await store.create_conversation()
    await store.add_turn(conv_id, "user", "oi, tudo bem?")
    await store.add_turn(conv_id, "assistant", "oi!")

    llm = FakeLLM("{}")
    result = await analyze_and_update_style(store, llm)
    assert result is None


# ---------------------------------------------------------------------------
# analyze — LLM failure
# ---------------------------------------------------------------------------


async def test_analyze_llm_failure(store: MemoryStore) -> None:
    conv_id = await store.create_conversation()
    for i in range(10):
        await store.add_turn(conv_id, "user", f"mensagem longa de teste {i} conteudo")

    result = await analyze_and_update_style(store, FailingLLM())
    assert result is None


# ---------------------------------------------------------------------------
# analyze — invalid JSON from LLM
# ---------------------------------------------------------------------------


async def test_analyze_invalid_json(store: MemoryStore) -> None:
    conv_id = await store.create_conversation()
    for i in range(10):
        await store.add_turn(conv_id, "user", f"mensagem longa teste {i} conteudo")

    llm = FakeLLM("sorry, I can't do that")
    result = await analyze_and_update_style(store, llm)
    assert result is None


# ---------------------------------------------------------------------------
# build_style_context
# ---------------------------------------------------------------------------


async def test_build_style_context_empty(store: MemoryStore) -> None:
    ctx = await build_style_context(store)
    assert ctx == ""


async def test_build_style_context_with_data(store: MemoryStore) -> None:
    # Manually insert a style fact
    style = {
        "formality": "informal",
        "humor": "sarcastic",
        "energy": "energetic",
        "directness": "direct",
        "language_quirks": "usa girias",
    }
    fact_text = STYLE_FACT_PREFIX + json.dumps(style)
    await store.add_fact(text=fact_text, source="reflection", confidence=0.8)

    ctx = await build_style_context(store)
    assert "informal" in ctx
    assert "sarcastic" in ctx
    assert "energetic" in ctx
    assert "usa girias" in ctx
    assert "Match this energy" in ctx


async def test_build_style_context_no_humor(store: MemoryStore) -> None:
    """When humor is 'none', it should not appear in the description."""
    style = {
        "formality": "formal",
        "humor": "none",
        "energy": "calm",
        "directness": "conversational",
        "language_quirks": "",
    }
    fact_text = STYLE_FACT_PREFIX + json.dumps(style)
    await store.add_fact(text=fact_text, source="reflection", confidence=0.8)

    ctx = await build_style_context(store)
    assert "formal" in ctx
    assert "none" not in ctx  # humor:"none" should be skipped
