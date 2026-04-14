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

from datetime import datetime
from zoneinfo import ZoneInfo

from llm_adapters import AnthropicClient
from llm_adapters.types import ChatMessage
from mod_finance import FinancialEntry, FinanceService
from mod_finance.models import CATEGORIES
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
    "ofereça próximos passos práticos. "
    "Quando o usuário relatar um ganho ou gasto (ex: 'ganhei 500 de freela', "
    "'gastei 100 com ifood'), use a tool register_transaction para "
    "registrá-lo. Após registrar, confirme com mensagem curta mencionando "
    "o valor e a descrição. Categorize com bom senso. Se o usuário não "
    "mencionar a data, considere hoje. Não invente dados — se faltar "
    "informação essencial (ex: valor não claro), pergunte antes de registrar."
)


# ----------------------------------------------------------------------
# Tool definitions for the LLM
# ----------------------------------------------------------------------

_TZ = ZoneInfo("America/Sao_Paulo")


def _today_iso() -> str:
    return datetime.now(_TZ).strftime("%Y-%m-%d")


_TOOLS: list[dict[str, Any]] = [
    {
        "name": "register_transaction",
        "description": (
            "Registra uma transação financeira (receita ou despesa) para o usuário. "
            "Use sempre que o usuário relatar dinheiro ganho ou gasto."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "type": {
                    "type": "string",
                    "enum": ["income", "expense"],
                    "description": "income = dinheiro recebido, expense = dinheiro gasto",
                },
                "amount": {
                    "type": "number",
                    "description": "Valor em reais (BRL). Sempre positivo.",
                },
                "category": {
                    "type": "string",
                    "enum": CATEGORIES,
                    "description": (
                        "Categoria que melhor descreve. Ex: 'salario'/'freelance' "
                        "para receitas; 'alimentacao'/'transporte'/'moradia' "
                        "para despesas. Use 'outros' quando nada se encaixa."
                    ),
                },
                "description": {
                    "type": "string",
                    "description": "Rótulo curto da transação. Ex: 'Freelancer', 'iFood', 'Aluguel'.",
                },
                "date": {
                    "type": "string",
                    "description": "Data ISO YYYY-MM-DD. Hoje (São Paulo) é "
                    + _today_iso() + ". Omita pra usar hoje.",
                },
            },
            "required": ["type", "amount", "category", "description"],
        },
    },
]

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


def _finance_or_503(request: Request) -> FinanceService:
    svc: Optional[FinanceService] = getattr(
        request.app.state, "finance_service", None,
    )
    if svc is None:
        raise HTTPException(status_code=503, detail="finance service não configurado")
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


async def _exec_register_transaction(
    finance: FinanceService,
    user_id: str,
    args: dict[str, Any],
) -> dict[str, Any]:
    """Execute the register_transaction tool and return both the
    persisted entry (for the SSE event) and a tool_result payload (for
    the next LLM turn)."""
    ttype = args.get("type")
    amount = args.get("amount")
    category = args.get("category") or "outros"
    description = (args.get("description") or "").strip()
    date = args.get("date") or _today_iso()

    if ttype not in ("income", "expense"):
        return {
            "ok": False,
            "error": f"type inválido: {ttype!r} (use 'income' ou 'expense')",
        }
    try:
        amount_f = float(amount)
    except (TypeError, ValueError):
        return {"ok": False, "error": f"amount inválido: {amount!r}"}
    if amount_f <= 0:
        return {"ok": False, "error": "amount deve ser maior que zero"}
    if not description:
        return {"ok": False, "error": "description vazia"}

    entry = FinancialEntry(
        id=None,
        type=ttype,
        amount=amount_f,
        currency="BRL",
        category=category,
        description=description,
        date=date,
        source="chat",
        status="confirmed",
    )
    entry_id = await finance.add_entry(entry, user_id=user_id)
    persisted = {
        "id": entry_id,
        "type": ttype,
        "amount": amount_f,
        "currency": "BRL",
        "category": category,
        "description": description,
        "date": date,
        "status": "confirmed",
    }
    return {"ok": True, "entry": persisted}


