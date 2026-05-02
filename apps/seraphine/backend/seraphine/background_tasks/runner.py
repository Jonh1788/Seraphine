"""073 — Long-running autonomous task runner.

Each task runs as an asyncio.Task doing a small plan-act loop with a
safe read-only subset of tools. Progress + final result persist to
background_tasks so the frontend can poll. When done, emits a
`background_task_finished` WS frame.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from llm_adapters.types import ChatMessage

logger = logging.getLogger("seraphine.background")

_MAX_ITERATIONS = 15
_TOKEN_BUDGET = 20_000

# Read-only, network-safe tools the sub-agent is allowed to call.
_SAFE_TOOL_NAMES = {
    "web_search", "web_fetch", "search_news", "document_read",
    "weather_forecast", "route_planner",
}

_PLANNER_PROMPT = """Você é um sub-agente da Seraphine executando uma
tarefa longa em background para o usuário.

OBJETIVO: {goal}

Você tem acesso a ferramentas de leitura (web_search, web_fetch,
document_read, search_news, weather_forecast). NÃO tem shell nem
filesystem nem comunicação direta com o usuário.

Itere passo a passo. A cada passo:
- Se ainda falta pesquisar algo, chame a ferramenta mais relevante.
- Se você tem informação suficiente, escreva o relatório final.

Formato do relatório final: PT-BR, 3-8 parágrafos ou bullets,
concreto, com fontes linkadas quando possível.

