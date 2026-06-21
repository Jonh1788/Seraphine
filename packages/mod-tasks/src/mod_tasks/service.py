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
from mod_tasks.schema import (
    _derive_category as _derive_task_category,
    _normalize_category as _normalize_task_category,
)

# Optional callback fired right after a task row is inserted. Receives
# (task_id, user_id) — implementations can fetch the row themselves and
# trigger side effects (e.g. mirror to a third-party calendar). Errors
# raised inside the callback are caught and logged so they never break
# the create_task call path.
TaskCreatedHook = Callable[[int, str | None], Awaitable[None]]

# Optional callback fired right after a task row is deleted. Receives
# (task_id, user_id, payload) — payload is the parsed JSON dict captured
# *before* the row was removed, so consumers can still read sidecar info
# like ``google_event_id``. Errors are swallowed.
TaskDeletedHook = Callable[[int, str | None, dict[str, Any]], Awaitable[None]]

logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _freshness_policy_now() -> datetime | None:
    """Override hook used by tests to pin "now" for freshness filtering.

    Returns ``None`` in production so ``FreshnessPolicy.sql_fresh_filter``
    falls back to its own wall-clock. Tests monkeypatch this symbol to
    inject a fixed datetime — see tests/freshness/test_dao_fresh_filter_tasks.py.
    """
    return None


def _row_to_task(row: tuple[Any, ...]) -> SeraphineTask:
    """Map a SELECT row (see ``_SELECT_COLS``) to a SeraphineTask."""
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
        completed_by=row[15] if len(row) > 15 else None,
        category=row[16] if len(row) > 16 else None,
    )


_SELECT_COLS = (
    "id, type, status, title, description, source, payload, created_at,"
    " updated_at, due_date, due_time, user_id, tags, priority, remind,"
    " completed_by, category"
)


