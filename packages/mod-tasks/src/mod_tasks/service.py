"""TaskService — domain service for the internal Task system.

Owns its own SQL against the shared core-db Store (no longer wraps
``MemoryStore.add_task`` etc.). Every method accepts ``user_id`` so the
same service can run single-tenant (user_id=None, Seraphine) or
multi-tenant (Aura, where the route layer extracts user_id from the
authenticated user via FastAPI deps).

Optional collaborators (``google_client``, ``llm_client``, ``app_state``)
are injected at construction time so ``execute_task`` can dispatch to
concrete integrations (e.g. Gmail download + finance PDF import).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sqlite3
import tempfile
import uuid
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

from core_db import Store

from mod_tasks.models import SeraphineTask

# Optional callback fired right after a task row is inserted. Receives
# (task_id, user_id) — implementations can fetch the row themselves and
# trigger side effects (e.g. mirror to a third-party calendar). Errors
# raised inside the callback are caught and logged so they never break
# the create_task call path.
TaskCreatedHook = Callable[[int, str | None], Awaitable[None]]

logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row_to_task(row: tuple[Any, ...]) -> SeraphineTask:
    """Map a 15-column SELECT row to a SeraphineTask."""
    raw_payload = row[6]
    try:
        payload = json.loads(raw_payload) if raw_payload else {}
    except (json.JSONDecodeError, TypeError):
        payload = {}
    raw_tags = row[12] if len(row) > 12 else None
    tags: list[str]
    try:
        if raw_tags:
            parsed = json.loads(raw_tags)
            tags = [str(x) for x in parsed] if isinstance(parsed, list) else []
        else:
            tags = []
    except (json.JSONDecodeError, TypeError):
        tags = []
    return SeraphineTask(
        id=row[0],
        type=row[1],
        status=row[2],
        title=row[3],
        description=row[4],
        source=row[5],
        payload=payload,
        created_at=row[7],
        updated_at=row[8],
        due_date=row[9],
        due_time=row[10],
        user_id=row[11],
        tags=tags,
        priority=row[13] if len(row) > 13 else None,
        remind=row[14] if len(row) > 14 else None,
    )


_SELECT_COLS = (
    "id, type, status, title, description, source, payload, created_at,"
    " updated_at, due_date, due_time, user_id, tags, priority, remind"
)


class TaskService:
    def __init__(
        self,
        store: Store,
        *,
        google_client: Any = None,
        llm_client: Any = None,
        app_state: Any = None,
    ) -> None:
        self._store = store
        self._google = google_client
        self._llm = llm_client
        self._app_state = app_state
        self._on_created: list[TaskCreatedHook] = []

    async def aclose(self) -> None:  # pragma: no cover - trivial
        return None

    def add_on_created_hook(self, hook: TaskCreatedHook) -> None:
        """Register a coroutine to run after each successful task insert.

        Hooks fire sequentially in registration order. Exceptions are
        swallowed (logged) so a failing hook never breaks task creation.
        """
        self._on_created.append(hook)

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
        due_date: str | None = None,
        due_time: str | None = None,
        user_id: str | None = None,
        priority: str | None = None,
        tags: list[str] | None = None,
        remind: str | None = None,
    ) -> int:
        ts = _now()
        payload_json = json.dumps(payload or {}, ensure_ascii=False)
        tags_json = json.dumps(tags or [], ensure_ascii=False)

        def _work() -> int:
            with self._store._connect() as conn:
                cur = conn.execute(
                    "INSERT INTO seraphine_tasks"
                    " (type, status, title, description, source, payload,"
                    "  created_at, updated_at, due_date, due_time, user_id,"
                    "  tags, priority, remind)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (type, status, title, description, source,
                     payload_json, ts, ts, due_date, due_time, user_id,
                     tags_json, priority, remind),
                )
                return int(cur.lastrowid or 0)

        task_id = await asyncio.to_thread(_work)
        for hook in self._on_created:
            try:
                await hook(task_id, user_id)
            except Exception:
                logger.exception(
                    "task_created hook raised for task=%s user=%s",
                    task_id, user_id,
                )
        return task_id

    async def list_tasks(
        self,
        *,
        status: str | None = None,
        type: str | None = None,
        limit: int = 100,
        due_from: str | None = None,
        due_to: str | None = None,
        user_id: str | None = None,
    ) -> list[SeraphineTask]:
        def _work() -> list[SeraphineTask]:
            clauses: list[str] = []
            params: list[Any] = []
            # When user_id is set, scope to that user. When None,
            # callers in single-tenant mode see ALL rows (legacy
            # Seraphine behavior — every row has user_id IS NULL).
            if user_id is not None:
                clauses.append("user_id = ?")
                params.append(user_id)
            if status is not None:
                clauses.append("status = ?")
                params.append(status)
            if type is not None:
                clauses.append("type = ?")
                params.append(type)
            if due_from is not None:
                clauses.append("due_date IS NOT NULL AND due_date >= ?")
                params.append(due_from)
            if due_to is not None:
                clauses.append("due_date IS NOT NULL AND due_date <= ?")
                params.append(due_to)
            where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
            params.append(limit)

            with self._store._connect() as conn:
                rows = conn.execute(
                    f"SELECT {_SELECT_COLS} FROM seraphine_tasks{where}"
                    " ORDER BY created_at DESC, id DESC LIMIT ?",
                    params,
                ).fetchall()
            return [_row_to_task(r) for r in rows]

        return await asyncio.to_thread(_work)

    async def get_task(
        self, task_id: int, *, user_id: str | None = None,
    ) -> SeraphineTask | None:
        def _work() -> SeraphineTask | None:
            with self._store._connect() as conn:
                if user_id is None:
                    row = conn.execute(
                        f"SELECT {_SELECT_COLS} FROM seraphine_tasks"
                        " WHERE id = ?",
                        (task_id,),
                    ).fetchone()
                else:
                    row = conn.execute(
                        f"SELECT {_SELECT_COLS} FROM seraphine_tasks"
                        " WHERE id = ? AND user_id = ?",
                        (task_id, user_id),
                    ).fetchone()
            if row is None:
                return None
            return _row_to_task(row)

        return await asyncio.to_thread(_work)

    async def update_status(
        self, task_id: int, status: str, *, user_id: str | None = None,
    ) -> int:
        ts = _now()

        def _work() -> int:
            with self._store._connect() as conn:
                if user_id is None:
                    cur = conn.execute(
                        "UPDATE seraphine_tasks SET status = ?, updated_at = ?"
                        " WHERE id = ?",
                        (status, ts, task_id),
                    )
                else:
                    cur = conn.execute(
                        "UPDATE seraphine_tasks SET status = ?, updated_at = ?"
                        " WHERE id = ? AND user_id = ?",
                        (status, ts, task_id, user_id),
                    )
                return cur.rowcount or 0

        return await asyncio.to_thread(_work)

    async def update_task(
        self,
        task_id: int,
        *,
        user_id: str | None = None,
        title: str | None = None,
        description: str | None = None,
        status: str | None = None,
        due_date: str | None = None,
        due_time: str | None = None,
        priority: str | None = None,
        tags: list[str] | None = None,
        remind: str | None = None,
        unset_due_date: bool = False,
        unset_due_time: bool = False,
        unset_priority: bool = False,
        unset_remind: bool = False,
    ) -> int:
        """Partial update. Only provided fields are written.

        To clear a nullable field, pass the ``unset_*`` flag rather than
        ``None`` (None means "don't touch"). ``tags`` uses a special
        sentinel: pass an empty list to clear tags.
        """
        sets: list[str] = []
        params: list[Any] = []
        if title is not None:
            sets.append("title = ?")
            params.append(title)
        if description is not None:
            sets.append("description = ?")
            params.append(description)
        if status is not None:
            sets.append("status = ?")
            params.append(status)
        if unset_due_date:
            sets.append("due_date = NULL")
        elif due_date is not None:
            sets.append("due_date = ?")
            params.append(due_date)
        if unset_due_time:
            sets.append("due_time = NULL")
        elif due_time is not None:
            sets.append("due_time = ?")
            params.append(due_time)
        if unset_priority:
            sets.append("priority = NULL")
        elif priority is not None:
            sets.append("priority = ?")
            params.append(priority)
        if tags is not None:
            sets.append("tags = ?")
            params.append(json.dumps(tags, ensure_ascii=False))
        if unset_remind:
            sets.append("remind = NULL")
        elif remind is not None:
            sets.append("remind = ?")
            params.append(remind)

        if not sets:
            # Nothing to update — treat as a no-op; callers that want to
            # confirm existence should use get_task.
            return 0

        sets.append("updated_at = ?")
        params.append(_now())

        def _work() -> int:
            with self._store._connect() as conn:
                if user_id is None:
                    sql = (
                        "UPDATE seraphine_tasks SET "
                        + ", ".join(sets)
                        + " WHERE id = ?"
                    )
                    cur = conn.execute(sql, (*params, task_id))
                else:
                    sql = (
                        "UPDATE seraphine_tasks SET "
                        + ", ".join(sets)
                        + " WHERE id = ? AND user_id = ?"
                    )
                    cur = conn.execute(sql, (*params, task_id, user_id))
                return cur.rowcount or 0

        return await asyncio.to_thread(_work)

    async def delete_task(
        self, task_id: int, *, user_id: str | None = None,
    ) -> int:
        def _work() -> int:
            with self._store._connect() as conn:
                if user_id is None:
                    cur = conn.execute(
                        "DELETE FROM seraphine_tasks WHERE id = ?",
                        (task_id,),
                    )
                else:
                    cur = conn.execute(
                        "DELETE FROM seraphine_tasks WHERE id = ?"
                        " AND user_id = ?",
                        (task_id, user_id),
                    )
                return cur.rowcount or 0

        return await asyncio.to_thread(_work)

    # ------------------------------------------------------------------
    # Execution
    # ------------------------------------------------------------------

    async def execute_task(
        self,
        task_id: int,
        params: dict[str, Any] | None = None,
        *,
        user_id: str | None = None,
    ) -> dict[str, Any]:
        params = params or {}
        task = await self.get_task(task_id, user_id=user_id)
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
                await self.update_status(task_id, "failed", user_id=user_id)
            except Exception:  # pragma: no cover
                logger.exception("failed to mark task %d as failed", task_id)
            raise

        try:
            await self.update_status(task_id, "completed", user_id=user_id)
        except Exception:  # pragma: no cover
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

        pdf_bytes = await self._google.download_attachment(email_id, attachment_id)

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
            try:
                tool_summary = result.model_dump()
            except AttributeError:
                tool_summary = {"ok": True, "output": str(result)}
        finally:
            try:
                os.unlink(tmp_path)
            except FileNotFoundError:
                pass
            except Exception:  # pragma: no cover
                logger.exception("failed to unlink temp file %s", tmp_path)

        return {
            "filename": filename,
            "imported": True,
            "result": tool_summary,
        }
