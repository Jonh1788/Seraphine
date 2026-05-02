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

from mod_vision import describe_image, extract_pdf_text

from datetime import datetime
from zoneinfo import ZoneInfo

from llm_adapters import AnthropicClient
from llm_adapters.types import ChatMessage
from mod_finance import FinancialEntry, FinanceService
from mod_finance.models import CATEGORIES
from mod_tasks.routes import get_current_user_id
from mod_tasks.service import TaskService

from aura.chat.service import ConversationService
from aura.goals.service import GoalsService
from aura.habits.service import HabitsService
from aura.knowledge.service import KnowledgeService
from aura.projects.service import ProjectsService
from aura.recurring.service import RecurringService

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

_WEEKDAYS_PT = [
    "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira",
    "sexta-feira", "sábado", "domingo",
]


def _build_system_prompt() -> str:
    """Render the chat system prompt with the *current* date so the LLM
    can resolve relative expressions ("amanhã", "terça", "próxima
    sexta") to the correct YYYY-MM-DD without guessing the week."""
    now = datetime.now(_TZ)
    today_iso = now.strftime("%Y-%m-%d")
    weekday_pt = _WEEKDAYS_PT[now.weekday()]
    weekday_idx = now.weekday()  # 0=segunda
    return (
        f"Você é Aura, uma assistente pessoal calorosa e direta. "
        f"Hoje é {weekday_pt}, {today_iso} (fuso America/Sao_Paulo). "
        f"weekday atual = {weekday_idx} (0=segunda, 6=domingo). "
        f"SEMPRE use ESTA data como referência ao converter expressões "
        f"como 'hoje', 'amanhã', 'depois de amanhã', 'segunda', 'terça', "
        f"'próxima sexta' etc. para um YYYY-MM-DD concreto. "
        f"Quando o usuário disser apenas o dia da semana (ex: 'terça') "
        f"sem 'próxima', escolha a próxima ocorrência futura desse dia "
        f"a partir de hoje. Se hoje for o próprio dia mencionado e o "
        f"horário pedido ainda estiver por vir, use HOJE. "
        "Responde em português brasileiro, com clareza e empatia. "
        "Quando o usuário falar de tarefas, finanças, agenda ou hábitos, "
        "ofereça próximos passos práticos. "
        "Quando o usuário relatar um ganho ou gasto (ex: 'ganhei 500 de freela', "
        "'gastei 100 com ifood'), use a tool register_transaction para "
        "registrá-lo. Após registrar, confirme com mensagem curta mencionando "
        "o valor e a descrição. Categorize com bom senso. Se o usuário não "
        "mencionar a data, considere hoje. Não invente dados — se faltar "
        "informação essencial (ex: valor não claro), pergunte antes de registrar. "
        "Quando o usuário pedir para adicionar/criar uma tarefa (ex: 'adiciona "
        "uma tarefa', 'lembra de ligar pro banco amanhã às 15h'), use a tool "
        "create_task. Se mencionar horário, preencha due_time em HH:MM 24h. "
        "Se mencionar dia relativo (amanhã, sexta), converta para YYYY-MM-DD. "
        "Quando o usuário disser que concluiu/fez algo (ex: 'já paguei a conta', "
        "'terminei o relatório'), use complete_task com o título (ou trecho) da "
        "tarefa. Após criar ou concluir, confirme com uma mensagem curta. "
        "Quando o usuário pedir para ver/listar tarefas (ex: 'quais minhas "
        "tarefas hoje?', 'mostra o que tenho pra fazer essa semana', 'tarefas "
        "atrasadas'), use a tool list_tasks. Por padrão, hoje. Se o usuário "
        "pedir um dia específico (amanhã, sexta), converta para YYYY-MM-DD. "
        "Não liste novamente o que já foi mostrado nesta mesma conversa — "
        "as tarefas aparecem como cards visuais para o usuário. "
        "Quando o usuário descrever uma rotina ou tarefa recorrente (ex: "
        "'tirar o lixo toda segunda às 10:00', 'todo dia às 8h tomar remédio', "
        "'todo mês dia 5 pagar aluguel'), use a tool create_recurring_task. "
        "Converta dias da semana para weekday (segunda=0, terça=1, quarta=2, "
        "quinta=3, sexta=4, sábado=5, domingo=6). frequency deve ser 'daily', "
        "'weekly' ou 'monthly'. time é HH:MM 24h. Se o usuário disser 'todo "
        "dia' use daily; 'toda segunda/terça/...' use weekly com weekday; "
        "'todo mês dia X' use monthly com day_of_month. Após criar, confirme "
        "com mensagem curta — o card da regra recorrente aparece visualmente. "
        "Se o usuário anexou um arquivo (nota fiscal, recibo, fatura), "
        "interprete o conteúdo extraído e registre o TOTAL como uma transação "
        "única via register_transaction, com description = nome do "
        "estabelecimento (ou do banco/emissor), categoria adequada, "
        "source='chat'. Não pergunte confirmação; registre direto. "
        "Quando o usuário pedir um lembrete (ex: 'me lembra de tomar remédio "
        "às 8', 'lembrete pra ligar pro médico amanhã 14h'), use create_reminder. "
        "Quando ele descrever uma iniciativa, projeto ou meta de longo prazo "
        "com escopo (ex: 'quero criar um projeto chamado X', 'iniciativa de Y'), "
        "use create_project. Quando descrever um hábito a manter (ex: 'quero "
        "começar a caminhar 5x por semana', 'meta de beber água diariamente'), "
        "use create_habit (target_per_week 1..7). Quando o usuário pedir pra "
        "anotar/salvar uma ideia, reflexão ou texto livre (ex: 'anota essa "
        "ideia: ...', 'salva isso no caderno X'), use create_note. Se o "
        "caderno_name não existir, será criado. Quando o usuário definir um "
        "objetivo mensurável com prazo (ex: 'meta: economizar R$ 5000 até "
        "dezembro', 'quero ler 12 livros este ano'), use create_goal — kind "
        "deve ser 'financial', 'habit', 'project' ou 'general'. Após qualquer "
        "criação, confirme com mensagem curta — o card aparece visualmente."
    )

