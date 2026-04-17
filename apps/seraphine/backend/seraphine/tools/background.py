"""073 — Background-task tools."""

from __future__ import annotations

from typing import Any

from seraphine.tools.base import Tool, ToolResult


class StartBackgroundTaskTool(Tool):
    name = "start_background_task"
    description = (
        "Kick off a long-running autonomous research task. Use when the "
        "user says 'pesquisa X pra mim', 'descobre Y e me avisa', "
        "'investiga Z'. The sub-agent runs independently (max 30min "
        "default) and notifies when finished."
    )
    json_schema = {
        "type": "object",
        "properties": {
            "goal": {"type": "string"},
            "max_duration_min": {"type": "integer", "minimum": 5, "maximum": 120},
        },
        "required": ["goal"],
    }
    requires_confirmation = False
    category = "other"

    def __init__(self, store: Any, llm: Any, tool_registry: Any) -> None:
        self.store = store
        self.llm = llm
        self.tool_registry = tool_registry
        self._manager: Any = None

    def _get_manager(self) -> Any:
        if self._manager is None:
            from seraphine.background_tasks.runner import BackgroundTaskManager
            self._manager = BackgroundTaskManager(self.store, self.llm, self.tool_registry)
        return self._manager

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        goal = str(args.get("goal", "")).strip()
        if not goal:
            return ToolResult(ok=False, error="missing goal")
        try:
            max_min = int(args.get("max_duration_min") or 30)
        except (TypeError, ValueError):
            max_min = 30
        try:
            task_id = await self._get_manager().start(goal, max_min)
        except Exception as e:
            return ToolResult(ok=False, error=str(e))
        return ToolResult(
            ok=True,
            output=(
                f"Tarefa lançada em background (id={task_id[:8]}…). "
                f"Te aviso quando terminar."
            ),
            metadata={"task_id": task_id},
        )


class ListBackgroundTasksTool(Tool):
    name = "list_background_tasks"
    description = "List background tasks (running/done/cancelled/failed)."
    json_schema = {
        "type": "object",
        "properties": {"status": {"type": "string"}},
    }
    requires_confirmation = False
    category = "other"

    def __init__(self, store: Any) -> None:
        self.store = store

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        from seraphine.background_tasks.runner import BackgroundTaskManager
        mgr = BackgroundTaskManager(self.store, None, None)
        tasks = await mgr.list_tasks(args.get("status"))
        if not tasks:
            return ToolResult(ok=True, output="Nenhuma tarefa background.")
        lines = [f"{len(tasks)} tarefa(s):"]
        for t in tasks[:10]:
            lines.append(f"- [{t['status']}] {t['goal'][:80]}")
        return ToolResult(ok=True, output="\n".join(lines),
                          metadata={"tasks": tasks})


class CancelBackgroundTaskTool(Tool):
    name = "cancel_background_task"
    description = "Cancel a running background task by id."
    json_schema = {
        "type": "object",
        "properties": {"task_id": {"type": "string"}},
        "required": ["task_id"],
    }
    requires_confirmation = False
    category = "other"

    def __init__(self, store: Any) -> None:
        self.store = store

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        return ToolResult(
            ok=False,
            error=(
                "cancel via tool needs the runtime manager — use "
                "POST /background_tasks/{id}/cancel for now"
            ),
        )
