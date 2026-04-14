"""POST /chat/messages — stateless, JWT-protected.

Two flavors:
- POST /chat/messages — streams tokens as SSE so the UI types out the
  reply live. The default for the web UI.
- POST /chat/messages/sync — drains the stream server-side and returns
  one ChatResponse. Useful for scripting / tests.
"""

from __future__ import annotations

import json
import logging
from typing import Any, AsyncIterator, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
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


def _build_messages(body: ChatRequest) -> list[ChatMessage]:
    msgs: list[ChatMessage] = [ChatMessage(role="system", content=_SYSTEM_PROMPT)]
    for m in body.messages:
        msgs.append(ChatMessage(role=m.role, content=m.content))
    return msgs


@router.post("/messages")
async def send_message_stream(
    request: Request,
    body: ChatRequest,
    user_id: str = Depends(get_current_user_id),
) -> StreamingResponse:
    """Stream the assistant reply as SSE.

    Frame format (one event per line, blank line terminator):
        data: {"delta": "..."}
        ...
        data: {"done": true}
        ...
        data: {"error": "msg"}   # on failure mid-stream

    Frontend reads via ``response.body.getReader()`` and appends each
    delta to the current assistant message.
    """
    llm = _llm_or_503(request)
    if user_id is None:
        raise HTTPException(status_code=401, detail="autenticação requerida")

    msgs = _build_messages(body)

    async def gen() -> AsyncIterator[bytes]:
        try:
            async for token in llm.chat(msgs, think=False):
                if token.text:
                    yield f"data: {json.dumps({'delta': token.text})}\n\n".encode()
                if token.done:
                    break
            yield b"data: {\"done\": true}\n\n"
        except Exception as exc:
            logger.exception("chat stream failed")
            payload = json.dumps({"error": str(exc)})
            yield f"data: {payload}\n\n".encode()

    headers = {
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",  # disable nginx buffering if behind proxy
    }
    return StreamingResponse(gen(), media_type="text/event-stream", headers=headers)


@router.post("/messages/sync", response_model=ChatResponse)
async def send_message_sync(
    request: Request,
    body: ChatRequest,
    user_id: str = Depends(get_current_user_id),
) -> ChatResponse:
    """Non-streaming variant — drains the stream server-side."""
    llm = _llm_or_503(request)
    if user_id is None:
        raise HTTPException(status_code=401, detail="autenticação requerida")

    msgs = _build_messages(body)
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
