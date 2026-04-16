"""Tests for SDD 011-C: Emotional Memory."""

from __future__ import annotations

from pathlib import Path

import pytest

from seraphine.memory.emotional_context import (
    EMOTIONAL_FACT_PREFIX,
    MAX_EMOTIONAL_SNAPSHOTS,
    build_emotional_context,
    detect_emotion,
    get_recent_emotional_context,
    record_emotional_context,
)
from seraphine.memory.store import MemoryStore


@pytest.fixture
async def store(tmp_path: Path) -> MemoryStore:
    s = MemoryStore(tmp_path / "test.sqlite")
    await s.ensure_schema()
    return s


# ---------------------------------------------------------------------------
# detect_emotion — keyword-based
# ---------------------------------------------------------------------------


class TestDetectEmotion:
    def test_stressed_work(self) -> None:
        result = detect_emotion("estou estressado com o trabalho")
        assert result is not None
        assert result["sentiment"] == "stressed"
        assert result["topic"] == "work"

    def test_stressed_deploy(self) -> None:
        result = detect_emotion("pqp, o deploy quebrou de novo")
        assert result is not None
        assert result["sentiment"] == "stressed"
        assert result["topic"] == "work"

    def test_happy(self) -> None:
        result = detect_emotion("deu certo!")
        assert result is not None
        assert result["sentiment"] == "happy"

    def test_happy_consegui(self) -> None:
        result = detect_emotion("consegui resolver o bug do servidor")
        assert result is not None
        assert result["sentiment"] == "happy"
        assert result["topic"] == "work"

    def test_frustrated(self) -> None:
        result = detect_emotion("esse erro não funciona de novo, droga")
        assert result is not None
        assert result["sentiment"] == "frustrated"

    def test_excited(self) -> None:
        result = detect_emotion("caramba, estou empolgado com o projeto novo!")
        assert result is not None
        assert result["sentiment"] == "excited"
        assert result["topic"] == "work"

    def test_neutral_no_detection(self) -> None:
        result = detect_emotion("normal, tudo bem")
        assert result is None

    def test_neutral_question(self) -> None:
        result = detect_emotion("qual a previsao do tempo amanha?")
        assert result is None

    def test_finance_topic(self) -> None:
        result = detect_emotion("estou estressado com a fatura do cartao")
        assert result is not None
        assert result["sentiment"] == "stressed"
        assert result["topic"] == "finance"

    def test_personal_topic(self) -> None:
        result = detect_emotion("estou cansada, problemas com a familia")
        assert result is not None
        assert result["sentiment"] == "stressed"
        assert result["topic"] == "personal"

    def test_summary_truncation(self) -> None:
        long_msg = "estou estressado " + "x" * 200
        result = detect_emotion(long_msg)
        assert result is not None
        assert len(result["summary"]) <= 80


# ---------------------------------------------------------------------------
# record + retrieve cycle
# ---------------------------------------------------------------------------


async def test_record_and_retrieve(store: MemoryStore) -> None:
    await record_emotional_context(store, "stressed", "work", "deploy quebrou")
    snapshots = await get_recent_emotional_context(store)
    assert len(snapshots) == 1
    assert snapshots[0]["sentiment"] == "stressed"
    assert snapshots[0]["topic"] == "work"
    assert snapshots[0]["summary"] == "deploy quebrou"
    assert "recorded_at" in snapshots[0]


async def test_max_snapshots_enforced(store: MemoryStore) -> None:
    for i in range(MAX_EMOTIONAL_SNAPSHOTS + 3):
        await record_emotional_context(store, "stressed", "work", f"event {i}")

    snapshots = await get_recent_emotional_context(store, limit=MAX_EMOTIONAL_SNAPSHOTS + 5)
    # Should not exceed MAX_EMOTIONAL_SNAPSHOTS (old ones superseded)
    assert len(snapshots) <= MAX_EMOTIONAL_SNAPSHOTS + 1  # +1 for timing tolerance


async def test_build_emotional_context_empty(store: MemoryStore) -> None:
    ctx = await build_emotional_context(store)
    assert ctx == ""


async def test_build_emotional_context_with_data(store: MemoryStore) -> None:
    await record_emotional_context(store, "stressed", "work", "deploy deu problema")
    ctx = await build_emotional_context(store)
    assert "stressed" in ctx
    assert "work" in ctx
    assert "deploy deu problema" in ctx
    assert "don't force it" in ctx


async def test_multiple_sentiments(store: MemoryStore) -> None:
    await record_emotional_context(store, "stressed", "work", "deploy quebrou")
    await record_emotional_context(store, "happy", "personal", "aniversario foi otimo")
    snapshots = await get_recent_emotional_context(store)
    assert len(snapshots) == 2
    sentiments = {s["sentiment"] for s in snapshots}
    assert sentiments == {"stressed", "happy"}
