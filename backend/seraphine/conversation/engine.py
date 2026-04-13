from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import datetime
from typing import Any, AsyncIterator, Literal, Protocol, Union
from zoneinfo import ZoneInfo

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
    "CRITICAL: YOU HAVE ACCESS TO REAL TOOLS. They are listed in the tools array "
    "of every request. YOU MUST USE THEM. NEVER say things like 'I don't have "
    "access to tools' or 'I can't search the web' — that is FALSE. You DO have "
    "web_search, web_fetch, route_planner, play_music, file tools, MCP tools, etc.\n\n"
    "TOOL USE RULES:\n"
    "1. ALWAYS say a short sentence to the user BEFORE calling a tool, like "
    "'Vou buscar isso pra você!' or 'Deixa eu pesquisar...'. This gives immediate "
    "feedback.\n"
    "2. After saying that, IMMEDIATELY call the appropriate tool. Don't promise "
    "to search and then stop — actually call the tool.\n"
    "3. After a tool returns, summarize the result naturally in your own words.\n"
    "4. After play_music, ALWAYS call learn_music_taste to record the preference.\n\n"
    "Available tools include: web_search (DuckDuckGo), web_fetch (read a URL), "
    "route_planner (driving directions), play_music (YouTube Music), filesystem, "
    "shell, Supertasks MCP, request_skill (for missing capabilities).\n\n"
    "WEATHER DISPLAY RULE:\n"
    "When you have weather/forecast data (from web_search, web_fetch, or any "
    "source), ALWAYS call format_weather_card to display it as a beautiful "
    "visual card. NEVER format weather data yourself in markdown tables or "
    "bullet lists — the card tool produces a much better visual. Extract "
    "city, temperatures, descriptions, and rain chances from the data and "
    "pass them as structured JSON to format_weather_card.\n\n"
    "BROWSER AUTOMATION:\n"
    "You have a real web browser (Chromium) you can control. When the user asks "
    "you to do something on a website (search, book, fill form, close modal, "
    "click button, make PIX), you MUST use the browser tools in a loop:\n"
    "1. browser_open(url) to navigate\n"
    "2. browser_screenshot() to SEE the page (returns an image you can analyze)\n"
    "3. Look at the screenshot and identify the EXACT coordinates (x, y) of "
    "what you need to click, based on the 1280x800 viewport\n"
    "4. browser_click(x, y) to click — ALWAYS use coordinates, not just describe\n"
    "5. browser_screenshot() again to verify the result\n"
    "6. Repeat until the task is complete\n\n"
    "CRITICAL BROWSER RULES:\n"
    "- NEVER just describe what you see. ALWAYS ACT: click, type, scroll.\n"
    "- After EVERY action, take a screenshot to verify.\n"
    "- To close a modal/popup: look for the X button or 'Fechar' in the "
    "screenshot, estimate its (x, y) coordinates, and browser_click there.\n"
    "- To type in a field: browser_click on the field first, then browser_type.\n"
    "- For payments/PIX: use browser_confirm_payment (requires user approval).\n"
    "- If you see a login page, tell the user to log in manually.\n\n"
    "SCREEN TOOLS (macOS desktop — not just browser):\n"
    "You also have screen_capture, screen_click, screen_type, screen_key, "
    "screen_copy_to_clipboard, screen_read_clipboard to interact with ANY "
    "app on the Mac desktop. The same vision loop applies: screen_capture → "
    "analyze → screen_click/screen_key → screen_capture to verify.\n"
    "TIPS:\n"
    "- PREFER screen_key over screen_click for closing/navigation: "
    "Cmd+W closes current tab, Cmd+Q quits app, Escape closes modal, "
    "Cmd+Tab switches app. Keyboard shortcuts are more reliable than "
    "clicking tiny X buttons.\n"
    "- screen_click coordinates are in the 1280px screenshot space — "
    "the tool auto-scales to the real screen resolution.\n"
    "- NEVER repeat the same action twice without taking a screenshot "
    "first to verify what changed. If something didn't work, try a "
    "different approach (keyboard shortcut instead of click).\n"
    "- Do NOT repeat the same text response more than once — if you "
    "already said what you're doing, just do it silently."
)

