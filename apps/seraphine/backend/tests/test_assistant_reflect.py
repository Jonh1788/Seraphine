"""Tests for assistant-turn reflection (observations) — Item #3.

Verifies that reflect() runs two passes (user + assistant), each with
its own source tag, and that cross-pass dedup works via shared
existing_vecs.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, AsyncIterator

import pytest

from llm_adapters.types import ChatMessage, Token
from seraphine.memory import FakeEmbeddings, MemoryManager, MemoryStore
from seraphine.memory.manager import _FACTS_PROMPT, _ASSISTANT_INSIGHTS_PROMPT
from tests.test_memory_manager import FakeCollection


class _DualCannedLLM:
    """Returns different JSON depending on which prompt is in the system message."""

    def __init__(
        self,
        user_response: str,
        assistant_response: str,
    ) -> None:
        self._user_response = user_response
        self._assistant_response = assistant_response
        self.calls: list[list[ChatMessage]] = []

    async def chat(
        self,
        messages: list[ChatMessage],
        *,
        model: str | None = None,
        temperature: float = 0.7,
        **kwargs: Any,
    ) -> AsyncIterator[Token]:
        self.calls.append(messages)
        system = messages[0].content if messages else ""
        if "DURABLE OBSERVATIONS" in system.upper():
            raw = self._assistant_response
        else:
            raw = self._user_response
        for ch in raw:
            yield Token(text=ch, done=False)
        yield Token(text="", done=True)


async def _seed_turns(store: MemoryStore) -> str:
    """Seed a conversation with enough user + assistant turns."""
    conv_id = await store.create_conversation()
    turns = [
        ("user", "meu nome e Jonathan e moro em SP"),
        ("assistant", "Prazer Jonathan! Notei que voce parece preferir respostas diretas e objetivas, sem muita enrolacao. Vou manter esse tom."),
        ("user", "trabalho com infra cloud ha 8 anos"),
        ("assistant", "Legal! Percebi que voce tem um padrao de trabalhar em horarios noturnos, sempre pergunta coisas tecnicas depois das 22h."),
        ("user", "uso terraform e kubernetes no dia a dia"),
        ("assistant", "Show!"),  # too short, should be skipped
    ]
    for role, content in turns:
        await store.add_turn(conv_id, role, content)
    return conv_id


@pytest.fixture
async def store(tmp_path: Path) -> MemoryStore:
    s = MemoryStore(tmp_path / "reflect.sqlite")
    await s.ensure_schema()
    return s


async def test_both_passes_insert_facts(store: MemoryStore, tmp_path: Path) -> None:
    await _seed_turns(store)
    llm = _DualCannedLLM(
        user_response='{"facts": [{"text": "user is named Jonathan", "confidence": 0.9}]}',
        assistant_response='{"facts": [{"text": "user prefers late-night work sessions", "confidence": 0.85}]}',
    )
    mgr = MemoryManager(store, FakeEmbeddings(dim=8), tmp_path / "chroma", llm=llm)
    mgr.set_collection_for_tests(FakeCollection())

    inserted = await mgr.reflect()
    assert inserted == 2

    facts = await store.list_facts()
    by_source = {f.text: f.source for f in facts}
    assert by_source["user is named Jonathan"] == "reflection"
    assert by_source["user prefers late-night work sessions"] == "observation"


async def test_observation_confidence_capped(store: MemoryStore, tmp_path: Path) -> None:
    await _seed_turns(store)
    llm = _DualCannedLLM(
        user_response='{"facts": []}',
        assistant_response='{"facts": [{"text": "user is stressed", "confidence": 0.95}]}',
    )
    mgr = MemoryManager(store, FakeEmbeddings(dim=8), tmp_path / "chroma", llm=llm)
    mgr.set_collection_for_tests(FakeCollection())

    await mgr.reflect()
    facts = await store.list_facts()
    obs = [f for f in facts if f.source == "observation"]
    assert len(obs) == 1
    assert obs[0].confidence <= 0.7


async def test_cross_pass_dedup(store: MemoryStore, tmp_path: Path) -> None:
    """If both passes return semantically identical facts, only one is inserted."""
    await _seed_turns(store)
    # Same text from both passes -> FakeEmbeddings produces identical vectors
    same_fact = '{"facts": [{"text": "user works at night", "confidence": 0.8}]}'
    llm = _DualCannedLLM(
        user_response=same_fact,
        assistant_response=same_fact,
    )
    mgr = MemoryManager(store, FakeEmbeddings(dim=8), tmp_path / "chroma", llm=llm)
    mgr.set_collection_for_tests(FakeCollection())

    inserted = await mgr.reflect()
    # Pass 1 inserts it as "reflection"; pass 2 sees it as duplicate -> skip.
    assert inserted == 1
    facts = await store.list_facts()
    assert len(facts) == 1
    assert facts[0].source == "reflection"


async def test_short_assistant_turns_skipped(store: MemoryStore, tmp_path: Path) -> None:
    """Assistant turns < 40 chars should not reach the LLM."""
    conv_id = await store.create_conversation()
    # Only user turns long enough to pass, assistant turns all short
    for i in range(6):
        await store.add_turn(conv_id, "user", f"detalhe tecnico numero {i} sobre infra")
        await store.add_turn(conv_id, "assistant", "ok")

    llm = _DualCannedLLM(
        user_response='{"facts": [{"text": "user discusses infra details", "confidence": 0.8}]}',
        assistant_response='{"facts": [{"text": "SHOULD NOT APPEAR", "confidence": 0.9}]}',
    )
    mgr = MemoryManager(store, FakeEmbeddings(dim=8), tmp_path / "chroma", llm=llm)
    mgr.set_collection_for_tests(FakeCollection())

    await mgr.reflect()
    facts = await store.list_facts()
    texts = [f.text for f in facts]
    assert "SHOULD NOT APPEAR" not in texts
