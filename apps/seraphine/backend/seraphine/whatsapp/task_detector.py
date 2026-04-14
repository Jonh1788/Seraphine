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
        from llm_adapters.anthropic import AnthropicClient

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

    # ── notify user ─────────────────────────────────────────────────

    async def _notify_user(
        self, chat_name: str, author: str, analysis: TaskAnalysis,
        chat_id: str = "",
    ) -> None:
        """Notify the user about a detected task.

        1. Persist notification in DB (survives disconnect)
        2. Push to connected WS clients (chat bubble + browser notification)
        3. Email fallback if no WS clients connected

        Does NOT auto-reply on WhatsApp — the LLM decides how to respond
        via whatsapp_send_message or whatsapp_send_voice tools.
        """
        urgency_icon = {
            "alta": "🔴", "media": "🟡", "baixa": "🟢",
        }.get(analysis.urgency, "🟡")

        # Build message for the chat — include chat_id so the LLM can reply
        text = (
            f"💬 **WhatsApp — {author}** ({chat_name})\n\n"
            f"{urgency_icon} **Mensagem:** {analysis.summary}\n\n"
            f"Chat ID: `{chat_id}`\n"
            f"Quer que eu responda?"
        )

        # 1. Persist notification in DB — survives disconnect
        store = getattr(self._app_state, "store", None)
        if store is not None:
            try:
                await store.add_notification(
                    event="whatsapp.task_detected",
                    task_id=chat_id,
                    title=f"💬 WhatsApp — {author} ({chat_name})",
                    summary=f"{urgency_icon} {analysis.summary or 'tarefa detectada'}",
                    payload=json.dumps({
                        "chat_id": chat_id, "chat_name": chat_name,
                        "author": author, "urgency": analysis.urgency,
                        "summary": analysis.summary,
                    }, ensure_ascii=False),
                )
            except Exception as exc:
                logger.warning("Failed to persist task notification: %s", exc)

            # Also log to the memory timeline (lightweight).
            try:
                await store.add_event(
                    event_type="whatsapp_task",
                    summary=(analysis.summary or "WhatsApp task detected")[:200],
                    source="whatsapp",
                    metadata={
                        "author": author,
                        "chat_name": chat_name,
                        "chat_id": chat_id,
                        "urgency": analysis.urgency,
                    },
                )
            except Exception as exc:
                logger.debug("add_event for whatsapp_task failed: %s", exc)

        # 2. Push to connected WS clients
        ws_clients: set = getattr(self._app_state, "ws_clients", set())
        delivered_to_ws = False
        dead: list[Any] = []
        for ws in ws_clients:
            try:
                # Chat bubble
                turn_id = str(uuid.uuid4())
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
                # Browser notification for urgent tasks
                if analysis.urgency in ("alta", "media"):
                    await ws.send_json({
                        "type": "notification",
                        "source": "whatsapp",
                        "event": "task_detected",
                        "title": f"WhatsApp — {author}",
                        "message": analysis.summary or "Tarefa detectada",
                        "status": analysis.urgency,
                    })
                # TTS for alta urgency
                if analysis.urgency == "alta":
                    try:
                        from seraphine.ws.routes import _enqueue_speech
                        await _enqueue_speech(
                            ws,
                            f"Atenção! Mensagem urgente de {author}: {analysis.summary}",
                            turn_id,
                        )
                    except Exception:
                        pass
                delivered_to_ws = True
            except Exception:
                dead.append(ws)
        for ws in dead:
            ws_clients.discard(ws)

        # 3. Web Push fallback if no WS client connected
        if not delivered_to_ws:
            push = getattr(self._app_state, "push_service", None)
            if push:
                try:
                    await push.send_notification(
                        title=f"WhatsApp — {author}",
                        body=analysis.summary or "Tarefa detectada",
                        url="/?view=whatsapp",
                        tag=f"wa-task-{chat_id}",
                    )
                except Exception as exc:
                    logger.warning("Web Push send failed: %s", exc)

        # 4. Email fallback if no WS client connected
        if not delivered_to_ws:
            logger.info("No WS clients — scheduling email fallback for task from %s", author)
            asyncio.create_task(
                self._email_fallback(author, chat_name, analysis)
            )

    async def _email_fallback(
        self, author: str, chat_name: str, analysis: TaskAnalysis,
    ) -> None:
        """Wait 60s, then send email if still no WS client connected."""
        await asyncio.sleep(60)

        # Re-check: maybe a client reconnected
        ws_clients: set = getattr(self._app_state, "ws_clients", set())
        if ws_clients:
            logger.info("WS client reconnected, skipping email fallback for task from %s", author)
            return

        google_client = getattr(self._app_state, "google_client", None)
        if google_client is None:
            return

        try:
            authed = await google_client.is_authed()
            if not authed:
                return
        except Exception:
            return

        try:
            from seraphine.google.client import GMAIL_API
            import base64
            from email.mime.text import MIMEText

            profile = await google_client._authed_request("GET", f"{GMAIL_API}/users/me/profile")
            user_email = profile.json().get("emailAddress", "")
            if not user_email:
                return

            urgency_label = {"alta": "🔴 URGENTE", "media": "🟡 Média", "baixa": "🟢 Baixa"}.get(
                analysis.urgency, analysis.urgency
            )
            mime = MIMEText(
                f"💬 WhatsApp — {author} ({chat_name})\n\n"
                f"Urgência: {urgency_label}\n"
                f"Tarefa: {analysis.summary}\n\n"
                f"Mensagens originais:\n{analysis.original_messages}\n\n"
                f"(Este email foi enviado porque o frontend da Seraphine estava fechado.)",
                _charset="utf-8",
            )
            mime["To"] = user_email
            mime["Subject"] = f"💬 WhatsApp Task — {author}: {(analysis.summary or '')[:50]}"
            raw = base64.urlsafe_b64encode(mime.as_bytes()).decode("ascii")

            await google_client._authed_request(
                "POST", f"{GMAIL_API}/users/me/messages/send", json={"raw": raw},
            )
            logger.info("Task email fallback sent to %s for task from %s", user_email, author)
        except Exception as exc:
            logger.warning("Task email fallback failed: %s", exc)
