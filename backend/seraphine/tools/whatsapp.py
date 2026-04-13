"""WhatsApp tools for the LLM (Phase A read + Phase B send).

Read tools (``requires_confirmation=False``):

- ``whatsapp_auth_status`` -- bridge connected? whose phone?
- ``whatsapp_list_chats`` -- recent chats with unread count
- ``whatsapp_read_messages`` -- messages from a specific chat
- ``whatsapp_search_messages`` -- search message history

Write tools (``requires_confirmation=True``, approval gate):

- ``whatsapp_send_message`` -- send a text message
- ``whatsapp_send_voice`` -- send a voice note (TTS -> ogg/opus)
"""

from __future__ import annotations

import base64
import logging
from datetime import datetime, timezone
from typing import Any

from seraphine.tools.base import Tool, ToolResult
from seraphine.tts.base import TTSAdapter
from seraphine.whatsapp.client import WhatsAppBridgeClient, WhatsAppBridgeError

logger = logging.getLogger(__name__)


def _not_connected_result() -> ToolResult:
    return ToolResult(
        ok=False,
        error=(
            "WhatsApp nao esta conectado. O bridge pode estar offline "
            "ou o QR code ainda nao foi escaneado."
        ),
    )


async def _check_connected(client: WhatsAppBridgeClient) -> dict | None:
    """Return status dict if connected, or None if not ready."""
    try:
        status = await client.status()
    except Exception:
        return None
    if status.get("status") != "ready":
        return None
    return status


class WhatsAppAuthStatusTool(Tool):
    name = "whatsapp_auth_status"
    description = (
        "Check whether the WhatsApp bridge is connected and which phone "
        "number / profile name is linked. Use when the user asks 'meu "
        "WhatsApp ta conectado?', 'qual numero ta logado?', or before "
        "any WhatsApp operation if you are unsure of the connection state."
    )
    json_schema: dict[str, Any] = {"type": "object", "properties": {}}
    requires_confirmation = False
    category = "network"

    def __init__(self, client: WhatsAppBridgeClient) -> None:
        self._client = client

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        try:
            status = await self._client.status()
        except Exception as e:
            return ToolResult(ok=False, error=f"bridge unreachable: {e}")

        st = status.get("status", "disconnected")
        if st != "ready":
            return ToolResult(
                ok=True,
                output=f"WhatsApp nao conectado (status: {st}).",
                metadata={"connected": False, "status": st},
            )

        name = status.get("name", "?")
        phone = status.get("phone", "?")
        return ToolResult(
            ok=True,
            output=f"WhatsApp conectado como {name} ({phone})",
            metadata={
                "connected": True,
                "status": st,
                "name": name,
                "phone": phone,
            },
        )


class WhatsAppListChatsTool(Tool):
    name = "whatsapp_list_chats"
    description = (
        "List the user's recent WhatsApp chats with last message preview "
        "and unread count. Use when the user asks 'quem me mandou mensagem?', "
        "'tem alguma mensagem nova?', 'o que tem no WhatsApp?', 'mensagens "
        "nao lidas'. Each chat has a chat_id -- pass it to "
        "whatsapp_read_messages to see the full conversation or to "
        "whatsapp_send_message to reply."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "limit": {
                "type": "integer",
                "description": "Max chats to return (default 20, max 50).",
            },
            "unread_only": {
                "type": "boolean",
                "description": "If true, only return chats with unread messages.",
            },
        },
    }
    requires_confirmation = False
    category = "network"

    def __init__(self, client: WhatsAppBridgeClient) -> None:
        self._client = client

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        status = await _check_connected(self._client)
        if status is None:
            return _not_connected_result()

        limit = int(args.get("limit") or 20)
        limit = max(1, min(limit, 50))
        unread_only = bool(args.get("unread_only", False))

        try:
            chats = await self._client.list_chats(
                limit=limit, unread_only=unread_only
            )
        except WhatsAppBridgeError as e:
            return ToolResult(ok=False, error=f"list chats failed: {e}")
        except Exception as e:
            return ToolResult(ok=False, error=f"bridge error: {e}")

        if not chats:
            return ToolResult(
                ok=True,
                output="Nenhuma conversa encontrada.",
                metadata={"count": 0, "chats": []},
            )

        lines: list[str] = []
        for chat in chats:
            cid = chat.get("id", "")
            name = chat.get("name", "(sem nome)")
            unread = chat.get("unreadCount", 0)
            last = chat.get("lastMessage", {})
            preview = last.get("body", "")[:80] if last else ""
            group = " [grupo]" if chat.get("isGroup") else ""
            line = f'chat_id={cid} | {name}{group} | unread={unread} | "{preview}"'
            lines.append(line)

        return ToolResult(
            ok=True,
            output="\n".join(lines),
            metadata={"count": len(chats), "chats": chats},
        )


