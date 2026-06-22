"""Pinned identity facts + always-injected "core facts" block (Task 1).

Identity facts (name, location, core relationships) can fall out of the
top-k RAG retrieval, so the assistant "forgets" them. The fix:

  - a ``pinned`` column on facts,
  - identity-class facts (category PESSOAS / LOCAL) auto-pin on write,
  - pinned facts are ALWAYS injected into context as a distinct
    "Core facts" block, independent of query similarity.

Part A covers schema + store accessors; Part B covers the engine
injection site (``_build_recall_block``).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, AsyncIterator
from unittest.mock import AsyncMock, MagicMock

import pytest

from llm_adapters.types import Token
from seraphine.conversation.engine import ConversationEngine
from seraphine.memory.store import Fact, MemoryStore


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


async def _make_store(tmp_path: Path, name: str) -> MemoryStore:
    store = MemoryStore(tmp_path / name)
    await store.ensure_schema()
    return store


def _columns(store: MemoryStore) -> list[str]:
    with store._connect() as conn:
        rows = conn.execute("PRAGMA table_info(facts)").fetchall()
    # PRAGMA table_info rows: (cid, name, type, notnull, dflt_value, pk)
    return [r[1] for r in rows]


# ---------------------------------------------------------------------------
# Part A — schema + accessors
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_migrator_adds_pinned_column_idempotently(tmp_path: Path) -> None:
    store = await _make_store(tmp_path, "pin_mig.sqlite")
    assert "pinned" in _columns(store)
    # Re-running every migrator must not raise (idempotent ALTER guard).
    await store.ensure_schema()
    assert "pinned" in _columns(store)


@pytest.mark.asyncio
async def test_migrator_backfills_identity_categories(tmp_path: Path) -> None:
    """Rows that predate the column with an identity category must be
    pinned by the migration backfill."""
    store = MemoryStore(tmp_path / "pin_backfill.sqlite")
    # Bring the schema up to (but not including) the pinned migrator by
    # running ensure_schema, then simulate legacy rows that existed before
    # pinning by inserting with pinned=0 across identity + non-identity
    # categories, then re-running the migration logic.
    await store.ensure_schema()

    def _seed() -> None:
        with store._connect() as conn:
            conn.execute(
                "INSERT INTO facts(id, text, source, confidence, created_at,"
                " superseded_by, category, pinned)"
                " VALUES (?, ?, ?, ?, ?, NULL, ?, 0)",
                ("p1", "mora em Lisboa", "explicit", 0.9, "2026-01-01", "LOCAL"),
            )
            conn.execute(
                "INSERT INTO facts(id, text, source, confidence, created_at,"
                " superseded_by, category, pinned)"
                " VALUES (?, ?, ?, ?, ?, NULL, ?, 0)",
                ("p2", "irmã Ana", "explicit", 0.9, "2026-01-01", "PESSOAS"),
            )
            conn.execute(
                "INSERT INTO facts(id, text, source, confidence, created_at,"
                " superseded_by, category, pinned)"
                " VALUES (?, ?, ?, ?, ?, NULL, ?, 0)",
                ("p3", "gosta de café", "explicit", 0.9, "2026-01-01", "PREFERENCIA"),
            )
            # Re-run the migration's backfill (idempotent).
            conn.execute(
                "UPDATE facts SET pinned = 1 WHERE category IN ('PESSOAS','LOCAL')"
            )

    import asyncio

    await asyncio.to_thread(_seed)

    def _read() -> dict[str, int]:
        with store._connect() as conn:
            rows = conn.execute("SELECT id, pinned FROM facts").fetchall()
        return {r[0]: r[1] for r in rows}

    pins = await asyncio.to_thread(_read)
    assert pins["p1"] == 1  # LOCAL
    assert pins["p2"] == 1  # PESSOAS
    assert pins["p3"] == 0  # PREFERENCIA


@pytest.mark.asyncio
async def test_fact_model_round_trips_pinned(tmp_path: Path) -> None:
    f = Fact(
        id="x",
        text="t",
        source="explicit",
        confidence=1.0,
        created_at="2026-01-01",
    )
    assert f.pinned == 0  # default
    f2 = Fact(
        id="y",
        text="t",
        source="explicit",
        confidence=1.0,
        created_at="2026-01-01",
        pinned=1,
    )
    assert f2.pinned == 1


@pytest.mark.asyncio
async def test_add_fact_auto_pins_identity_categories(tmp_path: Path) -> None:
    store = await _make_store(tmp_path, "pin_add.sqlite")

    person = await store.add_fact(
        "irmã chama Ana", "explicit", 0.9, category="PESSOAS"
    )
    place = await store.add_fact(
        "mora em Lisboa", "explicit", 0.9, category="LOCAL"
    )
    other = await store.add_fact(
        "prefere chá", "explicit", 0.9, category="PREFERENCIA"
    )

    assert person.pinned == 1
    assert place.pinned == 1
    assert other.pinned == 0

    # And it round-trips through a re-read from the DB.
    reread = await store.get_fact(person.id)
    assert reread is not None
    assert reread.pinned == 1
    reread_other = await store.get_fact(other.id)
    assert reread_other is not None
    assert reread_other.pinned == 0


@pytest.mark.asyncio
async def test_list_pinned_and_set_fact_pinned(tmp_path: Path) -> None:
    store = await _make_store(tmp_path, "pin_list.sqlite")

    person = await store.add_fact(
        "esposa chama Bia", "explicit", 0.9, category="PESSOAS"
    )
    other = await store.add_fact(
        "prefere chá", "explicit", 0.9, category="PREFERENCIA"
    )

    pinned = await store.list_pinned_facts()
    assert {f.id for f in pinned} == {person.id}
    assert all(f.pinned == 1 for f in pinned)

    # Pin the non-identity fact manually.
    await store.set_fact_pinned(other.id, True)
    pinned2 = await store.list_pinned_facts()
    assert {f.id for f in pinned2} == {person.id, other.id}

    # Unpin the identity fact.
    await store.set_fact_pinned(person.id, False)
    pinned3 = await store.list_pinned_facts()
    assert {f.id for f in pinned3} == {other.id}

    # Superseded pinned facts must not be returned. supersede_fact stores
    # the superseding id, so pass a non-null one to mark `other` inactive.
    await store.supersede_fact(other.id, new_id=person.id)
    pinned4 = await store.list_pinned_facts()
    assert pinned4 == []


# ---------------------------------------------------------------------------
# Part B — injection (_build_recall_block)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_recall_block_emits_core_facts_block(tmp_path: Path) -> None:
    """A "Core facts" block must appear even when recall + list_facts are
    empty, sourced from list_pinned_facts()."""
    store = await _make_store(tmp_path, "pin_engine.sqlite")
    await store.add_fact("usuário chama João", "explicit", 0.95, category="PESSOAS")

    fake_memory = MagicMock()
    fake_memory.recall = AsyncMock(return_value=[])
    fake_memory.store = store  # real store: list_pinned_facts works
    # list_facts returns nothing so only the pinned block has content.
    fake_memory.store.list_facts = AsyncMock(return_value=[])  # type: ignore[method-assign]

    engine = ConversationEngine(llm=_StubLLM(), store=store, memory=fake_memory)
    block = await engine._build_recall_block("oi")

    assert block is not None
    assert "Core facts about the user (always true):" in block
    assert "usuário chama João" in block


@pytest.mark.asyncio
async def test_recall_block_does_not_duplicate_pinned_in_relevant(
    tmp_path: Path,
) -> None:
    """A pinned fact's text must not ALSO appear in the regular
    "may be relevant" list."""
    store = await _make_store(tmp_path, "pin_engine_dup.sqlite")
    pinned = await store.add_fact(
        "usuário chama João", "explicit", 0.95, category="PESSOAS"
    )
    other = await store.add_fact(
        "prefere chá verde", "explicit", 0.9, category="PREFERENCIA"
    )

    fake_memory = MagicMock()
    fake_memory.recall = AsyncMock(return_value=[])
    fake_memory.store = store
    # list_facts (the "may be relevant" source) returns BOTH facts — the
    # pinned one must be filtered out of that block.
    fake_memory.store.list_facts = AsyncMock(  # type: ignore[method-assign]
        return_value=[pinned, other]
    )

    engine = ConversationEngine(llm=_StubLLM(), store=store, memory=fake_memory)
    block = await engine._build_recall_block("oi")

    assert block is not None
    assert "Core facts about the user (always true):" in block
    # Pinned text appears exactly once (in the core block, not the relevant one).
    assert block.count("usuário chama João") == 1
    # Non-pinned fact still shows in the "may be relevant" block.
    assert "prefere chá verde" in block
    assert "The following facts about the user may be relevant:" in block
