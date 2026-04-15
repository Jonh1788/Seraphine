"""Audio conversation engine.

Original Phase 2 design assumed we could feed PCM directly to a
multimodal LLM. That never worked with Ollama — its /api/chat
Message struct has no Audio field, only Images (confirmed by reading
ollama/api/types.go). The `"audio"` key we were attaching was
silently dropped, and Gemma 4 always saw only a "[audio]" placeholder
and replied "please provide audio input".

New design: transcribe the mic PCM locally with Whisper (mlx-whisper
native to Apple Silicon), then delegate to the existing text path on
the shared ConversationEngine. This gives us:

  - Real voice input that actually reaches Gemma.
  - The transcript becomes the user-turn content in SQLite, fixing the
    Phase 5 memory pollution from [audio] placeholders.
  - Zero duplication of the tool-use / memory-recall / sentence-
    streaming logic that the text path already implements —
    handle_user_audio is now a thin wrapper.

The speak/TTS output path is re-used verbatim via the existing WS
sentence worker, because the LLM's reply is just text once the STT
is done.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from typing import Any, Literal, Protocol, Union

from pydantic import BaseModel

from seraphine.conversation.engine import (
    ConversationEngine,
    ErrorEvent as _EngineErrorEvent,
    StreamEvent as _EngineStreamEvent,
    TokenEvent as _EngineTokenEvent,
    TurnEndEvent as _EngineTurnEndEvent,
)
from seraphine.stt.whisper import STTUnavailableError, Transcription, WhisperSTT

logger = logging.getLogger("seraphine.audio_engine")


# ---- Local event models for the audio path -------------------------
# We re-export the text-path events under the same names plus a
# Transcription event so the WS layer can surface "what did the user
# actually say" to the client as soon as whisper returns.


class TokenEvent(BaseModel):
    type: Literal["token"] = "token"
    conversation_id: str
    turn_id: str
    text: str


class TurnEndEvent(BaseModel):
    type: Literal["turn_end"] = "turn_end"
    conversation_id: str
    turn_id: str


class TtsStartEvent(BaseModel):
    type: Literal["tts_start"] = "tts_start"
    turn_id: str
    sample_rate: int = 24000


class TtsChunkEvent(BaseModel):
    type: Literal["tts_chunk"] = "tts_chunk"
    turn_id: str
    pcm: bytes


class TtsEndEvent(BaseModel):
    type: Literal["tts_end"] = "tts_end"
    turn_id: str


class TranscriptionEvent(BaseModel):
    type: Literal["transcription"] = "transcription"
    text: str
    language: str | None = None
    duration_seconds: float = 0.0


class ErrorEvent(BaseModel):
    type: Literal["error"] = "error"
    code: str
    message: str


AudioStreamEvent = Union[
    TokenEvent,
    TurnEndEvent,
    TtsStartEvent,
    TtsChunkEvent,
    TtsEndEvent,
    TranscriptionEvent,
    ErrorEvent,
]


# Legacy TTSAdapter stub (unused here — TTS runs from the WS layer).
class _TTSLike(Protocol):  # pragma: no cover - structural only
    async def synthesize_stream(self, text: Any, *, voice_id: str | None = ...) -> AsyncIterator[bytes]: ...


class AudioEngine:
    """Voice path wrapper around ConversationEngine.

    `tts` is accepted for backward compatibility with earlier Phase 2
    tests but is never used — TTS is driven from the WS layer via the
    sentence-streaming worker. Leave it wired if you want the old
    AudioEngine unit tests to pass; the new production path ignores it.
    """

    def __init__(
        self,
        llm: Any,
        tts: Any,
        store: Any,
        *,
        stt: WhisperSTT | None = None,
        engine: ConversationEngine | None = None,
    ) -> None:
        self.llm = llm
        self.tts = tts
        self.store = store
        self.stt = stt
        # If the caller didn't pass a real engine (tests), construct a
        # minimal one that just wires llm + store. Production always
        # passes app.state.engine so memory/tools are preserved.
        self.engine = engine or ConversationEngine(llm=llm, store=store)

    async def handle_user_audio(
        self,
        conversation_id: str | None,
        audio: bytes,
    ) -> AsyncIterator[AudioStreamEvent]:
        """Transcribe the PCM input, emit a transcription event, then
        stream the text-turn events (token/turn_end/error) through the
        regular ConversationEngine."""
        if self.stt is None:
            yield ErrorEvent(
                code="stt_unavailable",
                message="no STT adapter configured on AudioEngine",
            )
            return

        try:
            tx: Transcription = await self.stt.transcribe(audio, sample_rate=16000)
        except STTUnavailableError as e:
            logger.warning("whisper failed: %s", e)
            yield ErrorEvent(code="stt_failed", message=str(e))
            return

        if not tx.text:
            yield ErrorEvent(
                code="stt_empty",
                message="transcript was empty (silence or unrecognised speech)",
            )
            return

        yield TranscriptionEvent(
            text=tx.text,
            language=tx.language,
            duration_seconds=tx.duration_seconds,
        )

        # Delegate to the shared text path. Every upstream event
        # (TokenEvent, TurnEndEvent, ErrorEvent) gets re-boxed into
        # our local models so the WS layer can emit them uniformly.
        async for event in self.engine.handle_user_message(conversation_id, tx.text):
            et = getattr(event, "type", None)
            if et == "token":
                yield TokenEvent(
                    conversation_id=getattr(event, "conversation_id", ""),
                    turn_id=getattr(event, "turn_id", ""),
                    text=getattr(event, "text", ""),
                )
            elif et == "turn_end":
                yield TurnEndEvent(
                    conversation_id=getattr(event, "conversation_id", ""),
                    turn_id=getattr(event, "turn_id", ""),
                )
            elif et == "error":
                yield ErrorEvent(
                    code=getattr(event, "code", "engine_error"),
                    message=getattr(event, "message", ""),
                )
            # tool_request / tool_result are silently passed if the
            # engine emits them, but the audio path doesn't currently
            # need to surface them to the client.