class WhatsAppReadMessagesTool(Tool):
    name = "whatsapp_read_messages"
    description = (
        "Read messages from a specific WhatsApp chat. Use after "
        "whatsapp_list_chats to dive into a conversation the user asks "
        "about ('o que o Rodrigo falou?', 'le as mensagens do grupo do "
        "trabalho', 'mostra o chat com a Juliana'). Returns the last N "
        "messages with author, timestamp, and quoted replies."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "chat_id": {
                "type": "string",
                "description": "Chat ID from whatsapp_list_chats (e.g. 5573999887766@c.us).",
            },
            "limit": {
                "type": "integer",
                "description": "Max messages to return (default 30, max 100).",
            },
        },
        "required": ["chat_id"],
    }
    requires_confirmation = False
    category = "network"

    def __init__(self, client: WhatsAppBridgeClient) -> None:
        self._client = client

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        status = await _check_connected(self._client)
        if status is None:
            return _not_connected_result()

        chat_id = args.get("chat_id")
        if not chat_id:
            return ToolResult(ok=False, error="chat_id is required")

        limit = int(args.get("limit") or 30)
        limit = max(1, min(limit, 100))

        try:
            data = await self._client.read_messages(str(chat_id), limit=limit)
        except WhatsAppBridgeError as e:
            return ToolResult(ok=False, error=f"read messages failed: {e}")
        except Exception as e:
            return ToolResult(ok=False, error=f"bridge error: {e}")

        messages = data.get("messages", [])
        chat_name = data.get("chatName", chat_id)

        if not messages:
            return ToolResult(
                ok=True,
                output=f"Nenhuma mensagem em {chat_name}.",
                metadata={"chatId": chat_id, "chatName": chat_name, "count": 0},
            )

        lines: list[str] = []
        for msg in messages:
            author = msg.get("author", "?")
            ts = msg.get("timestamp", 0)
            try:
                dt = datetime.fromtimestamp(ts, tz=timezone.utc)
                time_str = dt.strftime("%d/%m %H:%M")
            except (OSError, ValueError):
                time_str = str(ts)
            body = msg.get("body", "")
            msg_type = msg.get("type", "chat")
            mid = msg.get("id", "")

            prefix = f"[{time_str}] {author}"
            if msg_type != "chat":
                prefix += f" ({msg_type})"

            quoted = msg.get("quotedMsg")
            if quoted:
                q_author = quoted.get("author", "?")
                q_body = quoted.get("body", "")[:60]
                lines.append(f'{prefix} (reply to {q_author}: "{q_body}"): {body}')
            else:
                lines.append(f"{prefix}: {body}")

        header = f"Chat: {chat_name} ({len(messages)} msgs)"
        return ToolResult(
            ok=True,
            output=header + "\n" + "\n".join(lines),
            metadata={
                "chatId": chat_id,
                "chatName": chat_name,
                "count": len(messages),
                "messages": messages,
            },
        )


class WhatsAppSendMessageTool(Tool):
    name = "whatsapp_send_message"
    description = (
        "Send a text message on WhatsApp on behalf of the user. ALWAYS "
        "requires user approval before sending. Use when the user says "
        "'manda pro Rodrigo que vou chegar atrasado', 'responde pra "
        "Juliana dizendo X', 'envia uma mensagem pro grupo'. The chat_id "
        "comes from whatsapp_list_chats or whatsapp_search_messages."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "chat_id": {
                "type": "string",
                "description": "Chat ID from whatsapp_list_chats.",
            },
            "message": {
                "type": "string",
                "description": "Text message to send.",
            },
            "quote_msg_id": {
                "type": "string",
                "description": "Optional message ID to reply to (thread reply).",
            },
        },
        "required": ["chat_id", "message"],
    }
    requires_confirmation = True
    category = "network"

    def __init__(self, client: WhatsAppBridgeClient) -> None:
        self._client = client

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        status = await _check_connected(self._client)
        if status is None:
            return _not_connected_result()

        chat_id = args.get("chat_id")
        message = args.get("message")
        if not chat_id or not message:
            return ToolResult(
                ok=False, error="chat_id and message are required"
            )

        quote_msg_id = args.get("quote_msg_id") or None

        try:
            result = await self._client.send_message(
                str(chat_id), str(message), quote_msg_id=quote_msg_id
            )
        except WhatsAppBridgeError as e:
            return ToolResult(ok=False, error=f"send failed: {e}")
        except Exception as e:
            return ToolResult(ok=False, error=f"bridge error: {e}")

        mid = result.get("messageId", "")
        return ToolResult(
            ok=True,
            output=f"Mensagem enviada (id={mid})",
            metadata={"messageId": mid, "chatId": chat_id},
        )


