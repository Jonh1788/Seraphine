"""Tests for the journal module: mood persistence + Seraphine reflection.

Covers the Wave B changes:
  * idempotent migration adds mood_label / mood_valence / reflection columns
  * service.create_entry persists a composer-selected mood and a reflection
  * generate_reflection is best-effort (None when no LLM / on error)
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, AsyncIterator

import pytest

from core_db import Store

from seraphine.journal import schema as journal_schema
from seraphine.journal.service import JournalService


class _Token:
    def __init__(self, text: str) -> None:
        self.text = text


class _FakeLLM:
    """Minimal LLM stub matching the ``chat`` streaming contract."""

    def __init__(self, reply: str = "Que dia interessante; cuide-se bem.") -> None:
        self._reply = reply
        self.calls = 0

    async def chat(
        self,
        messages: list[Any],
        *,
        model: str | None = None,
        temperature: float = 0.0,
    ) -> AsyncIterator[_Token]:
        self.calls += 1
        for word in self._reply.split(" "):
            yield _Token(word + " ")


class _BrokenLLM:
    async def chat(self, *args: Any, **kwargs: Any) -> AsyncIterator[_Token]:
        raise RuntimeError("boom")
        yield _Token("")  # pragma: no cover


async def _make_service(
    tmp_path: Path, llm: Any = None, name: str = "journal_test.db",
) -> JournalService:
    store = Store(tmp_path / name)
    store.register_migrator("seraphine_journal", journal_schema.migrate)
    await store.ensure_schema()
    return JournalService(store, llm=llm)


@pytest.mark.asyncio
async def test_migration_adds_columns(tmp_path: Path) -> None:
    svc = await _make_service(tmp_path)
    with svc._store._connect() as conn:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(journal_entries)")}
    assert {"mood_label", "mood_valence", "reflection"} <= cols


@pytest.mark.asyncio
async def test_create_persists_mood_and_reflection(tmp_path: Path) -> None:
    svc = await _make_service(tmp_path)
    entry = await svc.create_entry(
        date="2026-06-20",
        type="manual",
        title="Hoje",
        content="Foi um dia produtivo e feliz.",
        mood_label="good",
        mood_valence=0.6,
        reflection="Fico feliz que tenha sido produtivo!",
    )
    assert entry.mood_label == "good"
    assert entry.mood_valence == pytest.approx(0.6)
    assert entry.reflection == "Fico feliz que tenha sido produtivo!"

    # Round-trips through SELECT (column order driven by _ENTRY_COLS).
    fetched = await svc.get_entry(entry.id)
    assert fetched is not None
    assert fetched.reflection == "Fico feliz que tenha sido produtivo!"
    assert fetched.mood_valence == pytest.approx(0.6)
    assert fetched.to_dict()["reflection"] == "Fico feliz que tenha sido produtivo!"


@pytest.mark.asyncio
async def test_generate_reflection_with_llm(tmp_path: Path) -> None:
    llm = _FakeLLM("Voce se cuidou bem hoje; continue assim.")
    svc = await _make_service(tmp_path, llm=llm)
    reflection = await svc.generate_reflection("Descansei e meditei.")
    assert reflection == "Voce se cuidou bem hoje; continue assim."
    assert llm.calls == 1


@pytest.mark.asyncio
async def test_generate_reflection_best_effort(tmp_path: Path) -> None:
    # No LLM -> None
    svc = await _make_service(tmp_path)
    assert await svc.generate_reflection("algo") is None
    # Empty content -> None even with an LLM
    svc2 = await _make_service(tmp_path, llm=_FakeLLM(), name="b.db")
    assert await svc2.generate_reflection("   ") is None
    # LLM raises -> None (non-blocking)
    svc3 = await _make_service(tmp_path, llm=_BrokenLLM(), name="c.db")
    assert await svc3.generate_reflection("algo") is None


@pytest.mark.asyncio
async def test_set_reflection_updates_existing(tmp_path: Path) -> None:
    svc = await _make_service(tmp_path)
    entry = await svc.create_entry(
        date="2026-06-20", type="manual", title="t", content="c",
    )
    assert entry.reflection is None
    await svc.set_reflection(entry.id, "Uma reflexao gentil.")
    fetched = await svc.get_entry(entry.id)
    assert fetched is not None
    assert fetched.reflection == "Uma reflexao gentil."
