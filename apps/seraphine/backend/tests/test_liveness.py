"""Tests for SDD 022 — liveness layer (mood, open loops, personality)."""

from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from seraphine.memory.mood import MoodTracker, _classify
from seraphine.memory.open_loops import _similar, _tokenize, _parse_loops_json

TZ = ZoneInfo("America/Sao_Paulo")


def test_mood_concerned_from_tired_user() -> None:
    t = MoodTracker()
    state = t.observe("to morto de cansado hoje, sem energia")
    assert state is not None
    assert state.mood == "concerned"


def test_mood_playful_needs_multiple_signals() -> None:
    t = MoodTracker()
    # Use a long message to avoid the late-night "cozy" heuristic.
    weak = t.observe("kk ok essa é uma mensagem com mais de oitenta caracteres pra não cair na regra de madrugada cozy e ficar single signal mesmo kk")
    # either None (default) or cozy is acceptable — the point is it's
    # NOT playful with a single signal.
    assert weak is None or weak.mood != "playful"
    t = MoodTracker()
    state = t.observe("kkkk adorei demais que massa")
    assert state is not None
    assert state.mood == "playful"


def test_mood_decays_to_default_after_neutral_streak() -> None:
    t = MoodTracker()
    t.observe("to exausto")
    assert t.current() is not None
    # 3 neutral turns should force decay. Use a long message to avoid
    # the late-night "cozy" heuristic triggering during CI after midnight.
    neutral = (
        "qual o clima de sao paulo hoje? estou curioso sobre os detalhes "
        "meteorológicos dessa manhã só pra ter uma ideia geral"
    )
    for _ in range(3):
        t.observe(neutral)
    assert t.current() is None


def test_mood_same_mood_refreshes_timestamp() -> None:
    t = MoodTracker()
    first = t.observe("to cansado")
    assert first is not None
    original_ts = first.set_at
    import time as _t
    _t.sleep(0.01)
    second = t.observe("cansado mesmo")
    assert second is not None
    assert second.set_at >= original_ts


def test_openloops_similarity_handles_verb_stems() -> None:
    assert _similar("vou testar o build do sim", "testei o build ontem", threshold=0.22)


def test_openloops_parse_skips_garbage() -> None:
    raw = '[{"text": "curta", "owner": "user"}, {"text": "X" * 300, "owner": "xxx"}]'
    out = _parse_loops_json(raw)
    # Short text filtered + invalid owner filtered.
    assert out == []


def test_openloops_parse_accepts_valid() -> None:
    raw = '[{"text": "Jonathan vai testar o build do simulador hoje", "owner": "user"}]'
    out = _parse_loops_json(raw)
    assert len(out) == 1
    assert out[0]["owner"] == "user"


def test_tokenize_drops_stopwords_and_stems() -> None:
    tokens = _tokenize("Vou testar o build amanhã")
    # "vou" is stopped (<3 chars? no, 3 chars → not stopped, but verb form gets stemmed)
    # "testar" -> "test" after -ar strip
    assert "test" in tokens
    assert "build" in tokens
