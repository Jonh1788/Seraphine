from __future__ import annotations

import logging
import uuid
from typing import AsyncIterator, Literal, Protocol, Union

from pydantic import BaseModel

from seraphine.llm.types import ChatMessage, LLMUnavailableError, Token
from seraphine.memory.manager import MemoryManager
from seraphine.memory.store import MemoryStore

logger = logging.getLogger("seraphine.engine")

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


class ErrorEvent(BaseModel):
    type: Literal["error"] = "error"
    code: str
    message: str


StreamEvent = Union[TokenEvent, TurnEndEvent, ErrorEvent]


class ConversationEngine:
    def __init__(
        self,
        llm: _LLMLike,
        store: MemoryStore,
        system_prompt: str = DEFAULT_SYSTEM_PROMPT,
        memory: MemoryManager | None = None,
    ) -> None:
        self.llm = llm
        self.store = store
        self.system_prompt = system_prompt
        self.memory = memory

    async def _build_recall_block(self, content: str) -> str | None:
        if self.memory is None:
            return None
        try:
            recalled = await self.memory.recall(content, k=5)
        except Exception as e:  # pragma: no cover
            logger.warning("recall failed: %s", e)
            recalled = []
        try:
            facts = await self.memory.store.list_facts(limit=10)
        except Exception as e:  # pragma: no cover
            logger.warning("list_facts failed: %s", e)
            facts = []
        if not recalled and not facts:
            return None
        lines: list[str] = []
        if facts:
            lines.append("The following facts about the user may be relevant:")
            for f in facts:
                lines.append(f"- {f.text}")
        if recalled:
            if lines:
                lines.append("")
            lines.append("Recent related conversation excerpts:")
            for m in recalled:
                lines.append(f"- {m.text}")
        return "\n".join(lines)

    async def handle_user_message(
        self, conversation_id: str | None, content: str
    ) -> AsyncIterator[StreamEvent]:
        if conversation_id is None:
            conversation_id = await self.store.create_conversation()

        prior = await self.store.get_turns(conversation_id)

        messages: list[ChatMessage] = [ChatMessage(role="system", content=self.system_prompt)]
        recall_block = await self._build_recall_block(content)
        if recall_block:
            messages.append(ChatMessage(role="system", content=recall_block))
        for t in prior:
            if t.role in ("user", "assistant"):
                messages.append(ChatMessage(role=t.role, content=t.content))  # type: ignore[arg-type]
        messages.append(ChatMessage(role="user", content=content))

        user_turn = await self.store.add_turn(conversation_id, "user", content)

        turn_id = str(uuid.uuid4())
        accumulated: list[str] = []

        try:
            async for tok in self.llm.chat(messages):
                if tok.text:
                    accumulated.append(tok.text)
                    yield TokenEvent(
                        conversation_id=conversation_id, turn_id=turn_id, text=tok.text
                    )
        except LLMUnavailableError as e:
            yield ErrorEvent(code="llm_unavailable", message=str(e))
            return

        final_text = "".join(accumulated)
        assistant_turn = await self.store.add_turn(conversation_id, "assistant", final_text)
        yield TurnEndEvent(conversation_id=conversation_id, turn_id=turn_id)

        if self.memory is not None:
            try:
                await self.memory.remember_episode(user_turn)
                await self.memory.remember_episode(assistant_turn)
            except Exception as e:  # pragma: no cover
                logger.warning("remember_episode failed: %s", e)