Responda sempre compacto. Não repita dados.
"""


class BackgroundTaskManager:
    MAX_CONCURRENT = 3

    def __init__(self, store: Any, llm: Any, tool_registry: Any) -> None:
        self.store = store
        self.llm = llm
        self.tool_registry = tool_registry
        self._running: dict[str, asyncio.Task[None]] = {}
        self._cancels: dict[str, asyncio.Event] = {}
        # Serialize the concurrency-gate + insert + register sequence
        # so concurrent start() callers cannot all observe
        # len(_running) < MAX_CONCURRENT and slip past the cap.
        self._lock = asyncio.Lock()

    async def start(self, goal: str, max_duration_min: int = 30) -> str:
        # Hold the lock across the gate check, DB insert, and task
        # registration. The to_thread(_insert) call is fast (a single
        # local sqlite write), so the lock-hold is bounded.
        async with self._lock:
            if len(self._running) >= self.MAX_CONCURRENT:
                raise RuntimeError("max concurrent background tasks reached")

            task_id = str(uuid.uuid4())
            now = datetime.now(timezone.utc).isoformat()

            def _insert() -> None:
                with self.store._connect() as conn:
                    conn.execute(
                        "INSERT INTO background_tasks"
                        " (id, goal, status, started_at, max_duration_min)"
                        " VALUES (?, ?, 'pending', ?, ?)",
                        (task_id, goal, now, max_duration_min),
                    )

            await asyncio.to_thread(_insert)
            cancel = asyncio.Event()
            self._cancels[task_id] = cancel
            self._running[task_id] = asyncio.create_task(
                self._run(task_id, goal, max_duration_min, cancel),
            )
            return task_id

    async def cancel(self, task_id: str) -> bool:
        ev = self._cancels.get(task_id)
        if ev is None:
            return False
        ev.set()
        await self._update_status(task_id, "cancelled")
        return True

    async def list_tasks(self, status: str | None = None) -> list[dict[str, Any]]:
        def _work() -> list[dict[str, Any]]:
            with self.store._connect() as conn:
                sql = (
                    "SELECT id, goal, status, progress, iterations, result,"
                    " started_at, finished_at FROM background_tasks"
                )
                if status:
                    rows = conn.execute(
                        sql + " WHERE status = ? ORDER BY started_at DESC LIMIT 50",
                        (status,),
                    ).fetchall()
                else:
                    rows = conn.execute(
                        sql + " ORDER BY started_at DESC LIMIT 50",
                    ).fetchall()
            return [
                {"id": r[0], "goal": r[1], "status": r[2], "progress": r[3],
                 "iterations": r[4], "result": r[5],
                 "started_at": r[6], "finished_at": r[7]}
                for r in rows
            ]

        return await asyncio.to_thread(_work)

    async def _update_status(
        self, task_id: str, status: str, *,
        progress: str | None = None, result: str | None = None,
        iterations: int | None = None,
    ) -> None:
        def _work() -> None:
            parts: list[str] = ["status = ?"]
            params: list[Any] = [status]
            if progress is not None:
                parts.append("progress = ?"); params.append(progress)
            if result is not None:
                parts.append("result = ?"); params.append(result)
            if iterations is not None:
                parts.append("iterations = ?"); params.append(iterations)
            if status in ("done", "failed", "cancelled"):
                parts.append("finished_at = ?")
                params.append(datetime.now(timezone.utc).isoformat())
            params.append(task_id)
            with self.store._connect() as conn:
                conn.execute(
                    f"UPDATE background_tasks SET {', '.join(parts)} WHERE id = ?",
                    params,
                )

        await asyncio.to_thread(_work)

    def _safe_tools(self) -> list[dict[str, Any]]:
        out = []
        for t in self.tool_registry.list():
            if t.name in _SAFE_TOOL_NAMES:
                out.append({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.json_schema,
                    },
                })
        return out

    async def _run(
        self, task_id: str, goal: str, max_duration_min: int,
        cancel: asyncio.Event,
    ) -> None:
        import time
        deadline = time.monotonic() + max_duration_min * 60
        await self._update_status(task_id, "running", progress="started")

        scratchpad: list[ChatMessage] = [
            ChatMessage(role="system", content=_PLANNER_PROMPT.format(goal=goal)),
            ChatMessage(role="user", content="Começa. Me traz um relatório no fim."),
        ]

        tokens_used = 0
        result_text = ""
        try:
            for iteration in range(_MAX_ITERATIONS):
                if cancel.is_set() or time.monotonic() > deadline:
                    break
                await self._update_status(
                    task_id, "running",
                    progress=f"iteration {iteration + 1}",
                    iterations=iteration,
                )

                try:
                    accumulated: list[str] = []
                    async for tok in self.llm.chat(scratchpad, temperature=0.3):
                        if cancel.is_set():
                            break
                        if tok.text:
                            accumulated.append(tok.text)
                            tokens_used += len(tok.text) // 4
                            if tokens_used >= _TOKEN_BUDGET:
                                break
                    text = "".join(accumulated).strip()
                except Exception as e:
                    logger.warning("bg %s llm error: %s", task_id, e)
                    break

                if not text:
                    break

                scratchpad.append(ChatMessage(role="assistant", content=text))

                # Naive completion detection: when the model writes a
                # final report-style answer (no more "vou buscar…"
                # language), we treat it as done.
                if (
                    len(text) > 400
                    and not any(
                        trigger in text.lower()
                        for trigger in (
                            "vou buscar", "vou pesquisar",
                            "próximo passo", "let me search",
                        )
                    )
                ):
                    result_text = text
                    break

                scratchpad.append(ChatMessage(role="user", content="Continue. Se terminou, entrega o relatório final."))

            if cancel.is_set():
                await self._update_status(task_id, "cancelled")
                return

            if result_text:
                await self._update_status(
                    task_id, "done",
                    progress="finished",
                    result=result_text[:8000],
                )
            else:
                await self._update_status(
                    task_id, "failed",
                    progress="no result produced",
                    result="task timed out or produced no final report",
                )
        except Exception as e:
            logger.exception("bg task %s crashed", task_id)
            await self._update_status(task_id, "failed", progress=f"crashed: {e}")
        finally:
            self._running.pop(task_id, None)
            self._cancels.pop(task_id, None)
