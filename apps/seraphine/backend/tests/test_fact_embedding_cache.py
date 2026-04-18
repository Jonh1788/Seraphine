"""Persistence tests for the fact embedding cache.

The first reflect() after a backend restart used to re-embed up to 200
facts (cache lived only in RAM). This verifies that learn_fact +
reflect push the cache to SQLite and that MemoryManager.start() hydrates
it on boot — with a guard that swapping ``embedding_model`` invalidates
the cache so incompatible vector spaces never get mixed.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from seraphine.memory import FakeEmbeddings, MemoryManager, MemoryStore


@pytest.fixture
async def store(tmp_path: Path) -> MemoryStore:
    s = MemoryStore(tmp_path / "cache.sqlite")
    await s.ensure_schema()
    return s


async def test_learn_fact_persists_embedding(store: MemoryStore, tmp_path: Path) -> None:
    emb = FakeEmbeddings(dim=8)
    mgr = MemoryManager(store, emb, tmp_path / "chroma", embedding_model="fake-v1")
    fact = await mgr.learn_fact("user speaks PT-BR")
    row = await store.load_fact_embeddings(model="fake-v1")
    assert fact.id in row
    assert len(row[fact.id]) == 8


async def test_hydrates_cache_on_start(store: MemoryStore, tmp_path: Path) -> None:
    emb = FakeEmbeddings(dim=8)
    first = MemoryManager(store, emb, tmp_path / "chroma", embedding_model="fake-v1")
    fact = await first.learn_fact("fact A")

    # Simulate restart: drop the manager, reinstantiate against the same
    # store. start() should repopulate _fact_embedding_cache from SQLite.
    second = MemoryManager(store, emb, tmp_path / "chroma", embedding_model="fake-v1")
    assert second._fact_embedding_cache == {}
    await second.start()
    assert fact.id in second._fact_embedding_cache
    # BLOB is float32 packed; compare with tolerance instead of exact eq
    # (original fake vectors are float64).
    rehydrated = second._fact_embedding_cache[fact.id]
    original = first._fact_embedding_cache[fact.id]
    assert rehydrated == pytest.approx(original, abs=1e-6)


async def test_model_mismatch_starts_empty(store: MemoryStore, tmp_path: Path) -> None:
    emb = FakeEmbeddings(dim=8)
    mgr_v1 = MemoryManager(store, emb, tmp_path / "chroma", embedding_model="fake-v1")
    await mgr_v1.learn_fact("fact A")

    # Different model tag → cache must stay empty (vector space incompatible).
    mgr_v2 = MemoryManager(store, emb, tmp_path / "chroma", embedding_model="fake-v2")
    await mgr_v2.start()
    assert mgr_v2._fact_embedding_cache == {}


async def test_forget_deletes_persisted_embedding(
    store: MemoryStore, tmp_path: Path,
) -> None:
    emb = FakeEmbeddings(dim=8)
    mgr = MemoryManager(store, emb, tmp_path / "chroma", embedding_model="fake-v1")
    fact = await mgr.learn_fact("temporary")
    await mgr.forget(fact.id)
    row = await store.load_fact_embeddings(model="fake-v1")
    assert fact.id not in row
