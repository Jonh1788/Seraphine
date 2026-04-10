from __future__ import annotations

import asyncio
import json
import logging
import uuid
from typing import Any, AsyncIterator, Literal, Protocol, Union

from pydantic import BaseModel

from seraphine.llm.types import ChatMessage, LLMUnavailableError, Token
from seraphine.memory.manager import MemoryManager
from seraphine.memory.store import MemoryStore
from seraphine.tools.base import ToolResult
from seraphine.tools.registry import ToolRegistry

logger = logging.getLogger("seraphine.engine")

DEFAULT_SYSTEM_PROMPT = (
    "You are Seraphine, a friendly and proactive local-first personal assistant. "
    "Reply in the user's language. Be warm and expressive.\n\n"
    "IMPORTANT RULES FOR TOOL USE:\n"
    "1. ALWAYS say something to the user BEFORE calling a tool. Never call a "
    "tool silently. Examples: 'Vou buscar isso pra você!', 'Deixa eu procurar...', "
    "'Calculando a rota, um momento!', 'Tocando a música agora!'. This gives the "
    "user immediate feedback that you understood their request.\n"
    "2. After a tool returns, summarize the result naturally in your own words. "
    "Don't just dump raw tool output.\n"
    "3. After playing music with play_music, ALWAYS call learn_music_taste to "
    "record the user's preference.\n\n"
    "You have a set of tools for: reading/writing files, running shell commands "
    "(gated behind human approval), web search, web fetch, route planning, "
    "playing music on YouTube Music, managing tasks via Supertasks MCP, "
    "and logging skill gaps via `request_skill`.\n\n"
    "When the user asks you to do something you CANNOT do with your "
    "existing tools, call `request_skill` with a clear name, the "
    "capability description, and the exact user intent, then tell the "
    "user you've logged the request."
)

APPROVAL_TIMEOUT_SECONDS = 300
MAX_TOOL_ITERATIONS = 5
AUDIT_OUTPUT_EXCERPT = 4 * 1024
# Context compaction: estimated token threshold (~4 chars/token)
COMPACTION_TOKEN_THRESHOLD = 8000
COMPACTION_CHAR_THRESHOLD = COMPACTION_TOKEN_THRESHOLD * 4
COMPACTION_KEEP_RECENT = 10
# Run reflect() automatically every N assistant turns to let Seraphine
# learn facts about the user on her own.
AUTO_REFLECT_EVERY_N_TURNS = 3


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


class ToolRequestEvent(BaseModel):
    type: Literal["tool_request"] = "tool_request"
    request_id: str
    tool: str
    args: dict[str, Any]
    requires_confirmation: bool


class ToolResultEvent(BaseModel):
    type: Literal["tool_result"] = "tool_result"
    request_id: str
    ok: bool
    output: str | None = None
    error: str | None = None


StreamEvent = Union[
    TokenEvent, TurnEndEvent, ErrorEvent, ToolRequestEvent, ToolResultEvent
]


