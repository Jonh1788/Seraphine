"""TaskService — thin async service on top of :class:`MemoryStore`.

The service owns the lifecycle of Seraphine's proactive internal tasks
(creation, status updates, execution dispatch). Persistence lives in the
shared ``MemoryStore`` (``seraphine_tasks`` table), not in a separate
SQLite file, so tasks share the same DB as the rest of memory.

Optional collaborators (``google_client``, ``llm_client``, ``app_state``)
are injected at construction time so ``execute_task`` can dispatch to
concrete integrations (e.g. Gmail download + finance PDF import) without
the service itself having to know the whole app wiring.
"""

from __future__ import annotations

import logging
import os
import tempfile
from typing import Any

from seraphine.memory.store import MemoryStore
from seraphine.tasks.models import SeraphineTask

logger = logging.getLogger(__name__)


def _to_task(row: dict[str, Any]) -> SeraphineTask:
    return SeraphineTask(
        id=row["id"],
        type=row["type"],
        status=row["status"],
        title=row["title"],
        description=row["description"],
        source=row["source"],
        payload=row.get("payload") or {},
        created_at=row.get("created_at"),
        updated_at=row.get("updated_at"),
    )


class TaskService:
    def __init__(
        self,
        store: MemoryStore,
        *,
        google_client: Any = None,
        llm_client: Any = None,
        app_state: Any = None,
    ) -> None:
        self._store = store
        self._google = google_client
        self._llm = llm_client
        self._app_state = app_state

    # ------------------------------------------------------------------
    # Lifecycle (kept for symmetry with other services that need aclose)
    # ------------------------------------------------------------------

    async def aclose(self) -> None:  # pragma: no cover - trivial
        return None

    # ------------------------------------------------------------------
    # CRUD
    # ------------------------------------------------------------------

    async def create_task(
        self,
        *,
        type: str,
        title: str,
        description: str = "",
        source: str = "system",
        payload: dict[str, Any] | None = None,
        status: str = "pending",
    ) -> int:
        return await self._store.add_task(
            type=type,
            status=status,
            title=title,
            description=description,
            source=source,
            payload=payload or {},
        )

    async def list_tasks(
        self,
        *,
        status: str | None = None,
        type: str | None = None,
        limit: int = 100,
    ) -> list[SeraphineTask]:
        rows = await self._store.get_tasks(
            status=status, type=type, limit=limit
        )
        return [_to_task(r) for r in rows]

    async def get_task(self, task_id: int) -> SeraphineTask | None:
        row = await self._store.get_task(task_id)
        if row is None:
            return None
        return _to_task(row)

    async def update_status(self, task_id: int, status: str) -> int:
        """Update a task's status; returns number of rows affected."""
        return await self._store.update_task_status(task_id, status)

    async def delete_task(self, task_id: int) -> int:
        """Delete a task by id; returns number of rows affected."""
        return await self._store.delete_task(task_id)

    # ------------------------------------------------------------------
    # Execution
    # ------------------------------------------------------------------

    async def execute_task(
        self, task_id: int, params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Dispatch execution of a task by type.

        Always updates the stored status to ``completed`` on success or
        ``failed`` on error. Returns a summary dict describing what the
        handler did. Unknown types raise ``NotImplementedError``.
        """
        params = params or {}
        task = await self.get_task(task_id)
        if task is None:
            raise ValueError(f"task {task_id} not found")

        try:
            if task.type == "finance_import":
                result = await self._execute_finance_import(task, params)
            else:
                raise NotImplementedError(
                    f"execute_task: type '{task.type}' is not implemented yet"
                )
        except Exception as exc:
            logger.exception(
                "task %d (%s) execution failed: %s", task_id, task.type, exc,
            )
            try:
                await self.update_status(task_id, "failed")
            except Exception:  # pragma: no cover - defensive
                logger.exception("failed to mark task %d as failed", task_id)
            raise

        try:
            await self.update_status(task_id, "completed")
        except Exception:  # pragma: no cover - defensive
            logger.exception("failed to mark task %d as completed", task_id)
        return result

    async def _execute_finance_import(
        self, task: SeraphineTask, params: dict[str, Any],
    ) -> dict[str, Any]:
        if self._google is None:
            raise RuntimeError("google client not available for finance_import")

        payload = task.payload or {}
        email_id = payload.get("email_id")
        attachment_id = payload.get("attachment_id")
        filename = payload.get("filename") or "attachment.pdf"
        if not email_id or not attachment_id:
            raise ValueError(
                "finance_import payload missing email_id or attachment_id"
            )

        # 1. Download attachment from Gmail
        pdf_bytes = await self._google.download_attachment(email_id, attachment_id)

        # 2. Resolve the PDF import tool up front — if it isn't wired, fail
        #    loudly so execute_task marks the task ``failed`` rather than
        #    silently completing without actually importing anything.
        tools = getattr(self._app_state, "tools", None) if self._app_state else None
        if tools is None:
            raise RuntimeError(
                "finance_import: tool registry not available (app_state.tools is None)"
            )
        try:
            tool = tools.get("import_financial_pdf")
        except Exception:
            tool = None
        if tool is None:
            raise RuntimeError(
                "finance_import: 'import_financial_pdf' tool is not registered"
            )

        # 3. Persist to a temp file — the PDF import tool expects a path.
        #    The file is always unlinked after the tool finishes (or raises)
        #    to avoid leaking decrypted PDF bytes on disk.
        suffix = os.path.splitext(filename)[1] or ".pdf"
        fd, tmp_path = tempfile.mkstemp(suffix=suffix, prefix="seraphine_task_")
        try:
            os.write(fd, pdf_bytes)
        finally:
            os.close(fd)

        password = params.get("password") or payload.get("password")
        try:
            args: dict[str, Any] = {"file_path": tmp_path}
            if password:
                args["password"] = password
            try:
                result = await tool.execute(args)
            except Exception as exc:
                logger.exception("import_financial_pdf tool raised: %s", exc)
                raise
            # ToolResult is a pydantic BaseModel — serialize to dict
            try:
                tool_summary = result.model_dump()
            except AttributeError:
                tool_summary = {"ok": True, "output": str(result)}
        finally:
            try:
                os.unlink(tmp_path)
            except FileNotFoundError:
                pass
            except Exception:  # pragma: no cover - defensive
                logger.exception("failed to unlink temp file %s", tmp_path)

        return {
            "filename": filename,
            "imported": True,
            "result": tool_summary,
        }
