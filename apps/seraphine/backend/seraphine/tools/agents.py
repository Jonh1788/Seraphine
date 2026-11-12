"""LLM tools for the agent harness (registered only when the harness is enabled).

``agents_delegate`` REQUIRES chat confirmation: the assistant reads untrusted
content (WhatsApp, e-mail, web pages), so an injected instruction must not be
able to start a file-editing agent on its own. The approval gate shows the
owner the tool call arguments (``agent_id``, ``project_id``, ``goal``), as for
every other confirmed tool (there is no separate summary hook). The read-only
tools and ``agents_create_task`` stay unconfirmed. The harness keeps its own
sandbox + human approval flow for commands, and these tools never execute
client-side (``proxy_to_client`` stays False).
"""

from __future__ import annotations

import json
import logging
from typing import Any

from seraphine.agents.errors import HarnessError
from seraphine.agents.service import AgentHarnessService
from seraphine.tools.base import Tool, ToolResult

logger = logging.getLogger(__name__)


def _run_brief(run: dict[str, Any]) -> dict[str, Any]:
    keys = ("id", "agent_id", "project_id", "task_id", "status", "engine", "provider", "model", "goal",
            "error", "cost_usd", "created_at", "started_at", "finished_at")
    return {k: run.get(k) for k in keys}


class _AgentTool(Tool):
    requires_confirmation = False
    category = "other"
    proxy_to_client = False

    def __init__(self, svc: AgentHarnessService) -> None:
        self._svc = svc


class AgentsListTool(_AgentTool):
    name = "agents_list"
    description = (
        "Lista os agentes (bots de trabalho), os projetos em que eles atuam e as "
        "execuções ativas. Cada agente traz o runtime (codex/claude_code agem nos arquivos; "
        "chat só conversa), o provedor/LLM e o modelo, para você escolher a quem delegar. "
        "Use antes de delegar trabalho para saber os ids."
    )
    json_schema: dict[str, Any] = {"type": "object", "properties": {}}

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        try:
            agents = await self._svc.list_defs()
            projects = await self._svc.list_projects()
            runs = await self._svc.list_runs(active_only=True, limit=50)
        except Exception as exc:  # noqa: BLE001
            logger.exception("agents_list failed")
            return ToolResult(ok=False, error=str(exc))
        data = {
            "agents": [{"id": a["id"], "name": a["name"], "role": a["role"], "engine": a["engine"],
                        "runtime": a["engine"], "can_act": a["engine"] != "chat",
                        "provider": a.get("provider"), "model": a.get("model"),
                        "reasoning_effort": a.get("reasoning_effort"),
                        "fallback_engine": a.get("fallback_engine"),
                        "fallback_provider": a.get("fallback_provider"),
                        "fallback_model": a.get("fallback_model"),
                        "enabled": a["enabled"], "project_ids": a["project_ids"],
                        "perm_edit": a["perm_edit"], "perm_commands": a["perm_commands"]}
                       for a in agents],
            "projects": [{"id": p["id"], "name": p["name"], "path": p["path"]} for p in projects],
            "active_runs": [_run_brief(r) for r in runs],
        }
        return ToolResult(ok=True, output=json.dumps(data, ensure_ascii=False), metadata=data)