class WhatsAppSearchMessagesTool(Tool):
    name = "whatsapp_search_messages"
    description = (
        "Search WhatsApp message history by text. Use when the user asks "
        "'procura no WhatsApp sobre reuniao', 'o que alguem falou sobre X', "
        "'busca mensagens sobre viagem'. Optionally restrict to a specific "
        "chat with chat_id."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Text to search for in messages.",
            },
            "chat_id": {
                "type": "string",
                "description": "Optional: restrict search to a specific chat.",
            },
            "limit": {
                "type": "integer",
                "description": "Max results to return (default 20, max 50).",
            },
        },
        "required": ["query"],
    }
    requires_confirmation = False
    category = "network"

    def __init__(self, client: WhatsAppBridgeClient) -> None:
        self._client = client

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        status = await _check_connected(self._client)
        if status is None:
            return _not_connected_result()

        query = args.get("query")
        if not query:
            return ToolResult(ok=False, error="query is required")

        chat_id = args.get("chat_id") or None
        limit = int(args.get("limit") or 20)
        limit = max(1, min(limit, 50))

        try:
            results = await self._client.search(
                str(query), chat_id=chat_id, limit=limit
            )
        except WhatsAppBridgeError as e:
            return ToolResult(ok=False, error=f"search failed: {e}")
        except Exception as e:
            return ToolResult(ok=False, error=f"bridge error: {e}")

        if not results:
            return ToolResult(
                ok=True,
                output=f'Nenhuma mensagem encontrada para "{query}".',
                metadata={"count": 0, "results": []},
            )

        lines: list[str] = []
        for r in results:
            cid = r.get("chatId", "")
            cname = r.get("chatName", "?")
            msg = r.get("message", {})
            author = msg.get("author", "?")
            body = msg.get("body", "")
            ts = msg.get("timestamp", 0)
            try:
                dt = datetime.fromtimestamp(ts, tz=timezone.utc)
                time_str = dt.strftime("%d/%m %H:%M")
            except (OSError, ValueError):
                time_str = str(ts)
            lines.append(
                f'chat_id={cid} | {cname} | [{time_str}] {author}: "{body}"'
            )

        return ToolResult(
            ok=True,
            output="\n".join(lines),
            metadata={"count": len(results), "results": results},
        )


class WhatsAppSendVoiceTool(Tool):
    name = "whatsapp_send_voice"
    description = (
        "Send a voice message on WhatsApp. Generates speech audio from text "
        "using text-to-speech (ElevenLabs v3) and sends it as a voice note. "
        "Use when the user wants to send an audio/voice message on WhatsApp. "
        "Triggers: 'manda um audio', 'envia uma mensagem de voz', "
        "'fala pra ele por audio'.\n\n"
        "IMPORTANT: Include ElevenLabs v3 emotion tags in the text to make "
        "the voice expressive and natural. Available tags:\n"
        "  [laughs] [sighs] [gasps] [clears throat] [sniffs]\n"
        "  [excited] [sad] [angry] [whispers] [shouting]\n"
        "Example: '[excited] Oi! Que bom falar com voce! [laughs]'\n"
        "Use tags sparingly and naturally — match the emotion to the context."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "chat_id": {
                "type": "string",
                "description": "Chat ID from whatsapp_list_chats.",
            },
            "text": {
                "type": "string",
                "description": (
                    "Text to convert to speech. Include ElevenLabs v3 emotion "
                    "tags like [laughs], [excited], [sighs] for natural, "
                    "expressive voice. Example: '[excited] Oi! Tudo pronto! [laughs]'"
                ),
            },
            "quote_msg_id": {
                "type": "string",
                "description": "Optional message ID to reply to (thread reply).",
            },
        },
        "required": ["chat_id", "text"],
    }
    requires_confirmation = True
    category = "network"

    def __init__(
        self, client: WhatsAppBridgeClient, tts: TTSAdapter
    ) -> None:
        self._client = client
        self._tts = tts

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        status = await _check_connected(self._client)
        if status is None:
            return _not_connected_result()

        chat_id = args.get("chat_id")
        text = args.get("text")
        if not chat_id or not text:
            return ToolResult(ok=False, error="chat_id and text are required")

        quote_msg_id = args.get("quote_msg_id") or None

        # 1. Synthesize speech as ogg/opus
        try:
            ogg_bytes = await self._tts.synthesize_ogg(str(text))
        except NotImplementedError:
            return ToolResult(
                ok=False,
                error="O backend de TTS atual nao suporta geracao de audio ogg/opus.",
            )
        except Exception as e:
            logger.exception("TTS synthesize_ogg failed")
            return ToolResult(ok=False, error=f"TTS failed: {e}")

        if not ogg_bytes:
            return ToolResult(ok=False, error="TTS returned empty audio")

        # 2. Base64-encode and send via bridge
        audio_b64 = base64.b64encode(ogg_bytes).decode("ascii")

        try:
            result = await self._client.send_voice(
                str(chat_id), audio_b64, quote_msg_id=quote_msg_id
            )
        except WhatsAppBridgeError as e:
            return ToolResult(ok=False, error=f"send voice failed: {e}")
        except Exception as e:
            return ToolResult(ok=False, error=f"bridge error: {e}")

        mid = result.get("messageId", "")
        return ToolResult(
            ok=True,
            output=f"Audio enviado (id={mid})",
            metadata={"messageId": mid, "chatId": chat_id},
        )
