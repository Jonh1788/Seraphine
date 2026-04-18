"""Tests for contradiction detection + auto-supersede (Item D / task #12).

When reflect() inserts a new fact whose embedding has moderate cosine
(in [0.5, 0.92)) with an existing fact, the LLM is asked whether the
new fact contradicts (updates) the old one. Confirmed contradictions
supersede the old fact.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any, AsyncIterator

import pytest

from llm_adapters.types import ChatMessage, Token
from seraphine.memory import FakeEmbeddings, MemoryManager, MemoryStore
from seraphine.memory.manager import REFLECTION_SIM_THRESHOLD
from tests.test_memory_manager import FakeCollection


class _ControlledEmbeddings:
    """Embeddings that return pre-configured vectors per text key,
    falling back to FakeEmbeddings for unknown texts."""

    def __init__(self, mapping: dict[str, list[float]], dim: int = 8) -> None:
        self._mapping = mapping
        self._fallback = FakeEmbeddings(dim=dim)

    async def embed(self, texts: list[str]) -> list[list[float]]:
        out: list[list[float]] = []
        for t in texts:
            if t in self._mapping:
                out.append(self._mapping[t])
            else:
                vecs = await self._fallback.embed([t])
                out.append(vecs[0])
        return out


def _make_vec(angle: float, dim: int = 8) -> list[float]:
    """Create a unit vector at a given angle in the first two dimensions."""
    v = [0.0] * dim
    v[0] = math.cos(angle)
    v[1] = math.sin(angle)
    return v


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a)) or 1.0
    nb = math.sqrt(sum(x * x for x in b)) or 1.0
    return dot / (na * nb)


# Vectors chosen so cosine("user mora em SP", "user mudou pro Rio") = ~0.7
# which is in [0.5, 0.92) — the contradiction candidate range.
_VEC_SP = _make_vec(0.0)        # [1, 0, 0, ...]
_VEC_RIO = _make_vec(0.78)      # cos(0.78) ~= 0.71

# Verify our vectors are in the right range.
assert 0.5 < _cosine(_VEC_SP, _VEC_RIO) < REFLECTION_SIM_THRESHOLD


class _ContradictionLLM:
    """LLM that returns a new fact on the first call (extraction pass),
    and a contradiction JSON on the second call (contradiction check)."""

    def __init__(self, existing_id: str) -> None:
        self._existing_id = existing_id
        self.call_count = 0

    async def chat(
        self,
        messages: list[ChatMessage],
        *,
        model: str | None = None,
        temperature: float = 0.7,
        **kwargs: Any,
    ) -> AsyncIterator[Token]:
        self.call_count += 1
        sys_content = messages[0].content if messages else ""
        if "CONTRADICTS" in sys_content:
            # Contradiction check call — report the pair as contradictory.
            response = (
                '{"contradictions": [{"existing_id": "'
                + self._existing_id
                + '", "new_index": 0, "reason": "moved"}]}'
            )
        elif "DURABLE OBSERVATIONS" in sys_content.upper():
            # Assistant observation pass — no facts.
            response = '{"facts": []}'
        else:
            # User extraction pass — return the new fact.
            response = '{"facts": [{"text": "user mudou pro Rio", "confidence": 0.9}]}'
        for ch in response:
            yield Token(text=ch, done=False)
        yield Token(text="", done=True)


@pytest.fixture
async def store(tmp_path: Path) -> MemoryStore:
    s = MemoryStore(tmp_path / "contra.sqlite")
    await s.ensure_schema()
    return s


async def test_contradiction_supersedes_old_fact(
    store: MemoryStore, tmp_path: Path,
) -> None:
    """A new fact that contradicts an old one should supersede it."""
    # Seed enough turns so reflect() proceeds.
    conv_id = await store.create_conversation()
    for i in range(10):
        role = "user" if i % 2 == 0 else "assistant"
        content = (
            f"detalhe {i} sobre mudanca de cidade para o Rio de Janeiro"
            if role == "user"
            else f"entendi, vou atualizar suas informacoes de localizacao {i}"
        )
        await store.add_turn(conv_id, role, content)

    # Controlled embeddings: known vectors for the two key texts.
    emb = _ControlledEmbeddings({
        "user mora em SP": _VEC_SP,
        "user mudou pro Rio": _VEC_RIO,
    })

    # Pre-seed the existing fact via store + cache.
    existing_fact = await store.add_fact(
        "user mora em SP", source="reflection", confidence=0.85,
    )

    llm = _ContradictionLLM(existing_id=existing_fact.id)
    mgr = MemoryManager(
        store, emb, tmp_path / "chroma", llm=llm,
        embedding_model="test",
    )
    mgr.set_collection_for_tests(FakeCollection())
    # Seed the embedding cache for the existing fact.
    mgr._fact_embedding_cache[existing_fact.id] = _VEC_SP

    inserted = await mgr.reflect()
    assert inserted >= 1

    # The old fact should now be superseded.
    old = await store.get_fact(existing_fact.id)
    assert old is not None
    assert old.superseded_by is not None
    # The superseded_by should point to the new "Rio" fact.
    new_fact = await store.get_fact(old.superseded_by)
    assert new_fact is not None
    assert "Rio" in new_fact.text


async def test_no_contradiction_when_unrelated(
    store: MemoryStore, tmp_path: Path,
) -> None:
    """Facts with low cosine (< 0.5) should not trigger contradiction check."""
    conv_id = await store.create_conversation()
    for i in range(10):
        role = "user" if i % 2 == 0 else "assistant"
        await store.add_turn(
            conv_id, role,
            f"conversa generica sobre programacao e arquitetura de sistemas {i}",
        )

    # Two completely unrelated facts.
    existing_fact = await store.add_fact(
        "user gosta de pizza", source="reflection", confidence=0.9,
    )

    # LLM that would report contradictions if called — but shouldn't be.
    call_tracker: list[str] = []

    class _NoContradictionLLM:
        async def chat(
            self, messages: list[ChatMessage], *, model: str | None = None,
            temperature: float = 0.7, **kwargs: Any,
        ) -> AsyncIterator[Token]:
            sys = messages[0].content if messages else ""
            call_tracker.append(sys[:40])
            if "CONTRADICTS" in sys:
                # Should not be reached.
                response = '{"contradictions": [{"existing_id": "xxx", "new_index": 0, "reason": "test"}]}'
            elif "DURABLE OBSERVATIONS" in sys.upper():
                response = '{"facts": []}'
            else:
                response = '{"facts": [{"text": "user trabalha com Go", "confidence": 0.8}]}'
            for ch in response:
                yield Token(text=ch, done=False)
            yield Token(text="", done=True)

    mgr = MemoryManager(
        store, FakeEmbeddings(dim=8), tmp_path / "chroma",
        llm=_NoContradictionLLM(),
    )
    mgr.set_collection_for_tests(FakeCollection())
    mgr._fact_embedding_cache[existing_fact.id] = (
        await FakeEmbeddings(dim=8).embed(["user gosta de pizza"])
    )[0]

    await mgr.reflect()
    # The contradiction prompt should NOT have been called.
    contradiction_calls = [c for c in call_tracker if "CONTRADICTS" in c]
    assert len(contradiction_calls) == 0

    # Old fact should NOT be superseded.
    old = await store.get_fact(existing_fact.id)
    assert old is not None
    assert old.superseded_by is None