@router.post("/conversations/{conversation_id}/messages")
async def stream_message(
    request: Request,
    conversation_id: str,
    body: SendMessageBody,
    user_id: str | None = Depends(get_current_user_id),
) -> StreamingResponse:
    """Persist user msg → run tool-using LLM loop → stream reply →
    persist final reply.

    SSE frames:
        data: {"delta": "..."}
        data: {"transaction": {id, type, amount, category, description, date}}
        data: {"done": true, "title": "<optional>"}
        data: {"error": "msg"}
    """
    uid = _require_user(user_id)
    svc = _service_or_503(request)
    llm = _llm_or_503(request)
    finance = _finance_or_503(request)

    user_text = body.content.strip()
    if not user_text:
        raise HTTPException(status_code=422, detail="mensagem vazia")

    user_msg_id = await svc.add_message(conversation_id, uid, "user", user_text)
    if user_msg_id is None:
        raise HTTPException(status_code=404, detail="conversa não encontrada")

    history = await svc.get_messages_for_llm(conversation_id, uid)
    if history is None:
        raise HTTPException(status_code=404, detail="conversa não encontrada")

    msgs: list[ChatMessage] = [ChatMessage(role="system", content=_SYSTEM_PROMPT)]
    for m in history:
        msgs.append(ChatMessage(role=m["role"], content=m["content"]))

    is_first_exchange = len(history) == 1

    async def gen() -> AsyncIterator[bytes]:
        acc_parts: list[str] = []
        try:
            # Agentic loop: keep running chat() while the model issues
            # tool_calls. Each turn streams text deltas to the client; on
            # tool_use we execute server-side, emit a transaction event,
            # append a tool message, and loop.
            for _round in range(6):  # safety cap
                pending_tool_calls: list[dict[str, Any]] | None = None
                async for token in llm.chat(msgs, tools=_TOOLS, think=False):
                    if token.text:
                        acc_parts.append(token.text)
                        yield f"data: {json.dumps({'delta': token.text})}\n\n".encode()
                    if token.tool_calls:
                        pending_tool_calls = token.tool_calls
                    if token.done:
                        break

                if not pending_tool_calls:
                    break  # plain text turn — we're done

                # Execute each tool call sequentially.
                for tc in pending_tool_calls:
                    name, args = _parse_tool_call(tc)
                    if name == "register_transaction":
                        result = await _exec_register_transaction(finance, uid, args)
                    else:
                        result = {"ok": False, "error": f"tool desconhecida: {name}"}

                    # Inform the UI when a transaction was actually persisted.
                    if result.get("ok") and result.get("entry"):
                        yield (
                            f"data: {json.dumps({'transaction': result['entry']})}\n\n"
                        ).encode()

                    # Feed the tool result back to the LLM so it can
                    # craft a confirmation message.
                    msgs.append(
                        ChatMessage(
                            role="tool",
                            content=json.dumps(
                                {"tool": name, "args": args, **result},
                                ensure_ascii=False,
                            ),
                        )
                    )

            reply = "".join(acc_parts).strip() or "(sem resposta)"
            try:
                await svc.add_message(conversation_id, uid, "assistant", reply)
            except Exception:
                logger.exception("failed to persist assistant reply")

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


def _parse_tool_call(tc: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    """Pull (name, args) out of an OpenAI-shaped tool_call dict."""
    fn = tc.get("function") or {}
    name = fn.get("name") or tc.get("name") or ""
    raw = fn.get("arguments") or tc.get("arguments")
    if isinstance(raw, str):
        try:
            args = json.loads(raw)
        except json.JSONDecodeError:
            args = {}
    elif isinstance(raw, dict):
        args = raw
    else:
        args = {}
    return name, args


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
