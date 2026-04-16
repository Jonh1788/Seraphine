"""ConversationEngine -> InsightEngine.pending_nudges integration.

Verifies that proactive nudges are injected as a ``role=system`` message
before the LLM is called, and that analyzer exceptions are swallowed so
the turn still completes normally.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, AsyncIterator

import pytest

from llm_adapters.types import ChatMessage, Token
from seraphine.conversation.engine import ConversationEngine, TurnEndEvent
from seraphine.insights.models import Insight
from seraphine.memory.store import MemoryStore


class _RecordingLLM:
    """Stub LLM that records the messages it was called with.

    This is how we detect whether the proactive-nudges system message
    was appended *before* the LLM stream started.
    """

    def __init__(self, chunks: list[str]) -> None:
        self.chunks = chunks
        self.last_messages: list[ChatMessage] | None = None

    async def chat(
        self,
        messages: list[ChatMessage],
        *,
        model: str | None = None,
        temperature: float = 0.7,
        **kwargs: Any,
    ) -> AsyncIterator[Token]:
        self.last_messages = list(messages)
        for c in self.chunks:
            yield Token(text=c, done=False)
        yield Token(text="", done=True)


class _FakeInsightEngineOk:
    """Returns one warning + one info so the engine has something to inject."""

    async def pending_nudges(
        self, *, cap: int = 3, max_age_hours: int = 48,
    ) -> list[Insight]:
        return [
            Insight(
                id="i1",
                type="tasks",
                severity="warning",
                title="Foo",
                description="Foo description",
                created_at="2026-04-16T00:00:00+00:00",
            ),
            Insight(
                id="i2",
                type="habits",
                severity="info",
                title="Bar",
                description="Bar description",
                created_at="2026-04-16T00:00:00+00:00",
            ),
        ]


class _FakeInsightEngineRaises:
    async def pending_nudges(
        self, *, cap: int = 3, max_age_hours: int = 48,
    ) -> list[Insight]:
        raise RuntimeError("boom")


async def test_nudges_injected_as_system_message(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "nudges.sqlite")
    await store.ensure_schema()
    llm = _RecordingLLM(["ok"])
    engine = ConversationEngine(
        llm, store, insight_engine=_FakeInsightEngineOk(),
    )

    events = [e async for e in engine.handle_user_message(None, "hi")]
    assert any(isinstance(e, TurnEndEvent) for e in events)

    assert llm.last_messages is not None
    system_msgs = [m for m in llm.last_messages if m.role == "system"]
    nudge_msgs = [m for m in system_msgs if "PROACTIVE NUDGES" in (m.content or "")]
    assert len(nudge_msgs) == 1, (
        f"expected exactly one PROACTIVE NUDGES system message, got "
        f"{len(nudge_msgs)} ({[m.content for m in system_msgs]})"
    )
    body = nudge_msgs[0].content or ""
    # Both nudges should be rendered verbatim.
    assert "Foo" in body
    assert "Bar" in body
    assert "[warning]" in body
    assert "[info]" in body


async def test_nudges_failure_does_not_break_turn(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "nudges_err.sqlite")
    await store.ensure_schema()
    llm = _RecordingLLM(["ok"])
    engine = ConversationEngine(
        llm, store, insight_engine=_FakeInsightEngineRaises(),
    )

    events = [e async for e in engine.handle_user_message(None, "hi")]
    assert any(isinstance(e, TurnEndEvent) for e in events), (
        "turn should complete even when pending_nudges() raises"
    )

    # No nudge system message — the failure is swallowed.
    assert llm.last_messages is not None
    nudge_msgs = [
        m for m in llm.last_messages
        if m.role == "system" and "PROACTIVE NUDGES" in (m.content or "")
    ]
    assert nudge_msgs == []
