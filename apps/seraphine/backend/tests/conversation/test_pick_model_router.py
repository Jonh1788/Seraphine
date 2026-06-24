"""Cost/complexity router wiring into ConversationEngine._pick_model.

Builds a real ConversationEngine the same way the existing engine tests do
(FakeLLM + in-memory MemoryStore — see tests/test_engine_unit.py), then drives
the *sync* _pick_model directly (no I/O). The metered-spend signal is set on the
instance attribute (_metered_spend_today) the same way the per-turn refresh
block in handle_user_message would.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, AsyncIterator

import pytest

from llm_adapters.types import ChatMessage, Token
from seraphine.conversation.engine import ConversationEngine
from seraphine.memory.store import MemoryStore

_SMART = "claude-sonnet-4-6"


class FakeLLM:
    async def chat(
        self,
        messages: list[ChatMessage],
        *,
        model: str | None = None,
        temperature: float = 0.7,
        **kwargs: Any,
    ) -> AsyncIterator[Token]:
        yield Token(text="", done=True)


async def _make_engine(tmp_path: Path) -> ConversationEngine:
    store = MemoryStore(tmp_path / "t.sqlite")
    await store.ensure_schema()
    return ConversationEngine(FakeLLM(), store)


@pytest.mark.asyncio
async def test_simple_short_prompt_returns_none(tmp_path: Path, monkeypatch) -> None:
    engine = await _make_engine(tmp_path)
    monkeypatch.setattr("seraphine.config.settings.anthropic_smart_model", _SMART)
    monkeypatch.setattr("seraphine.config.settings.llm_backend", "anthropic")
    monkeypatch.setattr("seraphine.config.settings.routing_daily_cap_usd", 0.0)

    assert engine._pick_model(prompt="hi there") is None


@pytest.mark.asyncio
async def test_think_escalates_to_smart(tmp_path: Path, monkeypatch) -> None:
    engine = await _make_engine(tmp_path)
    monkeypatch.setattr("seraphine.config.settings.anthropic_smart_model", _SMART)
    monkeypatch.setattr("seraphine.config.settings.llm_backend", "anthropic")
    monkeypatch.setattr("seraphine.config.settings.routing_daily_cap_usd", 0.0)

    assert engine._pick_model(think=True, prompt="hi") == _SMART


@pytest.mark.asyncio
async def test_cost_guard_blocks_escalation(tmp_path: Path, monkeypatch) -> None:
    engine = await _make_engine(tmp_path)
    monkeypatch.setattr("seraphine.config.settings.anthropic_smart_model", _SMART)
    monkeypatch.setattr("seraphine.config.settings.llm_backend", "anthropic")
    monkeypatch.setattr("seraphine.config.settings.routing_daily_cap_usd", 1.0)
    engine._metered_spend_today = 5.0

    # think would normally escalate, but the metered cap is exhausted.
    assert engine._pick_model(think=True, prompt="hi") is None


@pytest.mark.asyncio
async def test_local_backend_ignores_cost_guard(tmp_path: Path, monkeypatch) -> None:
    engine = await _make_engine(tmp_path)
    monkeypatch.setattr("seraphine.config.settings.anthropic_smart_model", _SMART)
    monkeypatch.setattr("seraphine.config.settings.llm_backend", "openai")
    monkeypatch.setattr("seraphine.config.settings.routing_daily_cap_usd", 1.0)
    engine._metered_spend_today = 5.0

    # Local backend → smart model is not metered, so the cap does not apply.
    assert engine._pick_model(think=True, prompt="hi") == _SMART


@pytest.mark.asyncio
async def test_no_smart_model_returns_none(tmp_path: Path, monkeypatch) -> None:
    engine = await _make_engine(tmp_path)
    monkeypatch.setattr("seraphine.config.settings.anthropic_smart_model", "")
    monkeypatch.setattr("seraphine.config.settings.llm_backend", "anthropic")
    monkeypatch.setattr("seraphine.config.settings.routing_daily_cap_usd", 0.0)

    # Disabled regardless of complexity.
    assert engine._pick_model(think=True, has_images=True, tool_iteration=3, prompt="x") is None