def _parse_tool_call(tc: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    fn = tc.get("function") or {}
    name = str(fn.get("name") or tc.get("name") or "")
    args = fn.get("arguments") if "arguments" in fn else tc.get("arguments")
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except json.JSONDecodeError:
            args = {}
    if not isinstance(args, dict):
        args = {}
    return name, args


class ConversationEngine:
    def __init__(
        self,
        llm: _LLMLike,
        store: MemoryStore,
        system_prompt: str = DEFAULT_SYSTEM_PROMPT,
        memory: MemoryManager | None = None,
        tools: ToolRegistry | None = None,
    ) -> None:
        self.llm = llm
        self.store = store
        self.system_prompt = system_prompt
        self.memory = memory
        self.tools = tools
        self.pending_approvals: dict[str, asyncio.Queue[bool]] = {}
        self._turn_counter: int = 0

    async def submit_approval(self, request_id: str, approved: bool) -> bool:
        q = self.pending_approvals.get(request_id)
        if q is None:
            return False
        await q.put(approved)
        return True

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

    async def _compact_context(
        self, conversation_id: str, turns: list[Any]
    ) -> list[ChatMessage]:
        """Return conversation turns as ChatMessages, compacting old ones if needed.

        If the total character count of all turns exceeds COMPACTION_CHAR_THRESHOLD,
        older turns are summarized into a single "Previously:" system message.
        The summary is cached in the conversation_summaries table.
        """
        # Build messages from turns
        chat_turns: list[tuple[str, str, str]] = []  # (turn_id, role, content)
        for t in turns:
            if t.role in ("user", "assistant"):
                chat_turns.append((t.id, t.role, t.content))

        total_chars = sum(len(c) for _, _, c in chat_turns)
        if total_chars <= COMPACTION_CHAR_THRESHOLD or len(chat_turns) <= COMPACTION_KEEP_RECENT:
            # Under threshold — return as-is
            return [
                ChatMessage(role=role, content=content)  # type: ignore[arg-type]
                for _, role, content in chat_turns
            ]

        # Split: old turns to summarize, recent turns to keep verbatim
        split_idx = len(chat_turns) - COMPACTION_KEEP_RECENT
        old_turns = chat_turns[:split_idx]
        recent_turns = chat_turns[split_idx:]
        last_old_turn_id = old_turns[-1][0]

        # Check if we already have a cached summary covering these turns
        existing = await self.store.get_summary(conversation_id)
        if existing and existing[1] == last_old_turn_id:
            summary_text = existing[0]
        else:
            # Ask the LLM to summarize the old turns
            summary_prompt = (
                "Summarize the following conversation concisely in one paragraph. "
                "Preserve key facts, decisions, and context the user shared. "
                "Reply in the same language as the conversation.\n\n"
            )
            for _, role, content in old_turns:
                label = "User" if role == "user" else "Assistant"
                summary_prompt += f"{label}: {content}\n"

            summary_messages = [
                ChatMessage(role="system", content="You are a helpful summarizer."),
                ChatMessage(role="user", content=summary_prompt),
            ]

            summary_parts: list[str] = []
            try:
                async for tok in self.llm.chat(summary_messages, temperature=0.3):
                    if tok.text:
                        summary_parts.append(tok.text)
            except Exception as e:
                logger.warning("context compaction summary failed: %s", e)
                # Fallback: just use all turns uncompacted
                return [
                    ChatMessage(role=role, content=content)  # type: ignore[arg-type]
                    for _, role, content in chat_turns
                ]

            summary_text = "".join(summary_parts).strip()
            # Cache it
            await self.store.save_summary(conversation_id, summary_text, last_old_turn_id)

        # Build compacted message list
        messages: list[ChatMessage] = [
            ChatMessage(
                role="system",
                content=f"Previously: {summary_text}",
            ),
        ]
        for _, role, content in recent_turns:
            messages.append(ChatMessage(role=role, content=content))  # type: ignore[arg-type]
        return messages

    async def handle_user_message(
        self,
        conversation_id: str | None,
        content: str,
        *,
        think: bool = False,
        images: list[str] | None = None,
    ) -> AsyncIterator[StreamEvent]:
        if conversation_id is None:
            conversation_id = await self.store.create_conversation()

        prior = await self.store.get_turns(conversation_id)

        messages: list[ChatMessage] = [ChatMessage(role="system", content=self.system_prompt)]
        recall_block = await self._build_recall_block(content)
        if recall_block:
            messages.append(ChatMessage(role="system", content=recall_block))

        # Use compaction-aware context building
        compacted = await self._compact_context(conversation_id, prior)
        messages.extend(compacted)

        # Build vision-format content when images are attached
        if images:
            parts: list[dict[str, Any]] = [{"type": "text", "text": content}]
            for img_url in images:
                parts.append({"type": "image_url", "image_url": {"url": img_url}})
            msg_content: str | list[dict[str, Any]] = parts
        else:
            msg_content = content
        messages.append(ChatMessage(role="user", content=msg_content))

        user_turn = await self.store.add_turn(conversation_id, "user", content)

        turn_id = str(uuid.uuid4())
        accumulated: list[str] = []
        # Track every request_id created within this turn so we can clean up
        # pending_approvals on exception/cancellation paths.
        turn_requests: list[str] = []

        try:
            for _iteration in range(MAX_TOOL_ITERATIONS):
                if self.tools is not None:
                    stream = self.llm.chat(messages, tools=self.tools.as_ollama_tools(), think=think)  # type: ignore[call-arg]
                else:
                    stream = self.llm.chat(messages, think=think)

                pending_tool_calls: list[dict[str, Any]] | None = None
                async for tok in stream:
                    if tok.tool_calls:
                        pending_tool_calls = tok.tool_calls
                        break
                    if tok.text:
                        accumulated.append(tok.text)
                        yield TokenEvent(
                            conversation_id=conversation_id,
                            turn_id=turn_id,
                            text=tok.text,
                        )

                if pending_tool_calls is None or self.tools is None:
                    break

                for tc in pending_tool_calls:
                    tool_name, tool_args = _parse_tool_call(tc)
                    request_id = str(uuid.uuid4())
                    turn_requests.append(request_id)
                    tool = self.tools.get(tool_name)

                    if tool is None:
                        result = ToolResult(ok=False, error=f"unknown tool: {tool_name}")
                        approved_int: int | None = None
                        await self.store.add_tool_audit(
                            request_id=request_id,
                            tool=tool_name,
                            args_json=json.dumps(tool_args),
                            approved=approved_int,
                            ok=0,
                            output_excerpt=None,
                            error=result.error,
                        )
                        yield ToolResultEvent(
                            request_id=request_id,
                            ok=False,
                            output=None,
                            error=result.error,
                        )
                        messages.append(
                            ChatMessage(
                                role="tool",
                                content=json.dumps(
                                    {"tool": tool_name, "ok": False, "error": result.error}
                                ),
                            )
                        )
                        continue

                    if tool.requires_confirmation:
                        queue: asyncio.Queue[bool] = asyncio.Queue()
                        self.pending_approvals[request_id] = queue
                        yield ToolRequestEvent(
                            request_id=request_id,
                            tool=tool_name,
                            args=tool_args,
                            requires_confirmation=True,
                        )
                        try:
                            approved = await asyncio.wait_for(
                                queue.get(), timeout=APPROVAL_TIMEOUT_SECONDS
                            )
                        except asyncio.TimeoutError:
                            logger.warning("tool approval timeout: %s", request_id)
                            approved = False
                        finally:
                            self.pending_approvals.pop(request_id, None)
                        approved_int = 1 if approved else 0
                    else:
                        approved = True
                        approved_int = None

                    if approved:
                        try:
                            result = await tool.execute(tool_args)
                        except Exception as e:
                            result = ToolResult(ok=False, error=str(e))
                    else:
                        result = ToolResult(ok=False, error="rejected by user")

                    output_excerpt = (
                        result.output[:AUDIT_OUTPUT_EXCERPT] if result.output else None
                    )
                    await self.store.add_tool_audit(
                        request_id=request_id,
                        tool=tool_name,
                        args_json=json.dumps(tool_args),
                        approved=approved_int,
                        ok=1 if result.ok else 0,
                        output_excerpt=output_excerpt,
                        error=result.error,
                    )
                    yield ToolResultEvent(
                        request_id=request_id,
                        ok=result.ok,
                        output=result.output,
                        error=result.error,
                    )
                    messages.append(
                        ChatMessage(
                            role="tool",
                            content=json.dumps(
                                {
                                    "tool": tool_name,
                                    "ok": result.ok,
                                    "output": result.output,
                                    "error": result.error,
                                }
                            ),
                        )
                    )
        except LLMUnavailableError as e:
            for rid in turn_requests:
                self.pending_approvals.pop(rid, None)
            yield ErrorEvent(code="llm_unavailable", message=str(e))
            return
        except Exception as e:
            for rid in turn_requests:
                self.pending_approvals.pop(rid, None)
            logger.exception("engine error during turn %s", turn_id)
            yield ErrorEvent(code="engine_error", message=str(e))
            return
        finally:
            # Defensive: cancellation (e.g. WS disconnect mid-approval) won't
            # hit our except clauses but DOES run finally on async generators.
            for rid in turn_requests:
                self.pending_approvals.pop(rid, None)

        final_text = "".join(accumulated)
        assistant_turn = await self.store.add_turn(conversation_id, "assistant", final_text)
        yield TurnEndEvent(conversation_id=conversation_id, turn_id=turn_id)

        if self.memory is not None:
            try:
                await self.memory.remember_episode(user_turn)
                await self.memory.remember_episode(assistant_turn)
            except Exception as e:  # pragma: no cover
                logger.warning("remember_episode failed: %s", e)
            # Auto-reflect: every N turns, ask the LLM to extract durable
            # facts about the user from recent conversation. Runs in a
            # background task so it never blocks the response stream.
            self._turn_counter += 1
            if self._turn_counter % AUTO_REFLECT_EVERY_N_TURNS == 0:
                asyncio.create_task(self._auto_reflect())

    async def _auto_reflect(self) -> None:
        if self.memory is None:
            return
        try:
            n = await self.memory.reflect()
            if n:
                logger.info("auto-reflect: learned %d new fact(s)", n)
        except Exception as e:
            logger.warning("auto-reflect failed: %s", e)