class TaskService:
    def __init__(
        self,
        store: Store,
        *,
        google_client: Any = None,
        llm_client: Any = None,
        app_state: Any = None,
        default_offsets_fetcher: (
            Callable[[str], Awaitable[list[int]]] | None
        ) = None,
    ) -> None:
        self._store = store
        self._google = google_client
        self._llm = llm_client
        self._app_state = app_state
        self._on_created: list[TaskCreatedHook] = []
        self._on_deleted: list[TaskDeletedHook] = []
        self._email_to_user_id: Callable[[str], Awaitable[str | None]] | None = None
        self._user_id_to_email: Callable[[str], Awaitable[str | None]] | None = None
        # Duck-typed: must expose `async send_to_user(user_id, payload) -> int`.
        self._push: Any | None = None
        # Optional per-user default reminder offsets lookup. Seraphine
        # (single-tenant) leaves this None and gets no defaults applied.
        self._default_offsets_fetcher = default_offsets_fetcher

    async def get_default_offsets(self, user_id: str | None) -> list[int]:
        """Return the user's default reminder offsets via the injected
        fetcher, or [] when no fetcher is wired or the call fails."""
        if self._default_offsets_fetcher is None or not user_id:
            return []
        try:
            result = await self._default_offsets_fetcher(user_id)
        except Exception:
            logger.exception(
                "default_offsets_fetcher raised for user=%s", user_id,
            )
            return []
        if not result:
            return []
        return [int(v) for v in result if isinstance(v, int) and not isinstance(v, bool)]

    async def aclose(self) -> None:  # pragma: no cover - trivial
        return None

    def add_on_created_hook(self, hook: TaskCreatedHook) -> None:
        """Register a coroutine to run after each successful task insert.

        Hooks fire sequentially in registration order. Exceptions are
        swallowed (logged) so a failing hook never breaks task creation.
        """
        self._on_created.append(hook)

    def add_on_deleted_hook(self, hook: TaskDeletedHook) -> None:
        """Register a coroutine to run after each successful delete.

        The payload dict is captured *before* the row is removed so the
        callback can still see sidecar fields (e.g. google_event_id).
        Exceptions are swallowed.
        """
        self._on_deleted.append(hook)

    def attach_user_lookup(
        self,
        *,
        email_to_user_id: Callable[[str], Awaitable[str | None]],
        user_id_to_email: Callable[[str], Awaitable[str | None]],
    ) -> None:
        """Wire app-level email <-> user_id lookups.

        Required for participant management (Aura). When unset, methods
        that need email lookup raise RuntimeError.
        """
        self._email_to_user_id = email_to_user_id
        self._user_id_to_email = user_id_to_email

    def attach_push(self, push: Any) -> None:
        """Wire a PushService for participant notifications.

        The object must expose ``async send_to_user(user_id, payload)``.
        Push delivery is fire-and-forget — failures are logged, never
        propagated.
        """
        self._push = push

    # ------------------------------------------------------------------
    # Participants (Aura sharing)
    # ------------------------------------------------------------------

    async def list_participants(self, task_id: int) -> list[str]:
        """Return participant emails for a task (owner first, then members
        by joined_at). Empty list if task has no participants (Seraphine)
        or doesn't exist."""
        if self._user_id_to_email is None:
            raise RuntimeError("user_id_to_email lookup not attached")

        def _work() -> list[str]:
            with self._store._connect() as conn:
                rows = conn.execute(
                    "SELECT user_id FROM task_participants"
                    " WHERE task_id = ?"
                    " ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END,"
                    " joined_at ASC",
                    (task_id,),
                ).fetchall()
            return [r[0] for r in rows]

        user_ids = await asyncio.to_thread(_work)
        emails: list[str] = []
        for uid in user_ids:
            email = await self._user_id_to_email(uid)
            if email:
                emails.append(email)
        return emails

    async def _authorize_participant(
        self, task_id: int, caller_id: str,
    ) -> str:
        """Returns the caller's role ('owner'|'member') or raises
        PermissionError if not a participant."""

        def _work() -> str | None:
            with self._store._connect() as conn:
                row = conn.execute(
                    "SELECT role FROM task_participants"
                    " WHERE task_id = ? AND user_id = ?",
                    (task_id, caller_id),
                ).fetchone()
            return row[0] if row else None

        role = await asyncio.to_thread(_work)
        if role is None:
            raise PermissionError(
                f"user {caller_id} is not a participant of task {task_id}"
            )
        return role

    async def add_participant(
        self, task_id: int, *, caller_id: str, target_email: str,
    ) -> list[str]:
        """Owner-only. Resolves email to user_id, inserts a member row,
        fires a push notification. Returns the updated participant emails.

        Raises:
            PermissionError: caller is not the owner.
            LookupError: email is not a registered Aura user.
            ValueError: target is already a participant.
        """
        if self._email_to_user_id is None or self._user_id_to_email is None:
            raise RuntimeError("user lookup not attached")

        role = await self._authorize_participant(task_id, caller_id)
        if role != "owner":
            raise PermissionError("only the task owner can add participants")

        target_uid = await self._email_to_user_id(target_email.strip().lower())
        if target_uid is None:
            raise LookupError("no aura user for that email")

        ts = _now()

        def _work() -> str:
            with self._store._connect() as conn:
                try:
                    conn.execute(
                        "INSERT INTO task_participants"
                        " (task_id, user_id, role, joined_at) VALUES"
                        " (?, ?, 'member', ?)",
                        (task_id, target_uid, ts),
                    )
                except sqlite3.IntegrityError:
                    raise ValueError("already a participant") from None
            return target_uid

        added_uid = await asyncio.to_thread(_work)

        # Fire-and-forget push
        if self._push is not None:
            owner_email = await self._user_id_to_email(caller_id) or "alguém"
            task = await self.get_task_raw(task_id)
            title = task.title if task else "tarefa"
            payload = {
                "title": "Nova tarefa compartilhada",
                "body": f"{owner_email}: {title}",
                "url": f"/tasks?focus={task_id}",
            }
            asyncio.create_task(self._safe_push(added_uid, payload))

        return await self.list_participants(task_id)

    async def _safe_push(self, user_id: str, payload: dict[str, Any]) -> None:
        """Internal: fire push and log failures, never raise."""
        if self._push is None:
            return
        try:
            await self._push.send_to_user(user_id, payload)
        except Exception:
            logger.exception("push send_to_user failed for %s", user_id)

    async def get_task_raw(self, task_id: int) -> SeraphineTask | None:
        """Like get_task but bypasses caller scoping. INTERNAL USE only —
        callers must already have authorized."""

        def _work() -> SeraphineTask | None:
            with self._store._connect() as conn:
                row = conn.execute(
                    f"SELECT {_SELECT_COLS} FROM seraphine_tasks WHERE id = ?",
                    (task_id,),
                ).fetchone()
            return _row_to_task(row) if row else None

        task = await asyncio.to_thread(_work)
        if task is not None and task.id is not None:
            task.reminder_offsets = await self.get_reminder_offsets(
                str(task.id), "",
            )
        return task

    async def leave_task(self, task_id: int, *, caller_id: str) -> None:
        """Any non-owner participant leaves. Owner gets PermissionError
        (must delete the task or remove members individually)."""
        role = await self._authorize_participant(task_id, caller_id)
        if role == "owner":
            raise PermissionError("owner cannot leave the task")

        def _work() -> None:
            with self._store._connect() as conn:
                conn.execute(
                    "DELETE FROM task_participants"
                    " WHERE task_id = ? AND user_id = ?",
                    (task_id, caller_id),
                )

        await asyncio.to_thread(_work)

    async def remove_participant(
        self, task_id: int, *, caller_id: str, target_user_id: str,
    ) -> None:
        """Owner-only. Removes a member. Owner cannot remove themselves
        (use delete_task or transfer flow)."""
        role = await self._authorize_participant(task_id, caller_id)
        if role != "owner":
            raise PermissionError("only the owner can remove participants")
        if target_user_id == caller_id:
            raise ValueError("owner cannot remove self")

        def _work() -> int:
            with self._store._connect() as conn:
                cur = conn.execute(
                    "DELETE FROM task_participants"
                    " WHERE task_id = ? AND user_id = ? AND role = 'member'",
                    (task_id, target_user_id),
                )
            return cur.rowcount or 0

        affected = await asyncio.to_thread(_work)

        if affected and self._push is not None and self._user_id_to_email is not None:
            owner_email = await self._user_id_to_email(caller_id) or "alguém"
            task = await self.get_task_raw(task_id)
            title = task.title if task else "tarefa"
            payload = {
                "title": "Removido de tarefa",
                "body": f"{owner_email} removeu você de: {title}",
            }
            asyncio.create_task(self._safe_push(target_user_id, payload))

    async def remove_participant_by_email(
        self, task_id: int, *, caller_id: str, target_email: str,
    ) -> None:
        """Owner-only. Resolves email to user_id, then calls
        remove_participant. Raises LookupError if email is unknown."""
        if self._email_to_user_id is None:
            raise RuntimeError("email_to_user_id lookup not attached")
        target_uid = await self._email_to_user_id(target_email.strip().lower())
        if target_uid is None:
            raise LookupError("no aura user for that email")
        await self.remove_participant(
            task_id, caller_id=caller_id, target_user_id=target_uid,
        )

    # ------------------------------------------------------------------
    # Reminder offsets (multi-offset push fan-out)
    # ------------------------------------------------------------------

    async def set_reminder_offsets(
        self, task_id: str, user_id: str, offsets: list[int],
    ) -> list[int]:
        """Replace the offsets for a task. Returns the persisted set
        (deduped, sorted). Wipes push/WA dispatch rows tied to offsets
        that were removed so a reschedule can re-fire them.

        ``user_id`` is required even in single-tenant mode (pass "" if
        no user — matches the schema backfill convention)."""
        clean = sorted({int(o) for o in offsets if int(o) >= 0})
        ts = _now()

        def _work() -> list[int]:
            with self._store._connect() as conn:
                existing = {
                    int(r[0]) for r in conn.execute(
                        "SELECT offset_minutes FROM task_reminder_offsets"
                        " WHERE task_id = ?",
                        (str(task_id),),
                    ).fetchall()
                }
                target = set(clean)
                to_remove = existing - target
                to_add = target - existing
                for off in to_remove:
                    conn.execute(
                        "DELETE FROM task_reminder_offsets"
                        " WHERE task_id = ? AND offset_minutes = ?",
                        (str(task_id), off),
                    )
                    # Also wipe dispatch ledger rows so a future reschedule
                    # can re-fire. Tables may not exist in Seraphine — best
                    # effort.
                    for tbl in ("push_dispatches", "aura_whatsapp_dispatches"):
                        try:
                            conn.execute(
                                f"DELETE FROM {tbl}"
                                " WHERE task_id = ? AND offset_minutes = ?",
                                (str(task_id), off),
                            )
                        except sqlite3.OperationalError:
                            pass
                for off in to_add:
                    conn.execute(
                        "INSERT OR IGNORE INTO task_reminder_offsets"
                        " (task_id, user_id, offset_minutes, created_at)"
                        " VALUES (?, ?, ?, ?)",
                        (str(task_id), user_id, off, ts),
                    )
            return clean

        return await asyncio.to_thread(_work)

    async def get_reminder_offsets(
        self, task_id: str, user_id: str,
    ) -> list[int]:
        """Return the sorted offsets for a task. user_id is reserved for
        future authorization filtering — currently unused, but kept on the
        signature so callers don't need to refactor later."""
        del user_id  # reserved

        def _work() -> list[int]:
            with self._store._connect() as conn:
                rows = conn.execute(
                    "SELECT offset_minutes FROM task_reminder_offsets"
                    " WHERE task_id = ? ORDER BY offset_minutes ASC",
                    (str(task_id),),
                ).fetchall()
            return [int(r[0]) for r in rows]

        return await asyncio.to_thread(_work)

    async def _load_offsets_bulk(
        self, task_ids: list[Any],
    ) -> dict[str, list[int]]:
        """Single query to load offsets for many tasks at once. Returns
        ``{task_id_as_str: [offsets...]}``."""
        if not task_ids:
            return {}
        ids = [str(t) for t in task_ids]

        def _work() -> dict[str, list[int]]:
            placeholders = ",".join("?" for _ in ids)
            with self._store._connect() as conn:
                rows = conn.execute(
                    f"SELECT task_id, offset_minutes FROM task_reminder_offsets"
                    f" WHERE task_id IN ({placeholders})"
                    " ORDER BY task_id, offset_minutes ASC",
                    ids,
                ).fetchall()
            out: dict[str, list[int]] = {}
            for tid, off in rows:
                out.setdefault(str(tid), []).append(int(off))
            return out

        return await asyncio.to_thread(_work)

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
        category: str | None = None,
    ) -> int:
        ts = _now()
        payload_json = json.dumps(payload or {}, ensure_ascii=False)
        tags_json = json.dumps(tags or [], ensure_ascii=False)
        # Explicit category wins (normalized); otherwise derive from
        # tags/type so the chip lights up without manual tagging — same
        # precedence the frontend uses.
        if category is not None:
            category = _normalize_task_category(category) or None
        if category is None:
            category = _derive_task_category(tags_json, type)

        def _work() -> int:
            with self._store._connect() as conn:
                cur = conn.execute(
                    "INSERT INTO seraphine_tasks"
                    " (type, status, title, description, source, payload,"
                    "  created_at, updated_at, due_date, due_time, user_id,"
                    "  tags, priority, remind, category)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (type, status, title, description, source,
                     payload_json, ts, ts, due_date, due_time, user_id,
                     tags_json, priority, remind, category),
                )
                new_id = int(cur.lastrowid or 0)
                if user_id is not None and new_id > 0:
                    conn.execute(
                        "INSERT OR IGNORE INTO task_participants"
                        " (task_id, user_id, role, joined_at) VALUES"
                        " (?, ?, 'owner', ?)",
                        (new_id, user_id, ts),
                    )
                return new_id

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
        fresh_only: bool = False,
    ) -> list[SeraphineTask]:
        def _work() -> list[tuple]:
            clauses: list[str] = []
            params: list[Any] = []
            if user_id is not None:
                # JOIN scope: caller must be a participant
                join = (
                    " JOIN task_participants p ON p.task_id = t.id"
                    " AND p.user_id = ?"
                )
                params.append(user_id)
            else:
                # Single-tenant Seraphine: no scoping
                join = ""
            if status is not None:
                clauses.append("t.status = ?")
                params.append(status)
            if type is not None:
                clauses.append("t.type = ?")
                params.append(type)
            if due_from is not None:
                clauses.append("t.due_date IS NOT NULL AND t.due_date >= ?")
                params.append(due_from)
            if due_to is not None:
                clauses.append("t.due_date IS NOT NULL AND t.due_date <= ?")
                params.append(due_to)
            if fresh_only:
                # Lazy import: mod-tasks does not declare seraphine as a
                # dependency (layering: app -> package, not reverse).
                # The freshness module ships with the Seraphine backend;
                # at runtime in any process that calls fresh_only=True it
                # is guaranteed to be importable.
                from seraphine.freshness import DEFAULT_POLICY

                fragment, fragment_params = DEFAULT_POLICY.sql_fresh_filter(
                    created_col="t.created_at",
                    event_col="t.due_date",
                    now=_freshness_policy_now(),
                )
                clauses.append(fragment)
                params.extend(fragment_params)
            where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
            params.append(limit)

            cols_t = ", ".join(f"t.{c.strip()}" for c in _SELECT_COLS.split(","))
            with self._store._connect() as conn:
                return conn.execute(
                    f"SELECT {cols_t} FROM seraphine_tasks t{join}{where}"
                    " ORDER BY t.created_at DESC, t.id DESC LIMIT ?",
                    params,
                ).fetchall()

        rows = await asyncio.to_thread(_work)
        tasks = [_row_to_task(r) for r in rows]
        # Bulk-load reminder offsets (one SELECT, not N).
        ids = [t.id for t in tasks if t.id is not None]
        offsets_map = await self._load_offsets_bulk(ids)
        for t in tasks:
            if t.id is not None:
                t.reminder_offsets = offsets_map.get(str(t.id), [])
        # Populate computed fields
        for t in tasks:
            await self._populate_computed(t, caller_id=user_id)
        return tasks

    async def _populate_computed(
        self, task: SeraphineTask, *, caller_id: str | None,
    ) -> None:
        """Fill participants[], is_owner, completed_by_email. No-op for
        single-tenant tasks (caller_id is None) or when lookup not wired."""
        if task.id is None or caller_id is None:
            return
        if self._user_id_to_email is None:
            return  # not wired (Seraphine path) — leave defaults

        def _work() -> tuple[list[str], str | None]:
            with self._store._connect() as conn:
                rows = conn.execute(
                    "SELECT user_id, role FROM task_participants"
                    " WHERE task_id = ?"
                    " ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END,"
                    " joined_at ASC",
                    (task.id,),
                ).fetchall()
            uids = [r[0] for r in rows]
            caller_role = next((r[1] for r in rows if r[0] == caller_id), None)
            return uids, caller_role

        uids, caller_role = await asyncio.to_thread(_work)
        emails: list[str] = []
        for u in uids:
            e = await self._user_id_to_email(u)
            if e:
                emails.append(e)
        task.participants = emails
        task.is_owner = caller_role == "owner"
        if task.completed_by:
            task.completed_by_email = await self._user_id_to_email(task.completed_by)

    async def get_task(
        self, task_id: int, *, user_id: str | None = None,
    ) -> SeraphineTask | None:
        def _work() -> tuple | None:
            cols_t = ", ".join(f"t.{c.strip()}" for c in _SELECT_COLS.split(","))
            with self._store._connect() as conn:
                if user_id is None:
                    return conn.execute(
                        f"SELECT {cols_t} FROM seraphine_tasks t WHERE t.id = ?",
                        (task_id,),
                    ).fetchone()
                else:
                    return conn.execute(
                        f"SELECT {cols_t} FROM seraphine_tasks t"
                        " JOIN task_participants p"
                        " ON p.task_id = t.id AND p.user_id = ?"
                        " WHERE t.id = ?",
                        (user_id, task_id),
                    ).fetchone()

        row = await asyncio.to_thread(_work)
        if row is None:
            return None
        task = _row_to_task(row)
        if task.id is not None:
            task.reminder_offsets = await self.get_reminder_offsets(
                str(task.id), user_id or "",
            )
        await self._populate_computed(task, caller_id=user_id)
        return task

    async def update_status(
        self, task_id: int, status: str, *, user_id: str | None = None,
    ) -> int:
        ts = _now()

        def _work() -> tuple[int, str | None, str | None]:
            with self._store._connect() as conn:
                if user_id is None:
                    cur_row = conn.execute(
                        "SELECT status, title FROM seraphine_tasks WHERE id = ?",
                        (task_id,),
                    ).fetchone()
                else:
                    cur_row = conn.execute(
                        "SELECT t.status, t.title FROM seraphine_tasks t"
                        " JOIN task_participants p"
                        "   ON p.task_id = t.id AND p.user_id = ?"
                        " WHERE t.id = ?",
                        (user_id, task_id),
                    ).fetchone()
                if cur_row is None:
                    return 0, None, None
                prev_status, title = cur_row[0], cur_row[1]
                if prev_status == status:
                    return 0, prev_status, title  # idempotent
                completed_by = user_id if status == "completed" else None
                conn.execute(
                    "UPDATE seraphine_tasks"
                    " SET status = ?, updated_at = ?, completed_by = ?"
                    " WHERE id = ?",
                    (status, ts, completed_by, task_id),
                )
                return 1, prev_status, title

        affected, prev_status, title = await asyncio.to_thread(_work)
        if affected and user_id is not None and self._push is not None and self._user_id_to_email is not None:
            actor_email = await self._user_id_to_email(user_id) or user_id
            recipients = await self._other_participants(task_id, user_id)
            if status == "completed":
                payload = {
                    "title": "Tarefa concluída",
                    "body": f"{actor_email} concluiu: {title}",
                    "url": f"/tasks?focus={task_id}",
                }
            elif prev_status == "completed":  # reopened
                payload = {
                    "title": "Tarefa reaberta",
                    "body": f"{actor_email} reabriu: {title}",
                    "url": f"/tasks?focus={task_id}",
                }
            else:
                payload = None
            if payload is not None:
                for uid in recipients:
                    asyncio.create_task(self._safe_push(uid, payload))
        return affected

    async def _other_participants(
        self, task_id: int, exclude_user_id: str,
    ) -> list[str]:
        def _work() -> list[str]:
            with self._store._connect() as conn:
                rows = conn.execute(
                    "SELECT user_id FROM task_participants"
                    " WHERE task_id = ? AND user_id != ?",
                    (task_id, exclude_user_id),
                ).fetchall()
            return [r[0] for r in rows]

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
        category: str | None = None,
        unset_due_date: bool = False,
        unset_due_time: bool = False,
        unset_priority: bool = False,
        unset_remind: bool = False,
        unset_category: bool = False,
    ) -> int:
        """Partial update. Only provided fields are written.

        To clear a nullable field, pass the ``unset_*`` flag rather than
        ``None`` (None means "don't touch"). ``tags`` uses a special
        sentinel: pass an empty list to clear tags.

        ``category`` precedence: an explicit (normalized) value wins;
        ``unset_category`` clears it; otherwise, when ``tags`` is provided
        and no category was given, it is re-derived from the new tags so
        the chip stays in sync with the labels.
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
        tags_json: str | None = None
        if tags is not None:
            tags_json = json.dumps(tags, ensure_ascii=False)
            sets.append("tags = ?")
            params.append(tags_json)
        if unset_remind:
            sets.append("remind = NULL")
        elif remind is not None:
            sets.append("remind = ?")
            params.append(remind)

        # category: explicit value (normalized) > unset > re-derive from
        # newly-set tags. Leave untouched when none of these apply.
        if unset_category:
            sets.append("category = NULL")
        elif category is not None:
            norm = _normalize_task_category(category)
            if norm:
                sets.append("category = ?")
                params.append(norm)
            else:
                sets.append("category = NULL")
        elif tags is not None:
            derived = _derive_task_category(tags_json, None)
            sets.append("category = ?")
            params.append(derived)

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
                    # Authorize via task_participants JOIN — any
                    # participant can edit fields except status (handled
                    # by update_status).
                    sql = (
                        "UPDATE seraphine_tasks SET "
                        + ", ".join(sets)
                        + " WHERE id = ? AND id IN ("
                        "   SELECT task_id FROM task_participants"
                        "   WHERE user_id = ?"
                        " )"
                    )
                    cur = conn.execute(sql, (*params, task_id, user_id))
                return cur.rowcount or 0

        return await asyncio.to_thread(_work)

    async def delete_task(
        self, task_id: int, *, user_id: str | None = None,
    ) -> int:
        def _work() -> tuple[int, dict[str, Any]]:
            with self._store._connect() as conn:
                if user_id is None:
                    row = conn.execute(
                        "SELECT payload FROM seraphine_tasks WHERE id = ?",
                        (task_id,),
                    ).fetchone()
                else:
                    row = conn.execute(
                        "SELECT t.payload FROM seraphine_tasks t"
                        " JOIN task_participants p"
                        "   ON p.task_id = t.id AND p.user_id = ?"
                        "   AND p.role = 'owner'"
                        " WHERE t.id = ?",
                        (user_id, task_id),
                    ).fetchone()
                payload: dict[str, Any] = {}
                if row and row[0]:
                    try:
                        parsed = json.loads(row[0])
                        if isinstance(parsed, dict):
                            payload = parsed
                    except (json.JSONDecodeError, TypeError):
                        payload = {}
                if user_id is None:
                    cur = conn.execute(
                        "DELETE FROM seraphine_tasks WHERE id = ?",
                        (task_id,),
                    )
                else:
                    cur = conn.execute(
                        "DELETE FROM seraphine_tasks"
                        " WHERE id = ? AND id IN ("
                        "   SELECT task_id FROM task_participants"
                        "   WHERE user_id = ? AND role = 'owner'"
                        " )",
                        (task_id, user_id),
                    )
                affected = cur.rowcount or 0
                if affected:
                    # Cascade-like cleanup for offsets (no FK).
                    conn.execute(
                        "DELETE FROM task_reminder_offsets WHERE task_id = ?",
                        (str(task_id),),
                    )
                return affected, payload

        affected, payload = await asyncio.to_thread(_work)
        if affected:
            for hook in self._on_deleted:
                try:
                    await hook(task_id, user_id, payload)
                except Exception:
                    logger.exception(
                        "task_deleted hook raised for task=%s user=%s",
                        task_id, user_id,
                    )
        return affected

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