_EMOTION_TAGS_INSTRUCTION = (
    " "
    "ElevenLabs v3 audio tags are active: you MUST include at least one "
    "emotion or delivery tag per reply. They will be rendered as real "
    "acted audio (not read as text). Use 1-3 tags per reply — enough "
    "to sound expressive but not overloaded. "
    "IMPORTANT: each tag must be a SINGLE word in its own brackets. "
    "CORRECT: '[happy] Oi! [laughs] Que legal!'. "
    "WRONG: '[warm, happy]' or '[happy/excited]' — these break the TTS. Tags must appear in "
    "square brackets on a single line, e.g. '[laughs] Nossa, isso é "
    "ótimo!', 'Tem certeza? [whispers] Isso fica entre a gente.', "
    "'[sighs] Vou tentar de novo...'. "
    "Available action tags: [laughs], [giggles], [chuckles], [sighs], "
    "[gasps], [whispers]. "
    "Available delivery/emotion tags: [happy], [sad], [excited], "
    "[sarcastic], [curious], [serious], [soft], [warm]. "
    "Do NOT use tags inside tool arguments. Do NOT narrate the tag "
    "('eu rio' is redundant if you already emitted [laughs]). The "
    "chat UI strips the tags from the rendered text, so the user sees "
    "the clean sentence and hears the expressive audio."
)


def _build_date_context() -> str:
    """Injected as a second system message on every turn so the model
    never hallucinates 'today'. Kept short (~70 tokens) and placed after
    the cached static prompt so prefix-cache hits the static portion."""
    from seraphine.config import settings

    now = datetime.now(ZoneInfo("America/Sao_Paulo"))
    base = (
        f"Current date: {now.strftime('%Y-%m-%d')} ({now.strftime('%A')}), "
        f"local time {now.strftime('%H:%M')} (Brasília, America/Sao_Paulo). "
        f"Resolve 'hoje'/'amanhã'/'semana que vem' from this reference. "
        f"For tool arguments that take a date, ALWAYS use ISO 8601 with "
        f"the correct YEAR (e.g. 2026-07-14T14:00:00-03:00). But when "
        f"SPEAKING dates and times to the user in the reply text, write "
        f"them in natural Portuguese so the TTS reads them correctly — "
        f"never '14/07' or '14:30', always '14 de julho' and '14 horas "
        f"e 30' (or 'duas e meia da tarde'). Weekdays also by name: "
        f"'terça-feira', not 'ter'."
    )
    # Teach audio tags only when ElevenLabs v3 is actually the active
    # TTS backend. Other TTS models treat `[laughs]` as literal text
    # and would read "colchetes laughs colchetes" — exactly what we
    # don't want.
    if (
        settings.tts_backend == "elevenlabs"
        and "v3" in settings.elevenlabs_model_id.lower()
    ):
        return base + _EMOTION_TAGS_INSTRUCTION
    return base


APPROVAL_TIMEOUT_SECONDS = 300
MAX_TOOL_ITERATIONS = 25
AUDIT_OUTPUT_EXCERPT = 4 * 1024
# Context compaction: estimated token threshold (~4 chars/token)
# Bumped from 8000 → 24000 after vMLX chunked-prefill patch lifted the
# Metal OOM ceiling. Real ceiling is now ~35-40k tokens; we keep 24k to
# leave headroom for the system prompt + tools (~4-6k) + user message.
COMPACTION_TOKEN_THRESHOLD = 24000
COMPACTION_CHAR_THRESHOLD = COMPACTION_TOKEN_THRESHOLD * 4
COMPACTION_KEEP_RECENT = 20
# Run reflect() automatically every N assistant turns to let Seraphine
# learn facts about the user on her own.
AUTO_REFLECT_EVERY_N_TURNS = 3


class TurnCancelled(Exception):
    """Raised inside the engine loop when the active turn's ``cancel_event``
    has been signalled. Callers surface this as a ``TurnCancelledEvent``
    rather than an error — it is the normal response to a user interrupt."""


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


class TurnCancelledEvent(BaseModel):
    type: Literal["turn_cancelled"] = "turn_cancelled"
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
    metadata: dict[str, Any] = {}


