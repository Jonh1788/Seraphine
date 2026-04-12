"""WhatsApp task detection service.

Groups incoming messages per chat into a time-windowed buffer, then
analyses the batch to detect actionable tasks directed at the user.

Only surfaces tasks in the frontend chat when:
- The message is from a DIRECT chat (not group), OR
- The message in a group explicitly mentions the user

Auto-acknowledges on WhatsApp for medium/high urgency tasks.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import uuid
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger("seraphine.whatsapp.task_detector")

# How long (seconds) to wait after the last message before analysing
_BUFFER_WINDOW_S = 20.0

# ── Filters ──────────────────────────────────────────────────────

# Group chats end with @g.us, direct chats end with @c.us
_GROUP_SUFFIX = "@g.us"

# Patterns that indicate this is NOT a task (skip analysis)
_SKIP_PATTERNS = re.compile(
    r"^(?:\s*(?:oi|olá|ola|eai|eae|fala|bom\s+dia|boa\s+tarde|boa\s+noite"
    r"|valeu|obrigad[oa]|kk+|haha+|rs+|👍|😂|🤣|😅|❤️|🙏|ok|blz|tmj"
    r"|show|top|massa|dahora|suave)\s*)+$",
    re.IGNORECASE,
)

# User identifiers for mention detection in groups
_USER_MENTIONS = {"jonathan", "557388836445", "jonh"}

# Urgency keywords
_URGENCY_KW = re.compile(
    r"\b(?:urgente|agora|imediatamente|o\s+mais\s+rápido|asap|emergência|socorro)\b",
    re.IGNORECASE,
)


@dataclass
class BufferedMessage:
    chat_id: str
    chat_name: str
    author: str
    body: str
    message_id: str
    timestamp: float


@dataclass
class TaskAnalysis:
    is_task: bool = False
    summary: str | None = None
    urgency: str = "media"  # alta | media | baixa
    original_messages: str = ""


class WhatsAppTaskDetector:
    """Background service that buffers incoming WhatsApp messages and
    runs task detection once a chat goes quiet for ``_BUFFER_WINDOW_S``
    seconds. Only notifies for actual tasks. Auto-acknowledges on
    WhatsApp for medium/high urgency tasks."""

    def __init__(
        self,
        app_state: Any,
        whatsapp_client: Any,
        llm_client: Any | None = None,
    ) -> None:
        self._app_state = app_state
        self._wa_client = whatsapp_client
        self._llm = llm_client
        self._buffers: dict[str, list[BufferedMessage]] = {}
        self._timers: dict[str, asyncio.Task[None]] = {}

    # ── public entry point (called from webhook) ──────────────────

    async def on_message(
        self,
        chat_id: str,
        chat_name: str,
        author: str,
        body: str,
        message_id: str,
        timestamp: Any,
        from_me: bool,
    ) -> None:
        """Buffer an incoming message and (re)start the analysis timer."""
        if from_me or not body or not body.strip():
            return

        # Quick filter: skip obvious non-task messages
        if _SKIP_PATTERNS.match(body.strip()):
            return

        # For groups: only buffer if user is explicitly mentioned.
        # Note: routes.py _is_important() is less strict (also flags urgency
        # keywords without mention) — that's intentional. The badge/notification
        # system is broad; task detection is conservative.
        if chat_id.endswith(_GROUP_SUFFIX):
            lower = body.lower()
            mentions_user = any(m in lower for m in _USER_MENTIONS)
            if not mentions_user:
                return  # Group chatter not directed at user — ignore silently

        ts = float(timestamp) if timestamp else time.time()
        msg = BufferedMessage(
            chat_id=chat_id, chat_name=chat_name, author=author,
            body=body, message_id=message_id, timestamp=ts,
        )

        self._buffers.setdefault(chat_id, []).append(msg)

        # Cancel existing timer and start a new one
        existing = self._timers.pop(chat_id, None)
        if existing is not None and not existing.done():
            existing.cancel()

        self._timers[chat_id] = asyncio.create_task(
            self._delayed_analyse(chat_id)
        )

    # ── timer / analysis pipeline ─────────────────────────────────

    async def _delayed_analyse(self, chat_id: str) -> None:
        try:
            await asyncio.sleep(_BUFFER_WINDOW_S)
        except asyncio.CancelledError:
            return
        await self._analyse_buffer(chat_id)

    async def _analyse_buffer(self, chat_id: str) -> None:
        messages = self._buffers.pop(chat_id, [])
        self._timers.pop(chat_id, None)
        if not messages:
            return

        chat_name = messages[0].chat_name
        authors = [m.author for m in messages if m.author]
        author = max(set(authors), key=authors.count) if authors else chat_name
        combined_text = "\n".join(f"{m.author}: {m.body}" for m in messages)

        logger.info(
            "Analysing %d buffered message(s) from %s in %s",
            len(messages), author, chat_name,
        )

        analysis = await self._run_analysis(chat_name, author, combined_text)

        if analysis.is_task:
            logger.info("Task detected from %s: %s", author, (analysis.summary or "")[:80])
            await self._notify_user(chat_name, author, analysis, chat_id=chat_id)
        else:
            logger.debug("No task detected from %s in %s", author, chat_name)

    # ── LLM-based analysis ────────────────────────────────────────

    async def _run_analysis(
        self, chat_name: str, author: str, combined_text: str,
    ) -> TaskAnalysis:
        if self._llm is not None:
            try:
                return await self._llm_analyse(chat_name, author, combined_text)
            except Exception as exc:
                logger.warning("LLM analysis failed: %s", exc)
        return TaskAnalysis(is_task=False)  # Without LLM, don't guess

    async def _llm_analyse(
        self, chat_name: str, author: str, combined_text: str,
    ) -> TaskAnalysis:
        from seraphine.llm.anthropic import AnthropicClient

        llm = self._llm
        if not isinstance(llm, AnthropicClient):
            return TaskAnalysis(is_task=False)

        prompt = (
            "Você é Seraphine, assistente pessoal de Jonathan. "
            "Analise estas mensagens do WhatsApp e determine se contêm "
            "um pedido de tarefa, ação ou informação importante direcionada a Jonathan.\n\n"
            "REGRAS:\n"
            "- Conversa casual, memes, piadas, fofoca NÃO são tarefas\n"
            "- Só é tarefa se alguém está PEDINDO algo a Jonathan ou informando algo que ele PRECISA saber/agir\n"
            "- Mensagens de grupo genéricas (não direcionadas a Jonathan) NÃO são tarefas\n"
            "- Seja conservador: na dúvida, NÃO é tarefa\n\n"
            f'Mensagens de "{author}" no chat "{chat_name}":\n'
            f"{combined_text}\n\n"
            "Responda SOMENTE JSON:\n"
            '{"is_task": false} se NÃO for tarefa\n'
            '{"is_task": true, "summary": "resumo claro e detalhado do que foi pedido", '
            '"urgency": "alta"|"media"|"baixa"} se FOR tarefa'
        )

        body: dict[str, Any] = {
            "model": "claude-sonnet-4-20250514",
            "max_tokens": 200,
            "temperature": 0.1,
            "messages": [{"role": "user", "content": prompt}],
            "stream": False,
        }

        resp = await llm._client.post("/v1/messages", json=body, timeout=30.0)
        resp.raise_for_status()
        data = resp.json()

        text = ""
        for block in data.get("content", []):
            if block.get("type") == "text":
                text += block.get("text", "")

        text = text.strip()
        if text.startswith("```"):
            text = re.sub(r"^```(?:json)?\s*", "", text)
            text = re.sub(r"\s*```$", "", text)

        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            logger.warning("LLM returned invalid JSON for task analysis: %s", text[:200])
            return TaskAnalysis(is_task=False)

        if not parsed.get("is_task", False):
            return TaskAnalysis(is_task=False)

        return TaskAnalysis(
            is_task=True,
            summary=parsed.get("summary"),
            urgency=parsed.get("urgency", "media"),
            original_messages=combined_text,
        )

    # ── notify user in frontend chat ──────────────────────────────

    async def _notify_user(
        self, chat_name: str, author: str, analysis: TaskAnalysis,
        chat_id: str = "",
    ) -> None:
        """Inject task suggestion into the frontend chat.
        Auto-acknowledges on WhatsApp for media/alta urgency tasks."""
        urgency_icon = {
            "alta": "🔴", "media": "🟡", "baixa": "🟢",
        }.get(analysis.urgency, "🟡")

        # Auto-acknowledge on WhatsApp for medium/high urgency
        auto_replied = False
        if analysis.urgency in ("alta", "media") and chat_id and self._wa_client:
            try:
                ack = "Oi! Vi sua mensagem, já vou verificar. 👍"
                if analysis.urgency == "alta":
                    ack = "Vi! Já estou cuidando disso. 🚀"
                await self._wa_client.send_message(chat_id=chat_id, message=ack)
                auto_replied = True
                logger.info("Auto-acknowledged on WhatsApp to %s", author)
            except Exception as exc:
                logger.warning("Failed to auto-acknowledge on WhatsApp: %s", exc)

        reply_note = " *(já respondi no WhatsApp)*" if auto_replied else ""
        text = (
            f"💬 **WhatsApp — {author}** ({chat_name})\n\n"
            f"{urgency_icon} **Tarefa detectada:** {analysis.summary}{reply_note}\n\n"
            f"Quer que eu cuide disso?"
        )

        ws_clients: set = getattr(self._app_state, "ws_clients", set())
        if not ws_clients:
            logger.debug("No WS clients — task notification not delivered")
            return

        turn_id = str(uuid.uuid4())
        dead: list[Any] = []
        for ws in ws_clients:
            try:
                await ws.send_json({
                    "type": "token",
                    "conversation_id": "system",
                    "turn_id": turn_id,
                    "text": text,
                })
                await ws.send_json({
                    "type": "turn_end",
                    "conversation_id": "system",
                    "turn_id": turn_id,
                })
            except Exception:
                dead.append(ws)
        for ws in dead:
            ws_clients.discard(ws)