_EXTRACT_PROMPT = (
    "Você está vendo um recibo, nota fiscal ou fatura. Extraia em texto curto:\n"
    "- Nome do estabelecimento ou emissor\n"
    "- Valor TOTAL pago (em reais)\n"
    "- Data (DD/MM/AAAA se visível)\n"
    "- Tipo (gasto / recebimento)\n"
    "- Categoria provável (alimentação, transporte, moradia, salario, freelance, ...)\n"
    "\n"
    "Responda em formato livre, em português, breve. Se algo não estiver visível, omita."
)

_ACCEPTED_MIMES = {
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/webp",
}
_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024  # 10 MB


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
                    "description": (
                        "Data ISO YYYY-MM-DD. Use a data informada no system "
                        "prompt como referência de hoje. Omita pra usar hoje."
                    ),
                },
            },
            "required": ["type", "amount", "category", "description"],
        },
    },
    {
        "name": "create_task",
        "description": (
            "Cria uma nova tarefa para o usuário. Use quando o usuário pedir "
            "'adiciona/cria uma tarefa'. Quando o usuário disser horário, "
            "preencha due_time (HH:MM)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "description": {"type": "string"},
                "due_date": {
                    "type": "string",
                    "description": "YYYY-MM-DD; padrão = hoje",
                },
                "due_time": {
                    "type": "string",
                    "description": "HH:MM 24h; opcional",
                },
            },
            "required": ["title"],
        },
    },
    {
        "name": "complete_task",
        "description": (
            "Marca uma tarefa como concluída. Encontra por título (busca por "
            "substring case-insensitive na lista atual de tasks pendentes do "
            "usuário)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"title": {"type": "string"}},
            "required": ["title"],
        },
    },
    {
        "name": "create_recurring_task",
        "description": (
            "Cria uma regra de tarefa recorrente (diária, semanal ou mensal). "
            "Use quando o usuário descrever algo que se repete no tempo, "
            "ex: 'tirar o lixo toda segunda às 10:00', 'todo dia tomar "
            "remédio às 8h', 'todo mês dia 5 pagar aluguel'. Se hoje "
            "corresponder à regra, uma tarefa já é materializada na hora."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "frequency": {
                    "type": "string",
                    "enum": ["daily", "weekly", "monthly"],
                },
                "weekday": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 6,
                    "description": "0=segunda, 6=domingo. Só para weekly.",
                },
                "day_of_month": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 31,
                    "description": "Dia do mês 1..31. Só para monthly.",
                },
                "time": {
                    "type": "string",
                    "description": "HH:MM 24h; opcional",
                },
                "description": {"type": "string"},
            },
            "required": ["title", "frequency"],
        },
    },
    {
        "name": "list_tasks",
        "description": (
            "Lista as tarefas do usuário, opcionalmente filtradas por data ou "
            "intervalo de datas e por status. Use quando o usuário pedir para "
            "ver/mostrar tarefas (ex: 'quais minhas tarefas hoje?', 'tarefas "
            "atrasadas', 'o que tenho pra fazer essa semana')."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "due_from": {
                    "type": "string",
                    "description": "Data inicial YYYY-MM-DD (inclusive). Omita pra buscar todas.",
                },
                "due_to": {
                    "type": "string",
                    "description": "Data final YYYY-MM-DD (inclusive). Omita pra buscar todas.",
                },
                "status": {
                    "type": "string",
                    "enum": ["pending", "approved", "completed", "rejected", "failed"],
                    "description": "Filtrar por status. Omita pra todos.",
                },
            },
        },
    },
    {
        "name": "create_reminder",
        "description": (
            "Cria um lembrete (push notification) com data e hora. "
            "Use quando o usuário pedir 'me lembra de X às H', 'lembrete pra "
            "Y amanhã'. Diferente de create_task: lembretes aparecem na tela "
            "Lembretes e disparam push no horário certo."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "due_date": {
                    "type": "string",
                    "description": "YYYY-MM-DD; padrão = hoje",
                },
                "due_time": {
                    "type": "string",
                    "description": "HH:MM 24h; padrão = 09:00 se omitido",
                },
                "tag": {
                    "type": "string",
                    "description": "Categoria curta opcional (ex.: Saúde, Pix)",
                },
            },
            "required": ["title"],
        },
    },
    {
        "name": "create_project",
        "description": (
            "Cria um projeto (iniciativa de longo prazo com escopo). Use "
            "quando o usuário descrever um projeto / iniciativa nomeada."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "description": {"type": "string"},
                "color": {
                    "type": "string",
                    "enum": ["blue", "violet", "emerald", "amber", "rose"],
                    "description": "Cor da stripe; padrão blue",
                },
                "target_date": {
                    "type": "string",
                    "description": "Prazo opcional YYYY-MM-DD",
                },
            },
            "required": ["name"],
        },
    },
    {
        "name": "create_habit",
        "description": (
            "Cria um hábito recorrente (toggle diário). Use quando o usuário "
            "descrever uma rotina pessoal a manter."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "color": {
                    "type": "string",
                    "enum": ["emerald", "blue", "violet", "amber", "rose", "teal"],
                },
                "target_per_week": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 7,
                    "description": "Meta de repetições por semana, 1..7",
                },
            },
            "required": ["name"],
        },
    },
    {
        "name": "create_note",
        "description": (
            "Salva uma nota markdown em um caderno. Use quando o usuário "
            "pedir 'anota isso', 'salva no caderno X'. Se o caderno não "
            "existir, cria automaticamente."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "notebook_name": {
                    "type": "string",
                    "description": "Nome do caderno; cria se não existir",
                },
                "title": {"type": "string"},
                "content_md": {
                    "type": "string",
                    "description": "Conteúdo em markdown",
                },
            },
            "required": ["notebook_name", "content_md"],
        },
    },
    {
        "name": "create_goal",
        "description": (
            "Cria uma meta de longo prazo, com kind (general/financial/"
            "habit/project), opcionalmente com target_value e deadline."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "description": {"type": "string"},
                "kind": {
                    "type": "string",
                    "enum": ["general", "financial", "habit", "project"],
                },
                "target_value": {
                    "type": "number",
                    "description": "Quantidade alvo (R$, livros, km, ...)",
                },
                "unit": {
                    "type": "string",
                    "description": "Unidade do target (R$, livros, km, ...)",
                },
                "deadline": {
                    "type": "string",
                    "description": "Prazo YYYY-MM-DD opcional",
                },
            },
            "required": ["title"],
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


def _tasks_or_503(request: Request) -> TaskService:
    svc: Optional[TaskService] = getattr(
        request.app.state, "task_service", None,
    )
    if svc is None:
        raise HTTPException(status_code=503, detail="task service não configurado")
    return svc


def _recurring_or_503(request: Request) -> RecurringService:
    svc: Optional[RecurringService] = getattr(
        request.app.state, "recurring_service", None,
    )
    if svc is None:
        raise HTTPException(status_code=503, detail="recurring service não configurado")
    return svc


def _projects_or_none(request: Request) -> Optional[ProjectsService]:
    return getattr(request.app.state, "projects_service", None)


def _habits_or_none(request: Request) -> Optional[HabitsService]:
    return getattr(request.app.state, "habits_service", None)


def _knowledge_or_none(request: Request) -> Optional[KnowledgeService]:
    return getattr(request.app.state, "knowledge_service", None)


def _goals_or_none(request: Request) -> Optional[GoalsService]:
    return getattr(request.app.state, "goals_service", None)


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


def _task_to_inline(task: Any) -> dict[str, Any]:
    """Serialize a SeraphineTask into the minimal shape sent to the UI
    (matches the frontend InlineTask interface)."""
    return {
        "id": task.id,
        "title": task.title,
        "description": task.description or "",
        "status": task.status,
        "due_date": task.due_date,
        "due_time": task.due_time,
    }


async def _exec_create_task(
    tasks: TaskService,
    user_id: str,
    args: dict[str, Any],
) -> dict[str, Any]:
    """Execute the create_task tool — persists a generic task owned by
    the user. Defaults due_date to today (São Paulo TZ). When Google is
    connected the task is mirrored to the primary calendar via the
    TaskService on-created hook (see aura.google.calendar_sync)."""
    title = (args.get("title") or "").strip()
    if not title:
        return {"ok": False, "error": "title vazio"}
    description = (args.get("description") or "").strip()
    due_date = (args.get("due_date") or "").strip() or _today_iso()
    due_time_raw = args.get("due_time")
    due_time = due_time_raw.strip() if isinstance(due_time_raw, str) else None
    if due_time == "":
        due_time = None

    task_id = await tasks.create_task(
        type="generic",
        title=title,
        description=description,
        source="chat",
        payload={},
        status="pending",
        due_date=due_date,
        due_time=due_time,
        user_id=user_id,
    )
    persisted = await tasks.get_task(task_id, user_id=user_id)
    if persisted is None:
        return {"ok": False, "error": "falha ao carregar tarefa criada"}
    return {"ok": True, "task": _task_to_inline(persisted)}


async def _exec_complete_task(
    tasks: TaskService,
    user_id: str,
    args: dict[str, Any],
) -> dict[str, Any]:
    """Execute the complete_task tool — looks up the first pending task
    whose title contains the requested substring (case-insensitive) and
    marks it completed."""
    query = (args.get("title") or "").strip()
    if not query:
        return {"ok": False, "error": "title vazio"}
    pending = await tasks.list_tasks(
        status="pending", limit=200, user_id=user_id,
    )
    needle = query.casefold()
    match = next(
        (t for t in pending if needle in (t.title or "").casefold()),
        None,
    )
    if match is None:
        return {
            "ok": False,
            "error": f"nenhuma tarefa pendente encontrada para '{query}'",
        }
    affected = await tasks.update_status(
        match.id, "completed", user_id=user_id,
    )
    if not affected:
        return {"ok": False, "error": "falha ao concluir tarefa"}
    updated = await tasks.get_task(match.id, user_id=user_id)
    if updated is None:
        return {"ok": False, "error": "tarefa não encontrada após atualizar"}
    return {"ok": True, "task": _task_to_inline(updated)}


async def _exec_create_recurring_task(
    recurring: RecurringService,
    tasks: TaskService,
    user_id: str,
    args: dict[str, Any],
) -> dict[str, Any]:
    """Create a recurring rule. If today matches, also immediately
    materialize a task for today so the user sees the card right away."""
    title = (args.get("title") or "").strip()
    if not title:
        return {"ok": False, "error": "title vazio"}
    frequency = (args.get("frequency") or "").strip()
    if frequency not in ("daily", "weekly", "monthly"):
        return {
            "ok": False,
            "error": "frequency inválida (use daily/weekly/monthly)",
        }

    weekday = args.get("weekday")
    day_of_month = args.get("day_of_month")
    try:
        weekday_i = int(weekday) if weekday is not None else None
        day_i = int(day_of_month) if day_of_month is not None else None
    except (TypeError, ValueError):
        return {"ok": False, "error": "weekday/day_of_month inválido"}

    time_raw = args.get("time")
    time = time_raw.strip() if isinstance(time_raw, str) else None
    if time == "":
        time = None
    description = (args.get("description") or "").strip() or None

    try:
        rule = await recurring.create(
            user_id=user_id,
            title=title,
            frequency=frequency,
            weekday=weekday_i,
            day_of_month=day_i,
            time=time,
            description=description,
        )
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}

    # If today matches, fire an occurrence immediately.
    from datetime import datetime as _dt
    materialized_task_payload: dict[str, Any] | None = None
    try:
        task_id = await recurring.materialize_for_rule_if_due(
            rule, _dt.now(_TZ),
        )
        if task_id is not None:
            persisted = await tasks.get_task(task_id, user_id=user_id)
            if persisted is not None:
                materialized_task_payload = _task_to_inline(persisted)
    except Exception:
        logger.exception("create_recurring_task: immediate materialize failed")

    return {
        "ok": True,
        "recurring": rule.to_dict(),
        "materialized_task": materialized_task_payload,
    }


