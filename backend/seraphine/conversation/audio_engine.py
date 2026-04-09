from __future__ import annotations

# Local pydantic event models — DO NOT import from engine.py
import uuid
from collections.abc import AsyncIterator
from typing import Literal, Protocol, Union

from pydantic import BaseModel

from seraphine.llm.types import ChatMessage, LLMUnavailableError, Token
from seraphine.memory.store import MemoryStore
from seraphine.tts.base import TTSAdapter
from seraphine.tts.moss import TTSUnavailableError

DEFAULT_SYSTEM_PROMPT = (
    "You are Seraphine, a concise local-first assistant. Reply in the user's language."
)


class _LLMLike(Protocol):
    async def chat(
        self,
        messages: list[ChatMessage],
        *,
        model: str | None = ...,
        temperature: float = ...,
        audio: bytes | None = ...,
    ) -> AsyncIterator[Token]: ...


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


class ErrorEvent(BaseModel):
    type: Literal["error"] = "error"
    code: str
    message: str


AudioStreamEvent = Union[
    TokenEvent, TurnEndEvent, TtsStartEvent, TtsChunkEvent, TtsEndEvent, ErrorEvent
]


class AudioEngine:
    def __init__(
        self,
        llm: _LLMLike,
        tts: TTSAdapter,
        store: MemoryStore,
        system_prompt: str = DEFAULT_SYSTEM_PROMPT,
    ) -> None:
        self.llm = llm
        self.tts = tts
        self.store = store
        self.system_prompt = system_prompt

    async def handle_user_audio(
        self, conversation_id: str | None, audio: bytes
    ) -> AsyncIterator[AudioStreamEvent]:
        if conversation_id is None:
            conversation_id = await self.store.create_conversation()

        prior = await self.store.get_turns(conversation_id)
        messages: list[ChatMessage] = [
            ChatMessage(role="system", content=self.system_prompt)
        ]
        for t in prior:
            # Skip placeholder audio turns from previous voice exchanges (they
            # carry no usable text). Until real STT lands, voice user-turns
            # are intentionally NOT persisted, so this filter is defensive.
            if t.role in ("user", "assistant") and t.content != "[audio]":
                messages.append(ChatMessage(role=t.role, content=t.content))  # type: ignore[arg-type]
        messages.append(ChatMessage(role="user", content="[audio]"))

        # NOTE(phase 2): the user audio turn is NOT persisted on purpose.
        # Persisting "[audio]" pollutes both prior context and Phase 5 episodic
        # memory. When real transcription is wired in, replace this with the
        # transcribed text and call add_turn(role="user", content=transcript).

        turn_id = str(uuid.uuid4())
        accumulated: list[str] = []

        try:
            async for tok in self.llm.chat(messages, audio=audio):
                if tok.text:
                    accumulated.append(tok.text)
                    yield TokenEvent(
                        conversation_id=conversation_id,
                        turn_id=turn_id,
                        text=tok.text,
                    )
        except LLMUnavailableError as e:
            yield ErrorEvent(code="llm_unavailable", message=str(e))
            return

        full_text = "".join(accumulated)
        yield TurnEndEvent(conversation_id=conversation_id, turn_id=turn_id)

        await self.store.add_turn(conversation_id, "assistant", full_text)

        yield TtsStartEvent(turn_id=turn_id)
        try:
            async for chunk in self.tts.synthesize_stream(full_text):
                yield TtsChunkEvent(turn_id=turn_id, pcm=chunk)
        except TTSUnavailableError as e:
            yield ErrorEvent(code="tts_unavailable", message=str(e))
            return

        yield TtsEndEvent(turn_id=turn_id)
