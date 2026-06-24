"""Tests for the bounded tunable-knobs registry (learning loop, OpenJarvis #1)."""

from __future__ import annotations

from seraphine.learning.knobs import clamp_knobs, effective_knobs, knob_registry


def test_clamp_drops_unknown_keys():
    assert clamp_knobs({"bogus": 1}) == {}


def test_clamp_handles_none():
    assert clamp_knobs(None) == {}


def test_clamp_clamps_high():
    assert clamp_knobs({"recall_fact_limit": 999})["recall_fact_limit"] == 60


def test_clamp_clamps_low():
    assert clamp_knobs({"recall_fact_limit": 1})["recall_fact_limit"] == 5


def test_clamp_keeps_in_range():
    assert clamp_knobs({"recall_fact_limit": 30})["recall_fact_limit"] == 30


def test_bool_coercion_string_false():
    assert clamp_knobs({"recall_enabled": "false"})["recall_enabled"] is False


def test_bool_coercion_string_true():
    assert clamp_knobs({"recall_enabled": "true"})["recall_enabled"] is True


def test_bool_coercion_int_zero():
    assert clamp_knobs({"recall_enabled": 0})["recall_enabled"] is False


def test_effective_knobs_none_returns_defaults():
    assert effective_knobs(None) == {
        "recall_fact_limit": 30,
        "smart_escalation_prompt_chars": 1500,
        "recall_enabled": True,
    }


def test_effective_knobs_overrides_single():
    eff = effective_knobs({"recall_fact_limit": 10})
    assert eff == {
        "recall_fact_limit": 10,
        "smart_escalation_prompt_chars": 1500,
        "recall_enabled": True,
    }


def test_effective_knobs_ignores_bogus():
    assert effective_knobs({"bogus": 1}) == {
        "recall_fact_limit": 30,
        "smart_escalation_prompt_chars": 1500,
        "recall_enabled": True,
    }


def test_knob_registry_shape():
    reg = knob_registry()
    assert len(reg) == 3
    for entry in reg:
        assert set(entry.keys()) == {
            "name",
            "kind",
            "default",
            "lo",
            "hi",
            "description",
        }
