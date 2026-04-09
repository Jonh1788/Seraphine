from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import pytest

from seraphine.conversation.audio_engine import (
    AudioEngine,
    ErrorEvent,
    TokenEvent,
    TtsChunkEvent,
    TtsEndEvent,
    TtsStartEvent,
    TurnEndEvent,
)
from seraphine.llm.types import ChatMessage, LLMUnavailableError, Token
from seraphine.memory.store import MemoryStore
from seraphine.tts.base import TTSAdapter
from seraphine.tts.moss import FakeTTSAdapter, TTSUnavailableError


class FakeLLM:
    async def chat(
        self,
        messages: list[ChatMessage],
        *,
        model: str | None = None,
        temperature: float = 0.7,
        audio: bytes | None = None,
    ) -> AsyncIterator[Token]:
        for c in ["he", "llo"]:
            yield Token(text=c, done=False)
        yield Token(text="", done=True)


class BrokenLLM:
    async def chat(
        self, messages: list[ChatMessage], **kwargs: Any
    ) -> AsyncIterator[Token]:
        raise LLMUnavailableError("down")
        yield Token(text="", done=True)  # pragma: no cover


class BrokenTTS(TTSAdapter):
    async def synthesize_stream(  # type: ignore[override]
        self, text: Any, *, voice_id: str | None = None
    ) -> AsyncIterator[bytes]:
        raise TTSUnavailableError("tts down")
        yield b""  # pragma: no cover


@pytest.mark.asyncio
async def test_audio_engine_full_sequence(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "t.sqlite")
    await store.ensure_schema()
    tts = FakeTTSAdapter([b"\x00\x01", b"\x02\x03"])
    engine = AudioEngine(FakeLLM(), tts, store)

    events = []
    async for ev in engine.handle_user_audio(None, b"\x00" * 32):
        events.append(ev)

    token_events = [e for e in events if isinstance(e, TokenEvent)]
    assert len(token_events) == 2
    assert sum(isinstance(e, TurnEndEvent) for e in events) == 1
    assert sum(isinstance(e, TtsStartEvent) for e in events) == 1
    chunks = [e for e in events if isinstance(e, TtsChunkEvent)]
    assert len(chunks) == 2
    assert sum(isinstance(e, TtsEndEvent) for e in events) == 1

    # Order: tokens -> turn_end -> tts_start -> chunks -> tts_end
    types_order = [type(e).__name__ for e in events]
    assert types_order.index("TurnEndEvent") > types_order.index("TokenEvent")
    assert types_order.index("TtsStartEvent") > types_order.index("TurnEndEvent")
    assert types_order.index("TtsEndEvent") > types_order.index("TtsChunkEvent")

    conv_id = token_events[0].conversation_id
    turns = await store.get_turns(conv_id)
    assert len(turns) == 2
    assert turns[0].role == "user"
    assert turns[0].content == "[audio]"
    assert turns[1].role == "assistant"
    assert turns[1].content == "hello"


@pytest.mark.asyncio
async def test_audio_engine_llm_error(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "t.sqlite")
    await store.ensure_schema()
    engine = AudioEngine(BrokenLLM(), FakeTTSAdapter([b"\x00"]), store)

    events = []
    async for ev in engine.handle_user_audio(None, b"\x00"):
        events.append(ev)

    assert any(
        isinstance(e, ErrorEvent) and e.code == "llm_unavailable" for e in events
    )
    assert not any(isinstance(e, TtsStartEvent) for e in events)


@pytest.mark.asyncio
async def test_audio_engine_tts_error(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "t.sqlite")
    await store.ensure_schema()
    engine = AudioEngine(FakeLLM(), BrokenTTS(), store)

    events = []
    async for ev in engine.handle_user_audio(None, b"\x00"):
        events.append(ev)

    assert any(isinstance(e, TurnEndEvent) for e in events)
    assert any(
        isinstance(e, ErrorEvent) and e.code == "tts_unavailable" for e in events
    )
    assert not any(isinstance(e, TtsEndEvent) for e in events)
