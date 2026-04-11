"""Engine-level cancellation tests.

These verify that setting ``cancel_event`` mid-turn causes
``ConversationEngine.handle_user_message`` to:

1. Exit the LLM stream cleanly (leaving the generator, which closes the
   underlying httpx stream in real adapters — we verify the mock's
   generator gets closed via its ``finally`` clause).
2. Yield a ``TurnCancelledEvent`` and nothing else after cancellation.
3. NOT persist an assistant turn to the store (the user turn stays).
4. Allow a subsequent turn on the same engine to run normally.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, AsyncIterator

import pytest

from seraphine.conversation.engine import (
    ConversationEngine,
    TokenEvent,
    TurnCancelledEvent,
    TurnEndEvent,
)
from seraphine.llm.types import ChatMessage, Token
from seraphine.memory.store import MemoryStore


class GatedLLM:
    """An LLM whose chat() yields tokens only when the test releases them.

    This gives tests deterministic control over "where in the stream"
    cancellation happens. Tracks ``finally_ran`` so we can assert the
    async generator was closed cleanly (mirroring what httpx's
    ``async with client.stream()`` exit does in the real adapters)."""

    def __init__(self, chunks: list[str]) -> None:
        self.chunks = chunks
        self.released: list[asyncio.Event] = [asyncio.Event() for _ in chunks]
        self.yielded: list[str] = []
        self.finally_ran: bool = False
        self.calls: int = 0

    def release_all(self) -> None:
        for ev in self.released:
            ev.set()

    async def chat(
        self,
        messages: list[ChatMessage],
        *,
        model: str | None = None,
        temperature: float = 0.7,
        **kwargs: Any,
    ) -> AsyncIterator[Token]:
        self.calls += 1
        try:
            for i, chunk in enumerate(self.chunks):
                await self.released[i].wait()
                self.yielded.append(chunk)
                yield Token(text=chunk, done=False)
            yield Token(text="", done=True)
        finally:
            # Real adapters' ``async with self._client.stream(...)``
            # cleanup lives here — leaving the generator (via break or
            # close) runs this block, which in production closes the
            # httpx connection.
            self.finally_ran = True


class ImmediateLLM:
    """Fully synchronous LLM: yields everything, then finishes."""

    def __init__(self, chunks: list[str]) -> None:
        self.chunks = chunks

    async def chat(
        self,
        messages: list[ChatMessage],
        *,
        model: str | None = None,
        temperature: float = 0.7,
        **kwargs: Any,
    ) -> AsyncIterator[Token]:
        for c in self.chunks:
            yield Token(text=c, done=False)
        yield Token(text="", done=True)


@pytest.mark.asyncio
async def test_cancel_mid_llm_stream(tmp_path: Path) -> None:
    """Setting cancel_event mid-stream exits the LLM loop and yields
    a turn_cancelled event. No assistant turn is persisted."""
    store = MemoryStore(tmp_path / "t.sqlite")
    await store.ensure_schema()

    llm = GatedLLM(["Hel", "lo", " world", "!"])
    engine = ConversationEngine(llm, store)
    cancel_event = asyncio.Event()

    events: list[Any] = []
    gen = engine.handle_user_message(None, "hi", cancel_event=cancel_event)

    # Release the first chunk so the engine enters the stream.
    llm.released[0].set()
    events.append(await gen.__anext__())  # TokenEvent("Hel")

    # Now cancel before any more tokens are pulled. Release the next
    # chunk as well so that if the engine were NOT respecting the
    # event, it would emit more tokens.
    cancel_event.set()
    llm.released[1].set()
    llm.released[2].set()
    llm.released[3].set()

    # Drain the rest — should see exactly one more event: turn_cancelled.
    async for ev in gen:
        events.append(ev)

    token_events = [e for e in events if isinstance(e, TokenEvent)]
    cancelled_events = [e for e in events if isinstance(e, TurnCancelledEvent)]
    turn_end_events = [e for e in events if isinstance(e, TurnEndEvent)]

    assert len(token_events) == 1
    assert token_events[0].text == "Hel"
    assert len(cancelled_events) == 1
    assert not turn_end_events, "cancelled turns must not emit turn_end"

    # The LLM's async generator must have been closed — its finally
    # clause ran. In production this is what closes the httpx stream.
    assert llm.finally_ran is True

    # The user turn is persisted; the (incomplete) assistant turn is NOT.
    conv_id = cancelled_events[0].conversation_id
    turns = await store.get_turns(conv_id)
    roles = [t.role for t in turns]
    assert roles == ["user"], f"expected only user turn, got {roles}"


@pytest.mark.asyncio
async def test_cancel_before_first_token(tmp_path: Path) -> None:
    """Cancellation set before the first await fires on the very first
    ``_raise_if_cancelled`` check and emits only a turn_cancelled event."""
    store = MemoryStore(tmp_path / "t.sqlite")
    await store.ensure_schema()

    llm = ImmediateLLM(["hello"])
    engine = ConversationEngine(llm, store)
    cancel_event = asyncio.Event()
    cancel_event.set()

    events = [
        e
        async for e in engine.handle_user_message(
            None, "hi", cancel_event=cancel_event
        )
    ]
    assert len(events) == 1
    assert isinstance(events[0], TurnCancelledEvent)

    conv_id = events[0].conversation_id
    turns = await store.get_turns(conv_id)
    assert [t.role for t in turns] == ["user"]


@pytest.mark.asyncio
async def test_cancel_after_turn_end_is_noop(tmp_path: Path) -> None:
    """Setting cancel_event AFTER the engine has finished the turn must
    not affect anything — the event is observed only on await points
    inside the run, and by then the async generator is exhausted."""
    store = MemoryStore(tmp_path / "t.sqlite")
    await store.ensure_schema()

    llm = ImmediateLLM(["Hel", "lo"])
    engine = ConversationEngine(llm, store)
    cancel_event = asyncio.Event()

    events = [
        e
        async for e in engine.handle_user_message(
            None, "hi", cancel_event=cancel_event
        )
    ]
    # Set after the generator already drained — no-op.
    cancel_event.set()

    token_events = [e for e in events if isinstance(e, TokenEvent)]
    end_events = [e for e in events if isinstance(e, TurnEndEvent)]
    cancelled_events = [e for e in events if isinstance(e, TurnCancelledEvent)]
    assert "".join(t.text for t in token_events) == "Hello"
    assert len(end_events) == 1
    assert not cancelled_events

    conv_id = token_events[0].conversation_id
    turns = await store.get_turns(conv_id)
    assert [t.role for t in turns] == ["user", "assistant"]
    assert turns[1].content == "Hello"


@pytest.mark.asyncio
async def test_fresh_turn_after_cancellation_works(tmp_path: Path) -> None:
    """A second turn on the same engine after a cancelled turn must run
    normally — engine state resets per call, no leaked cancellation."""
    store = MemoryStore(tmp_path / "t.sqlite")
    await store.ensure_schema()

    llm = ImmediateLLM(["ok"])
    engine = ConversationEngine(llm, store)

    # Turn 1: cancel immediately.
    cancel1 = asyncio.Event()
    cancel1.set()
    first = [
        e
        async for e in engine.handle_user_message(None, "first", cancel_event=cancel1)
    ]
    assert any(isinstance(e, TurnCancelledEvent) for e in first)
    conv_id = next(
        e.conversation_id for e in first if isinstance(e, TurnCancelledEvent)
    )

    # Turn 2: on the same conversation, NO cancel event — must complete.
    second = [
        e
        async for e in engine.handle_user_message(conv_id, "second")
    ]
    token_events = [e for e in second if isinstance(e, TokenEvent)]
    end_events = [e for e in second if isinstance(e, TurnEndEvent)]
    cancelled_events = [e for e in second if isinstance(e, TurnCancelledEvent)]
    assert "".join(t.text for t in token_events) == "ok"
    assert len(end_events) == 1
    assert not cancelled_events

    turns = await store.get_turns(conv_id)
    # first turn: user only; second turn: user + assistant
    assert [t.role for t in turns] == ["user", "user", "assistant"]
    assert turns[-1].content == "ok"


@pytest.mark.asyncio
async def test_cancel_without_event_defaults_to_never_set(tmp_path: Path) -> None:
    """Backward compatibility: callers that don't pass cancel_event get
    a default Event that is never set, so existing behavior is unchanged."""
    store = MemoryStore(tmp_path / "t.sqlite")
    await store.ensure_schema()
    engine = ConversationEngine(ImmediateLLM(["hi"]), store)

    events = [e async for e in engine.handle_user_message(None, "hi")]
    assert any(isinstance(e, TurnEndEvent) for e in events)
    assert not any(isinstance(e, TurnCancelledEvent) for e in events)