async def _exec_list_tasks(
    tasks: TaskService,
    user_id: str,
    args: dict[str, Any],
) -> dict[str, Any]:
    """Read-only listing — returns the matched tasks so the chat UI can
    render them as cards via the {task} SSE channel (deduped by id)."""
    due_from = args.get("due_from") or None
    due_to = args.get("due_to") or None
    status = args.get("status") or None
    rows = await tasks.list_tasks(
        status=status,
        due_from=due_from,
        due_to=due_to,
        limit=200,
        user_id=user_id,
    )
    return {
        "ok": True,
        "count": len(rows),
        "tasks": [_task_to_inline(t) for t in rows],
    }


async def _exec_create_reminder(
    tasks: TaskService,
    user_id: str,
    args: dict[str, Any],
) -> dict[str, Any]:
    title = (args.get("title") or "").strip()
    if not title:
        return {"ok": False, "error": "título obrigatório"}
    due_date = (args.get("due_date") or _today_iso()).strip()
    due_time = (args.get("due_time") or "09:00").strip()
    tag = (args.get("tag") or "").strip()
    try:
        task_id = await tasks.create_task(
            type="reminder",
            title=title,
            source="chat",
            payload={},
            due_date=due_date,
            due_time=due_time,
            tags=[tag] if tag else None,
            user_id=user_id,
        )
        persisted = await tasks.get_task(task_id, user_id=user_id)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
    if persisted is None:
        return {"ok": False, "error": "falha ao carregar lembrete"}
    return {"ok": True, "reminder": _task_to_inline(persisted)}


