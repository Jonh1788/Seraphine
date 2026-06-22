"""Scheduled whole-store consolidation/audit job (Task 2).

``MemoryManager.audit()`` is a periodic, whole-store complement to the
per-write dedup. It asks the LLM to propose paraphrase merges and junk
drops across ALL active facts, with two safety mechanisms:

  1. a sha256 fingerprint short-circuit that skips the LLM entirely when
     the active fact set is unchanged since the last successful run, and
  2. a runaway guard that refuses any proposal whose total removals
     (merges + drops) exceed 50% of the active facts.

Merges preserve history via ``supersede_fact`` (the dropped fact's row
stays, marked superseded); junk drops are hard ``delete_fact`` +
``delete_fact_embedding``.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, AsyncIterator

import pytest

from llm_adapters.types import ChatMessage, Token
from seraphine.memory import FakeEmbeddings, MemoryManager, MemoryStore

from tests.test_memory_manager import FakeCollection


class StubLLM:
    """Yields a controlled JSON response and counts how many times it is
    called, so tests can assert the fingerprint short-circuit skips it."""

    def __init__(self, payload: dict[str, Any] | None = None) -> None:
        self.raw = json.dumps(payload or {"merges": [], "drops": []})
        self.calls = 0

    async def chat(
        self,
        messages: list[ChatMessage],
        *,
        model: str | None = None,
        temperature: float = 0.7,
        **kwargs: Any,
    ) -> AsyncIterator[Token]:
        self.calls += 1
        yield Token(text=self.raw, done=False)
        yield Token(text="", done=True)


async def _build(
    tmp_path: Path, payload: dict[str, Any] | None = None,
) -> tuple[MemoryManager, MemoryStore, StubLLM]:
    store = MemoryStore(tmp_path / "audit.sqlite")
    await store.ensure_schema()
    llm = StubLLM(payload)
    mgr = MemoryManager(
        store,
        FakeEmbeddings(dim=8),
        tmp_path / "chroma",
        llm=llm,
    )
    mgr.set_collection_for_tests(FakeCollection())
    return mgr, store, llm


async def _seed(mgr: MemoryManager, texts: list[str]):
    """Learn facts (populating the embedding cache) and return them."""
    return [
        await mgr.learn_fact(t, source="explicit", confidence=1.0)
        for t in texts
    ]


# ---------------------------------------------------------------------------
# 1. Fingerprint short-circuit
# ---------------------------------------------------------------------------


async def test_fingerprint_short_circuits_second_run(tmp_path: Path) -> None:
    mgr, store, llm = await _build(tmp_path, {"merges": [], "drops": []})
    await _seed(mgr, ["uses a MacBook M3", "works with Go", "lives in Brazil"])

    first = await mgr.audit()
    assert first.get("skipped") is not True
    assert llm.calls == 1, "first run must call the LLM"

    # Fact set unchanged → fingerprint matches → no LLM call.
    second = await mgr.audit()
    assert second == {"skipped": True}
    assert llm.calls == 1, "second run must NOT call the LLM"


async def test_fingerprint_recomputes_when_fact_set_changes(tmp_path: Path) -> None:
    mgr, store, llm = await _build(tmp_path, {"merges": [], "drops": []})
    await _seed(mgr, ["uses a MacBook M3", "works with Go"])
    await mgr.audit()
    assert llm.calls == 1

    # Add a fact → fingerprint changes → LLM runs again.
    await mgr.learn_fact("lives in Brazil", source="explicit", confidence=1.0)
    await mgr.audit()
    assert llm.calls == 2


# ---------------------------------------------------------------------------
# 2. >50% deletion guard
# ---------------------------------------------------------------------------


async def test_over_half_removal_is_refused(
    tmp_path: Path, caplog: pytest.LogCaptureFixture,
) -> None:
    facts_ph: dict[str, Any] = {}
    # 4 active facts; LLM proposes dropping 3 → 3/4 = 75% > 50% → refuse.
    mgr, store, llm = await _build(tmp_path)
    seeded = await _seed(
        mgr, ["fact a", "fact b", "fact c", "fact d"],
    )
    drop_ids = [seeded[0].id, seeded[1].id, seeded[2].id]
    llm.raw = json.dumps({"merges": [], "drops": drop_ids})

    with caplog.at_level(logging.WARNING, logger="seraphine.memory"):
        result = await mgr.audit()

    assert result.get("refused") is True
    assert result.get("proposed_removed") == 3
    # Store unchanged: all 4 still active.
    active = await store.list_facts_for_decay()
    assert len(active) == 4
    assert any("audit" in r.message.lower() for r in caplog.records)

    # Fingerprint NOT persisted on refusal → a corrected set re-triggers.
    assert await store.get_kv("memory_audit_fingerprint") is None
    calls_before = llm.calls
    again = await mgr.audit()
    assert again.get("refused") is True
    assert llm.calls == calls_before + 1, "refusal must not freeze the fingerprint"


async def test_exactly_half_is_allowed(tmp_path: Path) -> None:
    # 4 active facts; LLM drops 2 → 2/4 = 50%, NOT > 50% → allowed.
    mgr, store, llm = await _build(tmp_path)
    seeded = await _seed(mgr, ["fact a", "fact b", "fact c", "fact d"])
    llm.raw = json.dumps(
        {"merges": [], "drops": [seeded[0].id, seeded[1].id]},
    )
    result = await mgr.audit()
    assert result.get("refused") is not True
    assert result.get("dropped") == 2
    active = await store.list_facts_for_decay()
    assert len(active) == 2


# ---------------------------------------------------------------------------
# 3. Merge via supersede (history preserved + survivor re-embedded)
# ---------------------------------------------------------------------------


async def test_merge_supersedes_and_reembeds_survivor(tmp_path: Path) -> None:
    mgr, store, llm = await _build(tmp_path)
    keep, drop, _other = await _seed(
        mgr,
        [
            "the user is named João",
            "user's name is João",  # paraphrase to merge away
            "user lives in Brazil",
        ],
    )
    llm.raw = json.dumps(
        {"merges": [{"keep_id": keep.id, "drop_id": drop.id}], "drops": []},
    )

    result = await mgr.audit()
    assert result.get("merged") == 1

    # Survivor still active; dropped fact superseded (history preserved,
    # NOT hard-deleted).
    active_ids = {f.id for f in await store.list_facts_for_decay()}
    assert keep.id in active_ids
    assert drop.id not in active_ids

    dropped_row = await store.get_fact(drop.id)
    assert dropped_row is not None, "merged fact row must remain (history)"
    assert dropped_row.superseded_by == keep.id

    # Survivor re-embedded → cache holds the keep-text vector; merged-away
    # fact's vector is evicted from the cache.
    expected_vec = (await mgr.embeddings.embed([keep.text]))[0]
    assert mgr._fact_embedding_cache[keep.id] == expected_vec
    assert drop.id not in mgr._fact_embedding_cache


# ---------------------------------------------------------------------------
# 4. Junk drop (hard delete + embedding delete)
# ---------------------------------------------------------------------------


async def test_junk_drop_hard_deletes(tmp_path: Path) -> None:
    mgr, store, llm = await _build(tmp_path)
    keep_a, junk, keep_b = await _seed(
        mgr, ["solid fact a", "asdfqwer junk", "solid fact b"],
    )
    llm.raw = json.dumps({"merges": [], "drops": [junk.id]})

    result = await mgr.audit()
    assert result.get("dropped") == 1

    # Junk fact is gone entirely (hard delete — not just superseded).
    assert await store.get_fact(junk.id) is None
    assert junk.id not in mgr._fact_embedding_cache
    embs = await store.load_fact_embeddings(model=mgr.embedding_model)
    assert junk.id not in embs

    active_ids = {f.id for f in await store.list_facts_for_decay()}
    assert active_ids == {keep_a.id, keep_b.id}


# ---------------------------------------------------------------------------
# Hygiene: no LLM wired → graceful no-op; LLM failure must not crash.
# ---------------------------------------------------------------------------


async def test_no_llm_is_noop(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "n.sqlite")
    await store.ensure_schema()
    mgr = MemoryManager(store, FakeEmbeddings(dim=8), tmp_path / "chroma")
    mgr.set_collection_for_tests(FakeCollection())
    await mgr.learn_fact("a fact", source="explicit", confidence=1.0)
    result = await mgr.audit()
    assert result.get("skipped") is True


async def test_llm_failure_is_swallowed(tmp_path: Path) -> None:
    class BoomLLM:
        async def chat(self, *a: Any, **k: Any) -> AsyncIterator[Token]:
            raise RuntimeError("boom")
            yield  # pragma: no cover

    store = MemoryStore(tmp_path / "b.sqlite")
    await store.ensure_schema()
    mgr = MemoryManager(
        store, FakeEmbeddings(dim=8), tmp_path / "chroma", llm=BoomLLM(),
    )
    mgr.set_collection_for_tests(FakeCollection())
    await mgr.learn_fact("a fact", source="explicit", confidence=1.0)
    # Must not raise — scheduler safety.
    result = await mgr.audit()
    assert isinstance(result, dict)
    # No mutations; fact still present.
    assert len(await store.list_facts_for_decay()) == 1
