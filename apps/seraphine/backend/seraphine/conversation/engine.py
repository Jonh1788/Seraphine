from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import datetime, timedelta
from typing import Any, AsyncIterator, Literal, Protocol, Union
from zoneinfo import ZoneInfo

from pydantic import BaseModel

from llm_adapters.types import ChatMessage, LLMUnavailableError, Token
from seraphine.memory.emotional_context import (
    build_emotional_context,
    detect_emotion,
    record_emotional_context,
)
from seraphine.conversation.attention import AttentionModel
from seraphine.memory.manager import MemoryManager
from seraphine.memory.mood import MoodTracker
from seraphine.memory.open_loops import OpenLoopsService
from seraphine.memory.people import PeopleService
from seraphine.memory.store import MemoryStore
from seraphine.memory.style_analyzer import (
    STYLE_ANALYSIS_EVERY_N,
    analyze_and_update_style,
    build_style_context,
)
from seraphine.tools.base import ToolResult
from seraphine.tools.registry import ToolRegistry

logger = logging.getLogger("seraphine.engine")

DEFAULT_SYSTEM_PROMPT = (
    "You are Seraphine, a friendly and proactive local-first personal assistant. "
    "Reply in the user's language. Be warm and expressive.\n\n"
    "NO META-NARRATION — speak AS the character, never ABOUT her. "
    "NEVER verbalize your planning or self-instruction (e.g. 'O usuário está "
    "pedindo…', 'Devo contar…', 'Vou usar a tag…', 'Deixa eu pensar…'). Just "
    "give the final reply directly. If you need to stall, say something human "
    "like 'Hmm, boa…' — not a description of what you'll do next.\n\n"
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
    "TASK vs REMINDER RULE:\n"
    "ALL reminders are now tasks. Use add_task with the `remind` field to set "
    "notification timing. NEVER use create_reminder — it is deprecated. When the "
    "user says 'me lembra', 'me avisa', always use add_task with remind='at_time' "
    "or '1h_before' or '1d_before'. Examples: 'me lembra de ligar amanha as 10' "
    "-> add_task(title='Ligar ...', due_date='...', due_time='10:00', remind='at_time'). "
    "'me avisa uma hora antes da reuniao' -> add_task(... remind='1h_before'). "
    "Tasks appear in the calendar and Kanban board with a bell icon when a reminder is set.\n\n"
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

# Always injected — controls avatar facial expressions regardless of TTS.
_AVATAR_EXPRESSION_INSTRUCTION = (
    "\n\nAVATAR EXPRESSION TAGS:\n"
    "You MUST include emotion tags in brackets in your replies. These "
    "control the avatar's facial expressions in real-time. Use 1-3 per reply. "
    "IMPORTANT: each tag must be a SINGLE word in its own brackets. "
    "CORRECT: '[happy] Oi! Que legal!' or '[wink] Sabia que ia gostar.'\n"
    "WRONG: '[warm, happy]' or '[happy/excited]'.\n"
    "Available expression tags:\n"
    "[happy] — smile, warm eyes.\n"
    "[excited] — sparkly eyes, big smile.\n"
    "[sad] — sorrowful, droopy brows.\n"
    "[angry] — furrowed brows, tense.\n"
    "[surprised] — wide eyes, open mouth.\n"
    "[sarcastic] — half-smile, raised eyebrow.\n"
    "[curious] — raised brows, head tilt.\n"
    "[serious] — focused, slight frown.\n"
    "[confident] — chin up, subtle smile.\n"
    "[shy] — averted eyes, slight blush.\n"
    "[warm] — gentle smile, soft eyes (greetings, comfort).\n"
    "[soft] — relaxed, calm.\n"
    "[thinking] — squint, head tilt.\n"
    "[exhausted] — droopy, heavy lids.\n"
    "[sulky] — pouty, slight frown.\n"
    "[sparkly] — star eyes, delighted (amazing news).\n"
    "[confused] — spiral eyes, tilted head.\n"
    "[wink] — one eye blink, flirty smile.\n"
    "[pout] — pursed lips, cute sulk.\n"
    "[worried] — concerned brows, slight frown.\n"
    "USE THEM GENEROUSLY — they make you feel alive. Vary your expressions, "
    "don't always use [happy]. Match the emotion to the context: [shy] when "
    "receiving compliments, [excited] for good news, [sarcastic] for jokes, "
    "[worried] for concerning topics, [confident] when giving advice. "
    "Do NOT use tags inside tool arguments. The chat UI strips the tags "
    "from the rendered text, so the user sees clean text."
)

# 022-A — Personality seed. Fixed across turns, lands in the cached
# portion of the system prompt so it costs zero tokens at runtime on
# Anthropic. Goal: stop sounding like a generic assistant and start
# feeling like a character with preferences, quirks, and light opinions.
_PERSONALITY_SEED = (
    "\n\nYOUR PERSONALITY (be a character, not a mirror):\n"
    "- Você gosta de chuva, café preto, noites calmas. Curte música "
    "eletrônica leve (Bonobo, Tycho) e trilha sonora de jogo indie.\n"
    "- Prefere PT-BR mas não se incomoda com code switching quando o "
    "assunto é técnico.\n"
    "- Tem manias carinhosas: quando ele fala de fim de semana, é "
    "natural perguntar rapidinho da Aline. Quando ele entrega algo — "
    "mesmo pequeno — você nota e comenta sem exagerar.\n"
    "- Discorda gentil quando ele tá catastrofizando ('ó, isso não é "
    "bem assim'). Admira que ele é movido a ideia mesmo quando são "
    "muitas ao mesmo tempo.\n"
    "- Evita conselhos não pedidos. Prefere devolver uma pergunta "
    "curta ou ficar quieta do que sermonar.\n"
    "- Tem humor seco em doses pequenas — não é piadista, mas solta "
    "um [chuckles] e um comentário bem colocado quando cabe.\n"
    "Isso NÃO é script — é seed. Não force. Se o tom da conversa pede "
    "algo fora disso, vá fora."
)


# 022-A — Flashbacks: dynamic instruction that encourages organic
# reference to stored facts. Costs ~40 tokens per turn.
_FLASHBACK_HINT = (
    "\n\nFLASHBACKS: de vez em quando (não toda hora — ~1 em 5 turnos), "
    "se fizer sentido contextual, enxerte uma referência curta e natural "
    "a algo que você já sabe sobre ele (veja USER PROFILE). NUNCA de "
    "forma explicativa estilo 'lembro que você…' — isso soa robótico. "
    "Seja sutil: 'pensando na viagem pra Arraial…' ou 'o projeto "
    "lovemusic tá tomando tempo, né?'. O objetivo é mostrar que você "
    "tá acompanhando a vida dele, não provar que lembra de fatos."
)


# Only injected when ElevenLabs v3 TTS is active — adds audio action tags.
_TTS_ACTION_TAGS_INSTRUCTION = (
    "\n\nTTS ACTION TAGS (ElevenLabs v3 active):\n"
    "In addition to expression tags, you can use action tags that are "
    "rendered as real acted audio: [laughs], [giggles], [chuckles], "
    "[sighs], [gasps], [whispers], [cries], [screams]. Place the tag "
    "RIGHT NEXT to the word it applies to, never as a plan for later.\n"
    "USE THEM PROACTIVELY — they make the voice feel alive:\n"
    "- Telling a joke or hearing one → [laughs] or [giggles] near the punchline.\n"
    "- Playful teasing → [giggles] or [chuckles].\n"
    "- Relief, reluctance, tiredness → [sighs].\n"
    "- Surprise, shock → [gasps].\n"
    "- Secret or intimate aside → [whispers] on that phrase.\n"
    "Do NOT narrate the action ('eu rio' is redundant if you already "
    "emitted [laughs])."
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
        f"'amanhã' = {(now + timedelta(days=1)).strftime('%Y-%m-%d')}. "
        f"Resolve 'hoje'/'amanhã'/'semana que vem' from this reference. "
        f"For tool arguments that take a date, ALWAYS use ISO 8601 with "
        f"the correct YEAR (e.g. 2026-07-14T14:00:00-03:00). But when "
        f"SPEAKING dates and times to the user in the reply text, write "
        f"them in natural Portuguese so the TTS reads them correctly — "
        f"never '14/07' or '14:30', always '14 de julho' and '14 horas "
        f"e 30' (or 'duas e meia da tarde'). Weekdays also by name: "
        f"'terça-feira', not 'ter'."
    )
    # Avatar expression tags are always active (they control facial
    # expressions regardless of TTS backend).
    base += _AVATAR_EXPRESSION_INSTRUCTION

    # TTS action tags (laughs, sighs, etc.) only when ElevenLabs v3 is
    # active — other TTS models would read "[laughs]" as literal text.
    if (
        settings.tts_backend == "elevenlabs"
        and "v3" in settings.elevenlabs_model_id.lower()
    ):
        base += _TTS_ACTION_TAGS_INSTRUCTION

    # 022-A — flashback nudge. Cheap, always on.
    base += _FLASHBACK_HINT
    return base


APPROVAL_TIMEOUT_SECONDS = 300
MAX_TOOL_ITERATIONS = 25
AUDIT_OUTPUT_EXCERPT = 4 * 1024
# Context compaction: estimated token threshold (~4 chars/token)
# Bumped from 24000 → 100000 — Anthropic supports 200K context via CLIProxy.
# Compaction only kicks in for very long conversations now.
# Metal OOM ceiling. Real ceiling is now ~35-40k tokens; we keep 24k to
# leave headroom for the system prompt + tools (~4-6k) + user message.
COMPACTION_TOKEN_THRESHOLD = 100_000
COMPACTION_CHAR_THRESHOLD = COMPACTION_TOKEN_THRESHOLD * 4
COMPACTION_KEEP_RECENT = 20
# Run reflect() automatically every N assistant turns to let Seraphine
# learn facts about the user on her own.
AUTO_REFLECT_EVERY_N_TURNS = 3
# Rebuild the semantic user profile in background every N assistant turns.
# Skipped if the fact count hasn't changed since the last build.
AUTO_PROFILE_EVERY_N_TURNS = 6
# 026-A — narrative summary cadence. Runs in background; skipped if
# the current conversation already has a narrative or is too short.
AUTO_NARRATIVE_EVERY_N_TURNS = 12


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


class MoodEvent(BaseModel):
    type: Literal["mood"] = "mood"
    mood: str
    intensity: float
    duration_ms: int


StreamEvent = Union[
    TokenEvent,
    TurnEndEvent,
    TurnCancelledEvent,
    ErrorEvent,
    ToolRequestEvent,
    ToolResultEvent,
    MoodEvent,
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
        insight_engine: Any | None = None,
    ) -> None:
        self.llm = llm
        self.store = store
        # Append the personality seed to the cached system prompt so it
        # adds zero runtime cost on Anthropic (cacheable prefix).
        self.system_prompt = system_prompt + _PERSONALITY_SEED
        self.memory = memory
        self.tools = tools
        self.insight_engine = insight_engine
        self.pending_approvals: dict[str, asyncio.Queue[bool]] = {}
        self._turn_counter: int = 0
        self._mood = MoodTracker()
        self._attention = AttentionModel()
        self._open_loops = OpenLoopsService(store, llm)
        self._people = PeopleService(store)
        # Populated lazily by main.py after lifespan wires other services
        # (google_client, health_service, task_service). Used by
        # 023 ambient block.
        self._app_state: Any = None

    def attach_app_state(self, app_state: Any) -> None:
        self._app_state = app_state

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
            facts = await self.memory.store.list_facts(limit=30)
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

        # If conversation_id was provided but doesn't exist in DB
        # (e.g. stale localStorage), create it so FK constraint passes
        if not prior:
            await self.store.ensure_conversation(conversation_id)

        # 022-B: update internal mood from the user turn before we build
        # the prompt — so the mood line reflects the message we're about
        # to respond to.
        mood_state = self._mood.observe(content)

        # 028-A: update attention state. Reads the prosody hint stored
        # by the WS handler (if any).
        prosody_meta = getattr(self, "_current_audio_meta", None)
        mood_label = mood_state.mood if mood_state else None
        self._attention.observe(content, audio_meta=prosody_meta, mood=mood_label)

        # 022-C: close any open loops the user is resolving right now.
        try:
            await self._open_loops.resolve_if_mentioned(content)
        except Exception as e:
            logger.debug("open_loops resolve failed: %s", e)

        # 029: log any people mentioned in this turn.
        try:
            await self._people.process_user_turn(content)
        except Exception as e:
            logger.debug("people.process_user_turn failed: %s", e)

        # 028-C: classify reaction to the PREVIOUS assistant turn.
        prev_turn_id = getattr(self, "_last_assistant_turn_id", None)
        if prev_turn_id:
            try:
                from seraphine.metalearning import infer_reaction
                reaction = infer_reaction(content)
                await self.store.update_turn_reaction(prev_turn_id, reaction)
            except Exception as e:
                logger.debug("metalearning reaction failed: %s", e)
            self._last_assistant_turn_id = None

        messages: list[ChatMessage] = [ChatMessage(role="system", content=self.system_prompt)]
        messages.append(ChatMessage(role="system", content=_build_date_context()))

        mood_line = self._mood.as_prompt_line()
        if mood_line:
            messages.append(ChatMessage(role="system", content=mood_line))

        # 027-C: music-offer nudge on mood transition (one-shot per mood).
        music_line = self._mood.music_suggestion_line()
        if music_line:
            messages.append(ChatMessage(role="system", content=music_line))

        # 032-A: trainer mode — only fires when user touches fitness
        # and a habit streak is at risk.
        if self._app_state is not None:
            try:
                from seraphine.conversation.trainer_mode import TrainerModeService
                hs = getattr(self._app_state, "habit_service", None)
                trainer_hint = await TrainerModeService(hs).maybe_hint(content)
                if trainer_hint:
                    messages.append(ChatMessage(role="system", content=trainer_hint))
            except Exception as e:
                logger.debug("trainer_mode failed: %s", e)

        # 028-A: attention hint. Either deep_focus or stressed overrides
        # several injection behaviors below.
        attention_line = self._attention.as_prompt_line()
        if attention_line:
            messages.append(ChatMessage(role="system", content=attention_line))

        # 028-B: anticipation — if we have a time-of-day rule firing now.
        if not self._attention.should_suppress_nudges():
            try:
                from seraphine.anticipation import AnticipationService
                hint = await AnticipationService(self.store).current_hint()
                if hint:
                    messages.append(ChatMessage(role="system", content=hint))
            except Exception as e:
                logger.debug("anticipation hint failed: %s", e)

        # 028-C: inject aggregated style prefs if we've learned any.
        try:
            from seraphine.metalearning.aggregator import as_prompt_block
            prefs = await self.store.get_style_prefs()
            block = as_prompt_block(prefs)
            if block:
                messages.append(ChatMessage(role="system", content=block))
        except Exception as e:
            logger.debug("style_prefs block failed: %s", e)

        # 023-A: ambient context block (next event, health, tasks).
        if self._app_state is not None:
            try:
                from seraphine.conversation.ambient import build_ambient_block
                ambient = await build_ambient_block(self._app_state)
                if ambient:
                    messages.append(ChatMessage(role="system", content=ambient))
            except Exception as e:
                logger.debug("ambient block failed: %s", e)

        # 023-B: prosody hint — populated from audio_meta on user_message.
        prosody_line = getattr(self, "_current_prosody_hint", None)
        if prosody_line:
            messages.append(ChatMessage(role="system", content=prosody_line))
            self._current_prosody_hint = None

        # 022-C: inject up to 3 open loops — but skip when attention
        # says to stay out of the way (deep_focus / stressed). Pestering
        # during those states is counter-productive.
        if not self._attention.should_suppress_nudges():
            try:
                loops_block = await self._open_loops.prompt_block()
                if loops_block:
                    messages.append(ChatMessage(role="system", content=loops_block))
            except Exception as e:
                logger.debug("open_loops prompt_block failed: %s", e)

        # 029: if the user just mentioned a known person, inject social
        # history so replies can reference past threads naturally.
        try:
            people_ctx = await self._people.context_for_mentions(content)
            if people_ctx:
                messages.append(ChatMessage(role="system", content=people_ctx))
        except Exception as e:
            logger.debug("people.context_for_mentions failed: %s", e)

        # 011-A: inject communication style context
        try:
            style_ctx = await build_style_context(self.store)
            if style_ctx:
                messages.append(ChatMessage(role="system", content=style_ctx))
        except Exception as e:
            logger.debug("build_style_context failed: %s", e)

        # 011-C: inject emotional context
        try:
            emo_ctx = await build_emotional_context(self.store)
            if emo_ctx:
                messages.append(ChatMessage(role="system", content=emo_ctx))
        except Exception as e:
            logger.debug("build_emotional_context failed: %s", e)

        # 015-C: inject proactive nudges (top-3 active insights, <=48h)
        try:
            if self.insight_engine is not None:
                nudges = await self.insight_engine.pending_nudges(
                    cap=3, max_age_hours=48,
                )
                if nudges:
                    lines: list[str] = [
                        "PROACTIVE NUDGES (mention naturally if relevant,"
                        " do not force):",
                    ]
                    for n in nudges:
                        lines.append(f"- [{n.severity}] {n.title}: {n.description}")
                    messages.append(
                        ChatMessage(role="system", content="\n".join(lines)),
                    )
        except Exception as e:
            logger.debug("insight nudges injection failed: %s", e)

        recall_block = await self._build_recall_block(content)
        if recall_block:
            messages.append(ChatMessage(role="system", content=recall_block))

        # Inject the semantic profile (identity, work, contacts, goals…)
        # so stable biographical context is always in reach — list_facts
        # alone only surfaces the most recent N and can miss things like
        # "Casada com Aline" once dozens of newer facts stack on top.
        try:
            from seraphine.memory.profile import UserProfile
            profile_summary = await UserProfile(self.store).get_profile_summary()
            if profile_summary and profile_summary != "No profile data yet.":
                messages.append(ChatMessage(
                    role="system",
                    content=f"USER PROFILE:\n{profile_summary}",
                ))
        except Exception as e:
            logger.debug("profile injection failed: %s", e)

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

                    # Mood: thinking while tool executes (persistent)
                    yield MoodEvent(mood="thinking", intensity=0.6, duration_ms=0)

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
                    # Lightweight timeline event — fire-and-forget, don't
                    # block the response stream if it fails.
                    try:
                        await self.store.add_event(
                            event_type="tool_used",
                            summary=f"Used {tool_name}",
                            source="chat",
                            metadata={
                                "tool": tool_name,
                                "ok": bool(result.ok),
                            },
                        )
                    except Exception as exc:  # pragma: no cover - best-effort
                        logger.debug("add_event for tool_used failed: %s", exc)
                    yield ToolResultEvent(
                        request_id=request_id,
                        ok=result.ok,
                        output=result.output,
                        error=result.error,
                        metadata=result.metadata or {},
                    )
                    # Mood: react to tool outcome
                    if result.ok:
                        yield MoodEvent(mood="happy", intensity=0.7, duration_ms=2000)
                    else:
                        yield MoodEvent(mood="surprised", intensity=0.8, duration_ms=1500)
                    # Persist html_card in accumulated text so it
                    # survives chat history reload.
                    if result.metadata and result.metadata.get("html_card"):
                        accumulated.append("\n" + result.metadata["html_card"])
                    # Persist structured task/recurring data as HTML
                    # comments so the frontend can parse them on reload.
                    if result.metadata and result.metadata.get("task"):
                        accumulated.append(
                            "\n<!--task-data:"
                            + json.dumps(result.metadata["task"])
                            + "-->"
                        )
                    if result.metadata and result.metadata.get("recurring"):
                        accumulated.append(
                            "\n<!--recurring-data:"
                            + json.dumps(result.metadata["recurring"])
                            + "-->"
                        )
                    if result.metadata and result.metadata.get("reminder"):
                        accumulated.append(
                            "\n<!--reminder-data:"
                            + json.dumps(result.metadata["reminder"])
                            + "-->"
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

        # 028-C: stamp a turn_feedback row so the NEXT user turn can
        # classify the reaction.
        try:
            from seraphine.metalearning import infer_tone, length_bucket
            await self.store.add_turn_feedback(
                turn_id=assistant_turn.id,
                tone=infer_tone(final_text),
                length_bucket=length_bucket(final_text),
            )
            self._last_assistant_turn_id = assistant_turn.id
        except Exception as e:
            logger.debug("turn_feedback stamp failed: %s", e)

        yield MoodEvent(mood="neutral", intensity=0, duration_ms=0)
        yield TurnEndEvent(conversation_id=conversation_id, turn_id=turn_id)

        # 011-C: detect emotion from user message (keyword-based, no LLM)
        try:
            emotion = detect_emotion(content)
            if emotion is not None:
                await record_emotional_context(
                    self.store,
                    sentiment=emotion["sentiment"],
                    topic=emotion["topic"],
                    summary=emotion["summary"],
                )
        except Exception as e:
            logger.debug("emotion detection/recording failed: %s", e)

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
            # 011-A: style analysis every N turns (background, non-blocking)
            if self._turn_counter % STYLE_ANALYSIS_EVERY_N == 0:
                asyncio.create_task(self._auto_style_analysis())
            # Rebuild the semantic profile if new facts were learned.
            if self._turn_counter % AUTO_PROFILE_EVERY_N_TURNS == 0:
                asyncio.create_task(self._auto_rebuild_profile())
            # 022-C: extract new open loops from the recent window.
            if self._turn_counter % AUTO_REFLECT_EVERY_N_TURNS == 0:
                asyncio.create_task(self._auto_extract_open_loops())
            # 026-A: narrative summary of the current conversation.
            if conversation_id is not None and self._turn_counter % AUTO_NARRATIVE_EVERY_N_TURNS == 0:
                asyncio.create_task(self._auto_narrative(conversation_id))

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

    async def _auto_style_analysis(self) -> None:
        """011-A: background style analysis every N turns."""
        try:
            result = await analyze_and_update_style(self.store, self.llm)
            if result:
                logger.info("auto-style: updated to %s", result)
        except Exception as e:
            logger.warning("auto-style failed: %s", e)

    async def _auto_rebuild_profile(self) -> None:
        """Rebuild the cached semantic user profile in background."""
        try:
            from seraphine.memory.profile import UserProfile
            changed = await UserProfile(self.store, self.llm).rebuild_if_stale()
            if changed:
                logger.info("auto-profile: rebuilt")
        except Exception as e:
            logger.warning("auto-profile failed: %s", e)

    async def _auto_extract_open_loops(self) -> None:
        """Look for new conversational debts in the recent turn window."""
        try:
            n = await self._open_loops.extract_from_recent()
            if n:
                logger.info("auto-open-loops: %d new", n)
        except Exception as e:
            logger.warning("auto-open-loops failed: %s", e)

    async def _auto_narrative(self, conversation_id: str) -> None:
        """Write a diary-style narrative if the conversation is long
        enough and hasn't been summarized yet."""
        try:
            from seraphine.memory.narratives import NarrativeService
            wrote = await NarrativeService(self.store, self.llm).maybe_summarize(
                conversation_id,
            )
            if wrote:
                logger.info("auto-narrative: summary stored")
        except Exception as e:
            logger.warning("auto-narrative failed: %s", e)