async def _exec_create_project(
    projects: Optional[ProjectsService],
    user_id: str,
    args: dict[str, Any],
) -> dict[str, Any]:
    if projects is None:
        return {"ok": False, "error": "projetos não configurado"}
    name = (args.get("name") or "").strip()
    if not name:
        return {"ok": False, "error": "name obrigatório"}
    try:
        proj = await projects.create(
            user_id=user_id,
            name=name,
            description=args.get("description"),
            color=(args.get("color") or "blue"),
            target_date=args.get("target_date"),
        )
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
    return {
        "ok": True,
        "project": {
            "id": proj.id,
            "name": proj.name,
            "color": proj.color,
            "status": proj.status,
            "target_date": proj.target_date,
        },
    }


async def _exec_create_habit(
    habits: Optional[HabitsService],
    user_id: str,
    args: dict[str, Any],
) -> dict[str, Any]:
    if habits is None:
        return {"ok": False, "error": "habits não configurado"}
    name = (args.get("name") or "").strip()
    if not name:
        return {"ok": False, "error": "name obrigatório"}
    try:
        h = await habits.create(
            user_id=user_id,
            name=name,
            color=(args.get("color") or "emerald"),
            target_per_week=int(args.get("target_per_week") or 7),
        )
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
    return {
        "ok": True,
        "habit": {
            "id": h.id,
            "name": h.name,
            "color": h.color,
            "target_per_week": h.target_per_week,
        },
    }


