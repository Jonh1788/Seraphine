from __future__ import annotations

import math
from pathlib import Path

import pytest

from seraphine.memory import (
    FakeEmbeddings,
    MemoryManager,
    MemoryStore,
)
from seraphine.memory.store import Turn


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a)) or 1.0
    nb = math.sqrt(sum(x * x for x in b)) or 1.0
    return dot / (na * nb)


def _matches_where(meta: dict, where: dict) -> bool:
    """Minimal Chroma where-filter evaluator for tests."""
    if "$and" in where:
        return all(_matches_where(meta, clause) for clause in where["$and"])
    for key, val in where.items():
        if key.startswith("$"):
            continue
        actual = meta.get(key)
        if isinstance(val, dict):
            for op, operand in val.items():
                if op == "$gte" and (actual is None or actual < operand):
                    return False
                if op == "$lte" and (actual is None or actual > operand):
                    return False
        else:
            if actual != val:
                return False
    return True


class FakeCollection:
    def __init__(self) -> None:
        self.docs: dict[str, dict] = {}

    def add(
        self,
        ids: list[str],
        embeddings: list[list[float]],
        documents: list[str],
        metadatas: list[dict],
    ) -> None:
        for i, id_ in enumerate(ids):
            self.docs[id_] = {
                "embedding": embeddings[i],
                "document": documents[i],
                "metadata": metadatas[i],
            }

    def query(
        self,
        query_embeddings: list[list[float]],
        n_results: int,
        where: dict | None = None,
    ) -> dict:
        q = query_embeddings[0]
        candidates = list(self.docs.items())
        if where:
            candidates = [
                (id_, d) for id_, d in candidates
                if _matches_where(d.get("metadata", {}), where)
            ]
        scored = [
            (id_, _cosine(q, d["embedding"]), d["document"], d["metadata"])
            for id_, d in candidates
        ]
        scored.sort(key=lambda x: -x[1])
        top = scored[:n_results]
        return {
            "ids": [[t[0] for t in top]],
            "documents": [[t[2] for t in top]],
            "metadatas": [[t[3] for t in top]],
            "distances": [[1 - t[1] for t in top]],
        }

    def delete(self, ids: list[str]) -> None:
        for id_ in ids:
            self.docs.pop(id_, None)


@pytest.fixture
async def manager(tmp_path: Path) -> MemoryManager:
    store = MemoryStore(tmp_path / "test.sqlite")
    await store.ensure_schema()
    mgr = MemoryManager(store, FakeEmbeddings(dim=8), tmp_path / "chroma")
    mgr.set_collection_for_tests(FakeCollection())
    return mgr


async def test_remember_and_recall(manager: MemoryManager) -> None:
    turn = Turn(
        id="t1",
        conversation_id="c1",
        role="user",
        content="user is a software engineer",
        created_at="2026-01-01T00:00:00+00:00",
    )
    await manager.remember_episode(turn)
    results = await manager.recall("what does the user do?", k=3)
    assert len(results) == 1
    assert results[0].id == "t1"
    assert "software engineer" in results[0].text


async def test_learn_and_list_facts(manager: MemoryManager) -> None:
    fact = await manager.learn_fact("user prefers PT-BR", source="explicit", confidence=0.9)
    assert fact.text == "user prefers PT-BR"
    facts = await manager.store.list_facts()
    assert len(facts) == 1
    assert facts[0].id == fact.id


async def test_forget_fact_supersedes(manager: MemoryManager) -> None:
    fact = await manager.learn_fact("temporary fact")
    await manager.forget(fact.id)
    facts = await manager.store.list_facts()
    assert facts == []
    facts_all = await manager.store.list_facts(include_superseded=True)
    assert len(facts_all) == 1


async def test_forget_episode_removes(manager: MemoryManager) -> None:
    turn = Turn(
        id="t-bye",
        conversation_id="c1",
        role="user",
        content="ephemeral",
        created_at="2026-01-01T00:00:00+00:00",
    )
    await manager.remember_episode(turn)
    await manager.forget("t-bye")
    results = await manager.recall("ephemeral", k=5)
    assert results == []