class AgentsDelegateTool(_AgentTool):
    name = "agents_delegate"
    requires_confirmation = True
    description = (
        "Delega um trabalho a um agente dentro de um projeto. O dono confirma cada "
        "delegação e vê o agente, o projeto e o objetivo antes de qualquer coisa rodar. "
        "Depois de confirmado, retorna o id da execução; acompanhe com agents_run_status. "
        "Coisas sensíveis (deploy, push, rede, instalar) o agente ainda pede aprovação ao dono."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "agent_id": {"type": "string", "description": "id do agente, ou 'auto' para escolher"},
            "project_id": {"type": "string"},
            "goal": {"type": "string", "description": "o que o agente deve fazer"},
            "task_id": {"type": "string", "description": "opcional: tarefa vinculada"},
        },
        "required": ["agent_id", "project_id", "goal"],
    }

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        project_id = str(args.get("project_id") or "")
        goal = str(args.get("goal") or "")
        agent_id = str(args.get("agent_id") or "auto")
        try:
            if agent_id == "auto":
                picked = await self._svc.pick_agent(project_id, goal)
                if picked is None:
                    return ToolResult(ok=False, error="nenhum agente ativo tem acesso a este projeto")
                agent_id = picked
            run = await self._svc.start_run(
                agent_id, project_id, goal,
                task_id=(str(args["task_id"]) if args.get("task_id") else None),
                requested_by="seraphine",
            )
        except HarnessError as exc:
            return ToolResult(ok=False, error=str(exc))
        except Exception as exc:  # noqa: BLE001
            logger.exception("agents_delegate failed")
            return ToolResult(ok=False, error=str(exc))
        ok = run["status"] != "failed"
        return ToolResult(
            ok=ok,
            output=f"Execução {run['id']} ({run['status']}) delegada ao agente {run['agent_id']}.",
            error=None if ok else str(run.get("error") or "falhou"),
            metadata={"run_id": run["id"], "agent_id": run["agent_id"], "status": run["status"]},
        )


class AgentsRunStatusTool(_AgentTool):
    name = "agents_run_status"
    description = (
        "Consulta uma execução de agente: status, últimos eventos, mensagem final e "
        "aprovação pendente (se houver)."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {"run_id": {"type": "string"}},
        "required": ["run_id"],
    }

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        run_id = str(args.get("run_id") or "")
        try:
            run = await self._svc.get_run(run_id)
            if run is None:
                return ToolResult(ok=False, error="execução não encontrada")
            events = await self._svc.list_events(run_id, limit=10, tail=True)
            pending = await self._svc.list_approvals(status="pending", run_id=run_id)
        except Exception as exc:  # noqa: BLE001
            logger.exception("agents_run_status failed")
            return ToolResult(ok=False, error=str(exc))
        data = {
            **_run_brief(run),
            "final_message": run.get("result_summary"),
            "last_events": [{"kind": e["kind"], "payload": e["payload"]} for e in events],
            "pending_approval": (
                {"id": pending[0]["id"], "title": pending[0]["title"],
                 "command": pending[0]["command"], "reason": pending[0]["reason"]}
                if pending else None),
        }
        return ToolResult(ok=True, output=json.dumps(data, ensure_ascii=False, default=str), metadata=data)


class AgentsCreateTaskTool(_AgentTool):
    name = "agents_create_task"
    description = "Cria uma tarefa no quadro de um projeto de agentes (opcionalmente atribuída a um agente)."
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "project_id": {"type": "string"},
            "title": {"type": "string"},
            "description": {"type": "string"},
            "assignee_agent_id": {"type": "string"},
            "priority": {"type": "string", "enum": ["low", "medium", "high"]},
            "due_at": {"type": "string", "description": "ISO 8601, opcional"},
            "acceptance": {"type": "array", "items": {"type": "string"},
                           "description": "critérios de aceitação"},
        },
        "required": ["project_id", "title"],
    }

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        try:
            task = await self._svc.create_task(
                project_id=str(args.get("project_id") or ""),
                title=str(args.get("title") or ""),
                description=str(args.get("description") or ""),
                assignee_agent_id=args.get("assignee_agent_id") or None,
                priority=str(args.get("priority") or "medium"),
                due_at=args.get("due_at") or None,
                acceptance=args.get("acceptance") if isinstance(args.get("acceptance"), list) else None,
                created_by="seraphine",
            )
        except HarnessError as exc:
            return ToolResult(ok=False, error=str(exc))
        except Exception as exc:  # noqa: BLE001
            logger.exception("agents_create_task failed")
            return ToolResult(ok=False, error=str(exc))
        return ToolResult(ok=True, output=f"Tarefa #{task['number']} criada: {task['title']}.",
                          metadata={"task": task})