async def _exec_create_note(
    knowledge: Optional[KnowledgeService],
    user_id: str,
    args: dict[str, Any],
) -> dict[str, Any]:
    if knowledge is None:
        return {"ok": False, "error": "knowledge não configurado"}
    notebook_name = (args.get("notebook_name") or "").strip()
    content_md = (args.get("content_md") or "").strip()
    if not notebook_name or not content_md:
        return {"ok": False, "error": "notebook_name e content_md obrigatórios"}
    title = (args.get("title") or "").strip() or None
    try:
        # Find or create notebook by name (case-insensitive match)
        existing = await knowledge.list_notebooks(user_id)
        nb = next(
            (n for n in existing if n.name.lower() == notebook_name.lower()),
            None,
        )
        if nb is None:
            nb = await knowledge.create_notebook(user_id=user_id, name=notebook_name)
        note = await knowledge.create_note(
            notebook_id=nb.id,
            user_id=user_id,
            title=title,
            content_md=content_md,
        )
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
    if note is None:
        return {"ok": False, "error": "falha ao criar nota"}
    return {
        "ok": True,
        "note": {
            "id": note.id,
            "notebook_id": note.notebook_id,
            "notebook_name": notebook_name,
            "title": note.title,
            "content_md": note.content_md,
        },
    }


async def _exec_create_goal(
    goals: Optional[GoalsService],
    user_id: str,
    args: dict[str, Any],
) -> dict[str, Any]:
    if goals is None:
        return {"ok": False, "error": "goals não configurado"}
    title = (args.get("title") or "").strip()
    if not title:
        return {"ok": False, "error": "title obrigatório"}
    try:
        g = await goals.create(
            user_id=user_id,
            title=title,
            description=args.get("description"),
            kind=(args.get("kind") or "general"),
            target_value=args.get("target_value"),
            unit=args.get("unit"),
            deadline=args.get("deadline"),
        )
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
    return {
        "ok": True,
        "goal": {
            "id": g.id,
            "title": g.title,
            "kind": g.kind,
            "target_value": g.target_value,
            "unit": g.unit,
            "deadline": g.deadline,
        },
    }


async def _run_agentic_collect(
    *,
    llm: AnthropicClient,
    finance: FinanceService,
    tasks_svc: TaskService,
    recurring_svc: RecurringService,
    projects_svc: Optional[ProjectsService],
    habits_svc: Optional[HabitsService],
    knowledge_svc: Optional[KnowledgeService],
    goals_svc: Optional[GoalsService],
    svc: ConversationService,
    uid: str,
    conversation_id: str,
    user_text: str,
    msgs: list[ChatMessage],
    is_first_exchange: bool,
) -> dict[str, Any]:
    """Non-streaming sibling of ``_run_agentic_stream``.

    Runs the same LLM → tool-call → LLM agentic loop (up to 6 rounds),
    accumulates the final assistant reply and structured side effects,
    persists the assistant message, and optionally generates a title on
    the first exchange. Returns a plain dict so non-SSE callers (e.g.
    WhatsApp inbound) can consume it without parsing event-stream bytes.

    The body intentionally duplicates the loop in ``_run_agentic_stream``
    rather than refactoring it; the SSE generator must keep behaving
    byte-for-byte for the live web chat.

    Raises whatever the underlying LLM/service calls raise; callers must
    wrap this in their own error handler (the SSE sibling catches and emits
    an ``error`` frame instead of bubbling).
    """
    acc_parts: list[str] = []
    turn_transactions: list[dict[str, Any]] = []
    turn_tasks: list[dict[str, Any]] = []
    turn_recurring: list[dict[str, Any]] = []
    turn_chips: list[dict[str, Any]] = []

    for _round in range(6):  # safety cap
        pending_tool_calls: list[dict[str, Any]] | None = None
        async for token in llm.chat(msgs, tools=_TOOLS, think=False):
            if token.text:
                acc_parts.append(token.text)
            if token.tool_calls:
                pending_tool_calls = token.tool_calls
            if token.done:
                break

        if not pending_tool_calls:
            break  # plain text turn — we're done

        for tc in pending_tool_calls:
            name, args = _parse_tool_call(tc)
            if name == "register_transaction":
                result = await _exec_register_transaction(finance, uid, args)
            elif name == "create_task":
                result = await _exec_create_task(tasks_svc, uid, args)
            elif name == "complete_task":
                result = await _exec_complete_task(tasks_svc, uid, args)
            elif name == "list_tasks":
                result = await _exec_list_tasks(tasks_svc, uid, args)
            elif name == "create_recurring_task":
                result = await _exec_create_recurring_task(
                    recurring_svc, tasks_svc, uid, args,
                )
            elif name == "create_reminder":
                result = await _exec_create_reminder(tasks_svc, uid, args)
            elif name == "create_project":
                result = await _exec_create_project(projects_svc, uid, args)
            elif name == "create_habit":
                result = await _exec_create_habit(habits_svc, uid, args)
            elif name == "create_note":
                result = await _exec_create_note(knowledge_svc, uid, args)
            elif name == "create_goal":
                result = await _exec_create_goal(goals_svc, uid, args)
            else:
                result = {"ok": False, "error": f"tool desconhecida: {name}"}

            if result.get("ok") and result.get("entry"):
                turn_transactions.append(result["entry"])
            if result.get("ok") and result.get("task"):
                turn_tasks.append(result["task"])
            if result.get("ok") and isinstance(result.get("tasks"), list):
                turn_tasks.extend(result["tasks"])
            if result.get("ok") and result.get("recurring"):
                turn_recurring.append(result["recurring"])
                mat = result.get("materialized_task")
                if mat:
                    turn_tasks.append(mat)
            for chip_kind in ("reminder", "project", "habit", "note", "goal"):
                if result.get("ok") and result.get(chip_kind):
                    turn_chips.append({"kind": chip_kind, "item": result[chip_kind]})

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
    # Why: chips (reminder/project/habit/note/goal) are NOT persisted to
    # message metadata — matches _run_agentic_stream behavior. Frontend
    # renders them transiently from the live event stream / collect return,
    # never from message reload.
    metadata: dict[str, Any] | None = None
    if turn_transactions or turn_tasks or turn_recurring:
        metadata = {}
        if turn_transactions:
            metadata["transactions"] = turn_transactions
        if turn_tasks:
            metadata["tasks"] = turn_tasks
        if turn_recurring:
            metadata["recurring"] = turn_recurring
    try:
        await svc.add_message(
            conversation_id, uid, "assistant", reply, metadata=metadata,
        )
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

    return {
        "reply": reply,
        "transactions": turn_transactions,
        "tasks": turn_tasks,
        "recurring": turn_recurring,
        "chips": turn_chips,
        "title": title,
    }


