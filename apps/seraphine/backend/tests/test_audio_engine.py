from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import pytest

from seraphine.conversation.audio_engine import (
    AudioEngine,
    ErrorEvent,
    TokenEvent,
    TranscriptionEvent,
    TurnEndEvent,
)
from seraphine.conversation.engine import ConversationEngine
from llm_adapters.types import ChatMessage, LLMUnavailableError, Token
from seraphine.memory.store import MemoryStore
from seraphine.stt.whisper import STTUnavailableError, Transcription


class FakeLLM:
    async def chat(
        self,
        messages: list[ChatMessage],
        *,
        model: str | None = None,
        temperature: float = 0.7,
        **kwargs: Any,
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


class FakeSTT:
    def __init__(self, text: str = "olá mundo") -> None:
        self._text = text

    async def transcribe(self, pcm: bytes, sample_rate: int = 16000) -> Transcription:
        return Transcription(text=self._text, language="pt", duration_seconds=0.5)


class EmptySTT:
    async def transcribe(self, pcm: bytes, sample_rate: int = 16000) -> Transcription:
        return Transcription(text="", language="pt", duration_seconds=0.0)


class BrokenSTT:
    async def transcribe(self, pcm: bytes, sample_rate: int = 16000) -> Transcription:
        raise STTUnavailableError("whisper down")


def _make_engine(llm: Any, store: MemoryStore, stt: Any) -> AudioEngine:
    conv = ConversationEngine(llm=llm, store=store)
    return AudioEngine(llm, None, store, stt=stt, engine=conv)


@pytest.mark.asyncio
async def test_audio_engine_transcribes_then_delegates(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "t.sqlite")
    await store.ensure_schema()
    engine = _make_engine(FakeLLM(), store, FakeSTT("olá mundo"))

    events = []
    async for ev in engine.handle_user_audio(None, b"\x00" * 32):
        events.append(ev)

    tx = [e for e in events if isinstance(e, TranscriptionEvent)]
    assert len(tx) == 1 and tx[0].text == "olá mundo"
    tokens = [e for e in events if isinstance(e, TokenEvent)]
    assert len(tokens) >= 1
    assert sum(isinstance(e, TurnEndEvent) for e in events) == 1
    assert events.index(tx[0]) < events.index(tokens[0])

    conv_id = tokens[0].conversation_id
    turns = await store.get_turns(conv_id)
    # Real transcript now persists as the user turn (no more "[audio]" pollution).
    assert [t.role for t in turns] == ["user", "assistant"]
    assert turns[0].content == "olá mundo"
    assert turns[1].content == "hello"


@pytest.mark.asyncio
async def test_audio_engine_stt_unavailable(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "t.sqlite")
    await store.ensure_schema()
    engine = AudioEngine(FakeLLM(), None, store, stt=None)

    events = [ev async for ev in engine.handle_user_audio(None, b"\x00")]
    assert any(isinstance(e, ErrorEvent) and e.code == "stt_unavailable" for e in events)


@pytest.mark.asyncio
async def test_audio_engine_stt_empty(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "t.sqlite")
    await store.ensure_schema()
    engine = _make_engine(FakeLLM(), store, EmptySTT())

    events = [ev async for ev in engine.handle_user_audio(None, b"\x00")]
    assert any(isinstance(e, ErrorEvent) and e.code == "stt_empty" for e in events)
    assert not any(isinstance(e, TokenEvent) for e in events)


@pytest.mark.asyncio
async def test_audio_engine_stt_failed(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "t.sqlite")
    await store.ensure_schema()
    engine = _make_engine(FakeLLM(), store, BrokenSTT())

    events = [ev async for ev in engine.handle_user_audio(None, b"\x00")]
    assert any(isinstance(e, ErrorEvent) and e.code == "stt_failed" for e in events)


@pytest.mark.asyncio
async def test_audio_engine_llm_error_after_transcription(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "t.sqlite")
    await store.ensure_schema()
    engine = _make_engine(BrokenLLM(), store, FakeSTT())

    events = [ev async for ev in engine.handle_user_audio(None, b"\x00")]
    assert any(isinstance(e, TranscriptionEvent) for e in events)
    assert any(isinstance(e, ErrorEvent) for e in events)
