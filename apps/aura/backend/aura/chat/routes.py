"""Conversational chat — persistent, JWT-protected, streaming.

Endpoints:
- GET    /chat/conversations                           list user's conversations
- POST   /chat/conversations           {title?}         create empty conversation → {id}
- GET    /chat/conversations/{id}                      conversation + all messages
- DELETE /chat/conversations/{id}                      delete (cascades to messages)
- POST   /chat/conversations/{id}/messages  {content}   stream assistant reply (SSE);
                                                       persists user msg + final reply

Legacy:
- POST /chat/messages/sync   stateless, drains stream into a single response
"""

from __future__ import annotations

import dataclasses
import json
import logging
from typing import Any, AsyncIterator, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from llm_adapters import AnthropicClient
from llm_adapters.types import ChatMessage
from mod_tasks.routes import get_current_user_id

from aura.chat.service import ConversationService

router = APIRouter(prefix="/chat", tags=["chat"])
logger = logging.getLogger(__name__)


# ----------------------------------------------------------------------
# Pydantic bodies
# ----------------------------------------------------------------------

class ChatMessageBody(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class StatelessChatRequest(BaseModel):
    messages: list[ChatMessageBody] = Field(min_length=1)


class StatelessChatResponse(BaseModel):
    reply: str


class CreateConversationBody(BaseModel):
    title: str | None = None


class SendMessageBody(BaseModel):
    content: str = Field(min_length=1, max_length=8000)


# ----------------------------------------------------------------------
# Constants
# ----------------------------------------------------------------------

_SYSTEM_PROMPT = (
    "Você é Aura, uma assistente pessoal calorosa e direta. "
    "Responde em português brasileiro, com clareza e empatia. "
    "Quando o usuário falar de tarefas, finanças, agenda ou hábitos, "
    "ofereça próximos passos práticos. Não invente dados que você não "
    "tem acesso — diga que pode ser configurado em integrações."
)

_TITLE_PROMPT = (
    "Resuma o tópico desta conversa em 3 a 5 palavras, em português, "
    "sem aspas e sem pontuação final. Apenas o título, nada mais."
)


# ----------------------------------------------------------------------
# Dependencies
# ----------------------------------------------------------------------

def _llm_or_503(request: Request) -> AnthropicClient:
    llm: Optional[AnthropicClient] = getattr(request.app.state, "llm", None)
    if llm is None:
        raise HTTPException(
            status_code=503,
            detail="chat indisponível: AURA_ANTHROPIC_API_KEY não configurado",
        )
    return llm


def _service_or_503(request: Request) -> ConversationService:
    svc: Optional[ConversationService] = getattr(
        request.app.state, "conversations_service", None,
    )
    if svc is None:
        raise HTTPException(status_code=503, detail="chat service não configurado")
    return svc


def _require_user(user_id: str | None) -> str:
    if user_id is None:
        raise HTTPException(status_code=401, detail="autenticação requerida")
    return user_id


# ----------------------------------------------------------------------
# Conversations CRUD
# ----------------------------------------------------------------------

@router.get("/conversations")
async def list_conversations(
    request: Request,
    limit: int = 50,
    user_id: str | None = Depends(get_current_user_id),
) -> dict[str, Any]:
    uid = _require_user(user_id)
    svc = _service_or_503(request)
    rows = await svc.list_conversations(uid, limit=limit)
    return {"conversations": [dataclasses.asdict(r) for r in rows]}


@router.post("/conversations")
async def create_conversation(
    request: Request,
    body: CreateConversationBody,
    user_id: str | None = Depends(get_current_user_id),
) -> dict[str, Any]:
    uid = _require_user(user_id)
    svc = _service_or_503(request)
    cid = await svc.create_conversation(uid, body.title)
    return {"id": cid, "ok": True}


@router.get("/conversations/{conversation_id}")
async def get_conversation(
    request: Request,
    conversation_id: str,
    user_id: str | None = Depends(get_current_user_id),
) -> dict[str, Any]:
    uid = _require_user(user_id)
    svc = _service_or_503(request)
    detail = await svc.get_conversation(conversation_id, uid)
    if detail is None:
        raise HTTPException(status_code=404, detail="conversa não encontrada")
    return dataclasses.asdict(detail)


@router.delete("/conversations/{conversation_id}")
async def delete_conversation(
    request: Request,
    conversation_id: str,
    user_id: str | None = Depends(get_current_user_id),
) -> dict[str, bool]:
    uid = _require_user(user_id)
    svc = _service_or_503(request)
    affected = await svc.delete_conversation(conversation_id, uid)
    if not affected:
        raise HTTPException(status_code=404, detail="conversa não encontrada")
    return {"ok": True}


# ----------------------------------------------------------------------
# Streaming reply (persistent)
# ----------------------------------------------------------------------

async def _generate_title(llm: AnthropicClient, first_user: str, first_reply: str) -> str:
    msgs = [
        ChatMessage(role="system", content=_TITLE_PROMPT),
        ChatMessage(role="user", content=f"Usuário: {first_user}\n\nAura: {first_reply}"),
    ]
    parts: list[str] = []
    async for token in llm.chat(msgs, think=False):
        if token.text:
            parts.append(token.text)
        if token.done:
            break
    title = "".join(parts).strip().strip('"').strip("'")
    return title[:80] or "Conversa"


@router.post("/conversations/{conversation_id}/messages")
async def stream_message(
    request: Request,
    conversation_id: str,
    body: SendMessageBody,
    user_id: str | None = Depends(get_current_user_id),
) -> StreamingResponse:
    """Persist user msg → stream reply token-by-token → persist final reply.

    SSE frames:
        data: {"delta": "..."}
        data: {"done": true, "title": "<optional>"}
        data: {"error": "msg"}
    """
    uid = _require_user(user_id)
    svc = _service_or_503(request)
    llm = _llm_or_503(request)

    user_text = body.content.strip()
    if not user_text:
        raise HTTPException(status_code=422, detail="mensagem vazia")

    # Persist the user's message AND verify ownership in one shot.
    user_msg_id = await svc.add_message(conversation_id, uid, "user", user_text)
    if user_msg_id is None:
        raise HTTPException(status_code=404, detail="conversa não encontrada")

    # Pull the full message history (now includes the just-inserted user
    # message) to feed the LLM.
    history = await svc.get_messages_for_llm(conversation_id, uid)
    if history is None:
        # Race: conversation deleted between the two calls.
        raise HTTPException(status_code=404, detail="conversa não encontrada")

    msgs: list[ChatMessage] = [ChatMessage(role="system", content=_SYSTEM_PROMPT)]
    for m in history:
        msgs.append(ChatMessage(role=m["role"], content=m["content"]))

    is_first_exchange = len(history) == 1  # user message we just added is the only one

    async def gen() -> AsyncIterator[bytes]:
        acc_parts: list[str] = []
        try:
            async for token in llm.chat(msgs, think=False):
                if token.text:
                    acc_parts.append(token.text)
                    yield f"data: {json.dumps({'delta': token.text})}\n\n".encode()
                if token.done:
                    break
            reply = "".join(acc_parts).strip() or "(sem resposta)"
            # Persist the assistant reply.
            try:
                await svc.add_message(conversation_id, uid, "assistant", reply)
            except Exception:
                logger.exception("failed to persist assistant reply")

            # First-exchange title generation — best-effort, errors swallowed.
            title: str | None = None
            if is_first_exchange:
                try:
                    title = await _generate_title(llm, user_text, reply)
                    if title:
                        await svc.update_title(conversation_id, uid, title)
                except Exception:
                    logger.exception("title generation failed")
                    title = None

            done_payload: dict[str, Any] = {"done": True}
            if title:
                done_payload["title"] = title
            yield f"data: {json.dumps(done_payload)}\n\n".encode()
        except Exception as exc:
            logger.exception("chat stream failed")
            yield f"data: {json.dumps({'error': str(exc)})}\n\n".encode()

    headers = {
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    }
    return StreamingResponse(gen(), media_type="text/event-stream", headers=headers)


# ----------------------------------------------------------------------
# Legacy stateless variant — kept for tests / scripting
# ----------------------------------------------------------------------

@router.post("/messages/sync", response_model=StatelessChatResponse)
async def send_message_sync(
    request: Request,
    body: StatelessChatRequest,
    user_id: str | None = Depends(get_current_user_id),
) -> StatelessChatResponse:
    _require_user(user_id)
    llm = _llm_or_503(request)
    msgs: list[ChatMessage] = [ChatMessage(role="system", content=_SYSTEM_PROMPT)]
    for m in body.messages:
        msgs.append(ChatMessage(role=m.role, content=m.content))
    parts: list[str] = []
    try:
        async for token in llm.chat(msgs, think=False):
            if token.text:
                parts.append(token.text)
            if token.done:
                break
    except Exception as exc:
        logger.exception("chat failed")
        raise HTTPException(status_code=502, detail=str(exc))
    return StatelessChatResponse(reply="".join(parts).strip() or "(sem resposta)")