def _run_agentic_stream(
    llm: AnthropicClient,
    finance: FinanceService,
    tasks_svc: TaskService,
    recurring_svc: RecurringService,
    projects_svc: Optional[ProjectsService],
    habits_svc: Optional[HabitsService],
    knowledge_svc: Optional[KnowledgeService],
    goals_svc: Optional[GoalsService],
    svc: ConversationService,
    uid: str,
    conversation_id: str,
    user_text: str,
    msgs: list[ChatMessage],
    is_first_exchange: bool,
) -> AsyncIterator[bytes]:
    """Shared agentic-loop body for both text and attachment endpoints.

    Runs the LLM → tool-call → LLM loop, emitting SSE events, and then
    persists the assistant reply + kicks off title generation on first
    exchange. Returns an async byte iterator suitable for
    ``StreamingResponse``.
    """

    async def gen() -> AsyncIterator[bytes]:
        acc_parts: list[str] = []
        # Side effects persisted across all tool-call rounds in this turn —
        # stored on the assistant message metadata so reloads of the
        # conversation re-render the visual cards.
        turn_transactions: list[dict[str, Any]] = []
        turn_tasks: list[dict[str, Any]] = []
        turn_recurring: list[dict[str, Any]] = []
        try:
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
                    elif name == "create_task":
                        result = await _exec_create_task(tasks_svc, uid, args)
                    elif name == "complete_task":
                        result = await _exec_complete_task(tasks_svc, uid, args)
                    elif name == "list_tasks":
                        result = await _exec_list_tasks(tasks_svc, uid, args)
                    elif name == "create_recurring_task":
                        result = await _exec_create_recurring_task(
                            recurring_svc, tasks_svc, uid, args,
                        )
                    elif name == "create_reminder":
                        result = await _exec_create_reminder(tasks_svc, uid, args)
                    elif name == "create_project":
                        result = await _exec_create_project(projects_svc, uid, args)
                    elif name == "create_habit":
                        result = await _exec_create_habit(habits_svc, uid, args)
                    elif name == "create_note":
                        result = await _exec_create_note(knowledge_svc, uid, args)
                    elif name == "create_goal":
                        result = await _exec_create_goal(goals_svc, uid, args)
                    else:
                        result = {"ok": False, "error": f"tool desconhecida: {name}"}

                    if result.get("ok") and result.get("entry"):
                        entry = result["entry"]
                        turn_transactions.append(entry)
                        yield (
                            f"data: {json.dumps({'transaction': entry})}\n\n"
                        ).encode()
                    if result.get("ok") and result.get("task"):
                        task_payload = result["task"]
                        turn_tasks.append(task_payload)
                        yield (
                            f"data: {json.dumps({'task': task_payload})}\n\n"
                        ).encode()
                    # list_tasks emits each row through the same {task}
                    # channel; the frontend dedupes by id so a card already
                    # created earlier in the turn just refreshes in place.
                    if result.get("ok") and isinstance(result.get("tasks"), list):
                        for task_payload in result["tasks"]:
                            turn_tasks.append(task_payload)
                            yield (
                                f"data: {json.dumps({'task': task_payload})}\n\n"
                            ).encode()
                    if result.get("ok") and result.get("recurring"):
                        rec_payload = result["recurring"]
                        turn_recurring.append(rec_payload)
                        yield (
                            f"data: {json.dumps({'recurring': rec_payload})}\n\n"
                        ).encode()
                        mat = result.get("materialized_task")
                        if mat:
                            turn_tasks.append(mat)
                            yield (
                                f"data: {json.dumps({'task': mat})}\n\n"
                            ).encode()
                    # New tool families emit a generic "chip" event so the
                    # frontend can render a small confirmation card without
                    # needing a dedicated channel per kind.
                    for chip_kind in ("reminder", "project", "habit", "note", "goal"):
                        if result.get("ok") and result.get(chip_kind):
                            payload = {"kind": chip_kind, "item": result[chip_kind]}
                            yield (
                                f"data: {json.dumps({'chip': payload})}\n\n"
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
            metadata: dict[str, Any] | None = None
            if turn_transactions or turn_tasks or turn_recurring:
                metadata = {}
                if turn_transactions:
                    metadata["transactions"] = turn_transactions
                if turn_tasks:
                    metadata["tasks"] = turn_tasks
                if turn_recurring:
                    metadata["recurring"] = turn_recurring
            try:
                await svc.add_message(
                    conversation_id, uid, "assistant", reply, metadata=metadata,
                )
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

    return gen()


def _sse_response(body: AsyncIterator[bytes]) -> StreamingResponse:
    headers = {
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    }
    return StreamingResponse(body, media_type="text/event-stream", headers=headers)


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
        data: {"task": {id, title, status, due_date, due_time, description}}
        data: {"done": true, "title": "<optional>"}
        data: {"error": "msg"}
    """
    uid = _require_user(user_id)
    svc = _service_or_503(request)
    llm = _llm_or_503(request)
    finance = _finance_or_503(request)
    tasks_svc = _tasks_or_503(request)
    recurring_svc = _recurring_or_503(request)
    projects_svc = _projects_or_none(request)
    habits_svc = _habits_or_none(request)
    knowledge_svc = _knowledge_or_none(request)
    goals_svc = _goals_or_none(request)

    user_text = body.content.strip()
    if not user_text:
        raise HTTPException(status_code=422, detail="mensagem vazia")

    user_msg_id = await svc.add_message(conversation_id, uid, "user", user_text)
    if user_msg_id is None:
        raise HTTPException(status_code=404, detail="conversa não encontrada")

    history = await svc.get_messages_for_llm(conversation_id, uid)
    if history is None:
        raise HTTPException(status_code=404, detail="conversa não encontrada")

    msgs: list[ChatMessage] = [ChatMessage(role="system", content=_build_system_prompt())]
    for m in history:
        msgs.append(ChatMessage(role=m["role"], content=m["content"]))

    is_first_exchange = len(history) == 1

    return _sse_response(
        _run_agentic_stream(
            llm, finance, tasks_svc, recurring_svc,
            projects_svc, habits_svc, knowledge_svc, goals_svc,
            svc, uid,
            conversation_id, user_text, msgs, is_first_exchange,
        )
    )


# ----------------------------------------------------------------------
# Streaming reply with a file attachment (PDF or image)
# ----------------------------------------------------------------------

def _kind_for_mime(mime: str) -> str:
    return "pdf" if mime == "application/pdf" else "image"


async def _error_stream(msg: str) -> AsyncIterator[bytes]:
    yield f"data: {json.dumps({'error': msg})}\n\n".encode()


def _parse_multipart(
    body: bytes, boundary: bytes,
) -> dict[str, dict[str, Any]]:
    """Tiny RFC-2046 multipart/form-data parser — good enough for our
    single-file + a few scalar fields shape. Returns ``{field_name:
    {"filename": str|None, "content_type": str|None, "data": bytes}}``.

    Kept in-tree to avoid pulling ``python-multipart`` as a dep just
    for one endpoint.
    """
    result: dict[str, dict[str, Any]] = {}
    delim = b"--" + boundary
    # Strip preamble.
    start = body.find(delim)
    if start < 0:
        return result
    pos = start + len(delim)
    while True:
        # Expect either CRLF (more parts) or "--" (end).
        if body[pos:pos + 2] == b"--":
            break
        if body[pos:pos + 2] == b"\r\n":
            pos += 2
        header_end = body.find(b"\r\n\r\n", pos)
        if header_end < 0:
            break
        raw_headers = body[pos:header_end].decode("utf-8", errors="replace")
        pos = header_end + 4
        next_boundary = body.find(b"\r\n" + delim, pos)
        if next_boundary < 0:
            break
        chunk = body[pos:next_boundary]
        pos = next_boundary + 2 + len(delim)

        # Parse Content-Disposition / Content-Type headers.
        headers: dict[str, str] = {}
        for line in raw_headers.split("\r\n"):
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip().lower()] = v.strip()
        disp = headers.get("content-disposition", "")
        if "form-data" not in disp:
            continue
        params: dict[str, str] = {}
        for part in disp.split(";")[1:]:
            part = part.strip()
            if "=" in part:
                k, v = part.split("=", 1)
                params[k.strip()] = v.strip().strip('"')
        name = params.get("name")
        if not name:
            continue
        result[name] = {
            "filename": params.get("filename"),
            "content_type": headers.get("content-type"),
            "data": chunk,
        }
    return result


def _extract_boundary(content_type: str | None) -> bytes | None:
    if not content_type:
        return None
    for part in content_type.split(";"):
        part = part.strip()
        if part.startswith("boundary="):
            val = part.split("=", 1)[1].strip().strip('"')
            return val.encode("latin-1")
    return None


@router.post("/conversations/{conversation_id}/messages/with-attachment")
async def stream_message_with_attachment(
    request: Request,
    conversation_id: str,
    user_id: str | None = Depends(get_current_user_id),
) -> StreamingResponse:
    """Multipart sibling of ``stream_message``. Accepts a single PDF or
    image, extracts a text representation via ``mod_vision``, injects it
    into the conversation as an ephemeral system-side note, and runs the
    same agentic tool loop — the LLM typically calls
    ``register_transaction`` with the extracted total.

    Same SSE shape as ``stream_message``.
    """
    uid = _require_user(user_id)
    svc = _service_or_503(request)
    llm = _llm_or_503(request)
    finance = _finance_or_503(request)
    tasks_svc = _tasks_or_503(request)
    recurring_svc = _recurring_or_503(request)
    projects_svc = _projects_or_none(request)
    habits_svc = _habits_or_none(request)
    knowledge_svc = _knowledge_or_none(request)
    goals_svc = _goals_or_none(request)

    ctype = request.headers.get("content-type", "")
    if "multipart/form-data" not in ctype.lower():
        raise HTTPException(
            status_code=415, detail="esperado multipart/form-data",
        )
    boundary = _extract_boundary(ctype)
    if not boundary:
        raise HTTPException(
            status_code=400, detail="boundary multipart ausente",
        )

    # Fast-path rejection via Content-Length so we don't buffer gigantic
    # bodies into memory just to then reject them. Multipart framing adds
    # a small per-part overhead so we allow a 1 MB slack.
    limit = _MAX_ATTACHMENT_BYTES + 1024 * 1024
    cl_hdr = request.headers.get("content-length")
    if cl_hdr is not None:
        try:
            if int(cl_hdr) > limit:
                raise HTTPException(
                    status_code=413,
                    detail="arquivo muito grande — máximo 10 MB",
                )
        except ValueError:
            pass

    raw = await request.body()
    if len(raw) > limit:
        raise HTTPException(
            status_code=413,
            detail="arquivo muito grande — máximo 10 MB",
        )

    parts = _parse_multipart(raw, boundary)
    file_part = parts.get("file")
    if file_part is None or not file_part.get("filename"):
        raise HTTPException(
            status_code=422, detail="campo 'file' ausente",
        )

    mime = (file_part.get("content_type") or "").lower().split(";")[0].strip()
    if mime not in _ACCEPTED_MIMES:
        raise HTTPException(
            status_code=415,
            detail=(
                "tipo de arquivo não suportado — use PDF, JPEG, PNG ou WebP"
            ),
        )

    data: bytes = file_part["data"]
    size = len(data)
    if size == 0:
        raise HTTPException(status_code=422, detail="arquivo vazio")
    if size > _MAX_ATTACHMENT_BYTES:
        raise HTTPException(
            status_code=413,
            detail="arquivo muito grande — máximo 10 MB",
        )

    content_part = parts.get("content")
    user_text = ""
    if content_part is not None:
        try:
            user_text = content_part["data"].decode("utf-8").strip()
        except UnicodeDecodeError:
            user_text = ""
    filename = file_part.get("filename") or "anexo"
    kind = _kind_for_mime(mime)

    # Persist the user message (typed text only; file bytes are NOT
    # stored — just the metadata chip).
    attachment_meta = {
        "attachment": {
            "name": filename,
            "kind": kind,
            "mime": mime,
            "size": size,
        }
    }
    # If the user typed nothing, persist a placeholder so the bubble is
    # not empty in history. The chip still renders via metadata.
    persisted_text = user_text or f"[anexo: {filename}]"
    user_msg_id = await svc.add_message(
        conversation_id, uid, "user", persisted_text, metadata=attachment_meta,
    )
    if user_msg_id is None:
        raise HTTPException(status_code=404, detail="conversa não encontrada")

    # Extract the text representation.
    try:
        if kind == "pdf":
            extracted = extract_pdf_text(data)
        else:
            extracted = await describe_image(
                image_bytes=data,
                mime_type=mime,
                prompt=_EXTRACT_PROMPT,
                llm=llm,
            )
    except Exception as exc:
        logger.exception("attachment extraction failed")
        return _sse_response(
            _error_stream(f"falha ao processar anexo: {exc}"),
        )

    extracted = (extracted or "").strip()
    if not extracted:
        return _sse_response(
            _error_stream(
                "não consegui extrair nenhum conteúdo do anexo — "
                "tente uma foto mais nítida ou um PDF com texto selecionável"
            ),
        )

    history = await svc.get_messages_for_llm(conversation_id, uid)
    if history is None:
        raise HTTPException(status_code=404, detail="conversa não encontrada")

    # Build the LLM input: the stored user bubble preserves what the
    # user typed, but the LLM needs the extracted content, so we prepend
    # it ephemerally to the LAST user message.
    extraction_block = (
        f'[conteúdo extraído do anexo "{filename}"]\n'
        f"{extracted}\n"
        "[fim do conteúdo extraído]"
    )
    msgs: list[ChatMessage] = [ChatMessage(role="system", content=_build_system_prompt())]
    for idx, m in enumerate(history):
        is_last = idx == len(history) - 1
        if is_last and m["role"] == "user":
            augmented = (
                f"{extraction_block}\n\n{m['content']}"
                if m["content"] and not m["content"].startswith("[anexo:")
                else extraction_block
            )
            msgs.append(ChatMessage(role="user", content=augmented))
        else:
            msgs.append(ChatMessage(role=m["role"], content=m["content"]))

    is_first_exchange = len(history) == 1
    # The text passed to the title generator should be what the user
    # "said", which for attachment-only turns is the filename.
    title_seed = user_text or f"anexo: {filename}"

    return _sse_response(
        _run_agentic_stream(
            llm, finance, tasks_svc, recurring_svc,
            projects_svc, habits_svc, knowledge_svc, goals_svc,
            svc, uid,
            conversation_id, title_seed, msgs, is_first_exchange,
        )
    )


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
    msgs: list[ChatMessage] = [ChatMessage(role="system", content=_build_system_prompt())]
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
