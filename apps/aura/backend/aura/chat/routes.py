"""POST /chat/messages — stateless, JWT-protected."""

from __future__ import annotations

import logging
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from llm_adapters import AnthropicClient
from llm_adapters.types import ChatMessage
from mod_tasks.routes import get_current_user_id

router = APIRouter(prefix="/chat", tags=["chat"])
logger = logging.getLogger(__name__)


class ChatMessageBody(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessageBody] = Field(min_length=1)


class ChatResponse(BaseModel):
    reply: str


_SYSTEM_PROMPT = (
    "Você é Aura, uma assistente pessoal calorosa e direta. "
    "Responde em português brasileiro, com clareza e empatia. "
    "Quando o usuário falar de tarefas, finanças, agenda ou hábitos, "
    "ofereça próximos passos práticos. Não invente dados que você não "
    "tem acesso — diga que pode ser configurado em integrações."
)


def _llm_or_503(request: Request) -> AnthropicClient:
    llm: Optional[AnthropicClient] = getattr(request.app.state, "llm", None)
    if llm is None:
        raise HTTPException(
            status_code=503,
            detail=(
                "chat indisponível: AURA_ANTHROPIC_API_KEY não configurado"
            ),
        )
    return llm


@router.post("/messages", response_model=ChatResponse)
async def send_message(
    request: Request,
    body: ChatRequest,
    user_id: str = Depends(get_current_user_id),
) -> ChatResponse:
    llm = _llm_or_503(request)
    if user_id is None:
        raise HTTPException(status_code=401, detail="autenticação requerida")

    msgs: list[ChatMessage] = [ChatMessage(role="system", content=_SYSTEM_PROMPT)]
    for m in body.messages:
        msgs.append(ChatMessage(role=m.role, content=m.content))

    # Drain the streaming Token sequence into a single reply string.
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

    return ChatResponse(reply="".join(parts).strip() or "(sem resposta)")