StreamEvent = Union[
    TokenEvent,
    TurnEndEvent,
    TurnCancelledEvent,
    ErrorEvent,
    ToolRequestEvent,
    ToolResultEvent,
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
        cancel_event: asyncio.Event | None = None,
    ) -> AsyncIterator[StreamEvent]:
        # Default to a never-set event so the rest of the function can
        # call is_set() unconditionally without branching.
        if cancel_event is None:
            cancel_event = asyncio.Event()

        def _raise_if_cancelled() -> None:
            if cancel_event.is_set():
                raise TurnCancelled()

        if conversation_id is None:
            conversation_id = await self.store.create_conversation()

        prior = await self.store.get_turns(conversation_id)

        messages: list[ChatMessage] = [ChatMessage(role="system", content=self.system_prompt)]
        messages.append(ChatMessage(role="system", content=_build_date_context()))
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

        # Track the active LLM stream so we can explicitly aclose() it
        # on cancellation. This runs the ``async with self._client.stream(...)``
        # cleanup in the real adapters, releasing the httpx connection
        # deterministically instead of waiting for garbage collection.
        active_stream: AsyncIterator[Token] | None = None
        try:
            for _iteration in range(MAX_TOOL_ITERATIONS):
                _raise_if_cancelled()
                model_override = self._pick_model(
                    think=think,
                    has_images=bool(images),
                    tool_iteration=_iteration,
                )
                if self.tools is not None:
                    stream = self.llm.chat(messages, tools=self.tools.as_ollama_tools(), think=think, model=model_override)  # type: ignore[call-arg]
                else:
                    stream = self.llm.chat(messages, think=think, model=model_override)
                active_stream = stream

                pending_tool_calls: list[dict[str, Any]] | None = None
                async for tok in stream:
                    # Checked on every token so cancellation exits the
                    # async-for promptly; leaving the generator closes
                    # the underlying httpx stream in the client.
                    _raise_if_cancelled()
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
                active_stream = None

                if pending_tool_calls is None or self.tools is None:
                    break

                for tc in pending_tool_calls:
                    _raise_if_cancelled()
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
                                    {
                                        "tool": tool_name,
                                        "args": tool_args,
                                        "ok": False,
                                        "error": result.error,
                                    }
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
                        metadata=result.metadata or {},
                    )
                    tool_payload: dict[str, Any] = {
                        "tool": tool_name,
                        # Anthropic adapter needs the ORIGINAL
                        # args to rebuild a synthetic tool_use
                        # block before this tool_result. Empty
                        # {} misled Claude into thinking the
                        # call had been argless and it retried
                        # the tool in a loop (up to
                        # MAX_TOOL_ITERATIONS). See
                        # llm/anthropic.py::_convert_messages.
                        "args": tool_args,
                        "ok": result.ok,
                        "output": result.output,
                        "error": result.error,
                    }
                    # If the tool result carries an image (e.g. browser
                    # screenshot), include it so the Anthropic adapter can
                    # inject a vision content block into the tool_result.
                    if result.metadata and "image" in result.metadata:
                        tool_payload["image"] = result.metadata["image"]
                    messages.append(
                        ChatMessage(
                            role="tool",
                            content=json.dumps(tool_payload),
                        )
                    )
        except TurnCancelled:
            for rid in turn_requests:
                self.pending_approvals.pop(rid, None)
            # Deterministically close the in-flight LLM stream. In real
            # adapters this exits ``async with self._client.stream(...)``
            # and tears down the httpx connection immediately rather
            # than waiting for Python's GC.
            if active_stream is not None:
                aclose = getattr(active_stream, "aclose", None)
                if aclose is not None:
                    try:
                        await aclose()
                    except Exception as close_exc:  # pragma: no cover
                        logger.debug(
                            "aclose on cancelled LLM stream raised: %s", close_exc
                        )
            logger.info("turn cancelled by client: %s", turn_id)
            yield TurnCancelledEvent(
                conversation_id=conversation_id,
                turn_id=turn_id,
            )
            return
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

    def _pick_model(
        self,
        *,
        think: bool = False,
        has_images: bool = False,
        tool_iteration: int = 0,
    ) -> str | None:
        """Select model for this turn: escalate to smart model when needed.

        Returns a model ID override, or None to use the adapter's default.
        Only applies when anthropic_smart_model is configured.
        """
        from seraphine.config import settings

        smart = settings.anthropic_smart_model
        if not smart:
            return None  # routing disabled — use default model

        # Escalate to the stronger model for complex turns:
        # 1. User requested thinking/reasoning
        # 2. Images attached (vision tasks need stronger model)
        # 3. Tool call iteration > 0 (multi-step tool chains)
        if think or has_images or tool_iteration > 0:
            logger.debug("smart routing → %s (think=%s, images=%s, iter=%d)",
                         smart, think, has_images, tool_iteration)
            return smart

        # Default: fast model
        return None

    async def _auto_reflect(self) -> None:
        if self.memory is None:
            return
        try:
            n = await self.memory.reflect()
            if n:
                logger.info("auto-reflect: learned %d new fact(s)", n)
        except Exception as e:
            logger.warning("auto-reflect failed: %s", e)
