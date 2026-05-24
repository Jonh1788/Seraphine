"""WorkProjectService -- projects, links and briefing helpers."""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime, timezone
from typing import Any, Iterable

from core_db import Store

from seraphine.work.models import WorkProject, WorkProjectLink


_PROJECT_COLS = (
    "id, name, description, area, status, priority, tags, links,"
    " due_date, created_at, updated_at"
)
_LINK_COLS = (
    "id, project_id, target_type, target_id, title, metadata, created_at"
)
_STATUSES = {"active", "paused", "done", "archived"}
_PRIORITIES = {"low", "medium", "high"}
_LINK_TYPES = {"task", "note", "cv_triage", "url", "memory", "file", "other"}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _clean_list(values: Iterable[Any] | None) -> list[str]:
    if not values:
        return []
    out: list[str] = []
    seen: set[str] = set()
    for value in values:
        text = str(value).strip()
        if not text or text in seen:
            continue
        seen.add(text)
        out.append(text)
    return out


def _json_list(values: Iterable[Any] | None) -> str:
    return json.dumps(_clean_list(values), ensure_ascii=False)


def _json_obj(value: dict[str, Any] | None) -> str:
    return json.dumps(value or {}, ensure_ascii=False)


def _today_iso() -> str:
    return datetime.now().date().isoformat()


class WorkProjectService:
    def __init__(
        self,
        store: Store,
        *,
        task_service: Any = None,
    ) -> None:
        self._store = store
        self._task_service = task_service

    async def create(
        self,
        *,
        name: str,
        description: str = "",
        area: str = "",
        status: str = "active",
        priority: str = "medium",
        tags: Iterable[Any] | None = None,
        links: Iterable[Any] | None = None,
        due_date: str | None = None,
    ) -> WorkProject:
        name = str(name or "").strip()
        if not name:
            raise ValueError("name is required")
        status = self._validate_status(status)
        priority = self._validate_priority(priority)
        pid = str(uuid.uuid4())
        ts = _now_iso()

        def _work() -> WorkProject:
            with self._store._connect() as conn:
                conn.execute(
                    "INSERT INTO work_projects"
                    " (id, name, description, area, status, priority, tags,"
                    " links, due_date, created_at, updated_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        pid,
                        name,
                        str(description or ""),
                        str(area or ""),
                        status,
                        priority,
                        _json_list(tags),
                        json.dumps(list(links or []), ensure_ascii=False),
                        due_date or None,
                        ts,
                        ts,
                    ),
                )
                row = conn.execute(
                    f"SELECT {_PROJECT_COLS} FROM work_projects WHERE id = ?",
                    (pid,),
                ).fetchone()
            return WorkProject.from_row(row)

        return await asyncio.to_thread(_work)

    async def list(
        self,
        *,
        status: str | None = None,
        include_archived: bool = False,
        limit: int = 100,
    ) -> list[WorkProject]:
        lim = max(1, min(int(limit), 500))
        where: list[str] = []
        params: list[Any] = []
        if status:
            where.append("status = ?")
            params.append(self._validate_status(status))
        elif not include_archived:
            where.append("status != 'archived'")
        clause = f" WHERE {' AND '.join(where)}" if where else ""

        def _work() -> list[WorkProject]:
            with self._store._connect() as conn:
                rows = conn.execute(
                    f"SELECT {_PROJECT_COLS} FROM work_projects"
                    f"{clause} ORDER BY"
                    " CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,"
                    " COALESCE(due_date, '9999-12-31') ASC,"
                    " updated_at DESC LIMIT ?",
                    (*params, lim),
                ).fetchall()
            return [WorkProject.from_row(row) for row in rows]

        return await asyncio.to_thread(_work)

    async def get(self, project_id: str) -> WorkProject | None:
        def _work() -> WorkProject | None:
            with self._store._connect() as conn:
                row = conn.execute(
                    f"SELECT {_PROJECT_COLS} FROM work_projects WHERE id = ?",
                    (project_id,),
                ).fetchone()
            return WorkProject.from_row(row) if row else None

        return await asyncio.to_thread(_work)

    async def update(self, project_id: str, **fields: Any) -> WorkProject | None:
        sets: list[str] = []
        params: list[Any] = []
        if "name" in fields and fields["name"] is not None:
            name = str(fields["name"]).strip()
            if not name:
                raise ValueError("name cannot be empty")
            sets.append("name = ?")
            params.append(name)
        for key in ("description", "area", "due_date"):
            if key in fields:
                sets.append(f"{key} = ?")
                params.append(fields[key] or None if key == "due_date" else str(fields[key] or ""))
        if "status" in fields and fields["status"] is not None:
            sets.append("status = ?")
            params.append(self._validate_status(fields["status"]))
        if "priority" in fields and fields["priority"] is not None:
            sets.append("priority = ?")
            params.append(self._validate_priority(fields["priority"]))
        if "tags" in fields and fields["tags"] is not None:
            sets.append("tags = ?")
            params.append(_json_list(fields["tags"]))
        if not sets:
            return await self.get(project_id)
        sets.append("updated_at = ?")
        params.extend([_now_iso(), project_id])

        def _work() -> WorkProject | None:
            with self._store._connect() as conn:
                cur = conn.execute(
                    f"UPDATE work_projects SET {', '.join(sets)} WHERE id = ?",
                    params,
                )
                if (cur.rowcount or 0) == 0:
                    return None
                row = conn.execute(
                    f"SELECT {_PROJECT_COLS} FROM work_projects WHERE id = ?",
                    (project_id,),
                ).fetchone()
            return WorkProject.from_row(row) if row else None

        return await asyncio.to_thread(_work)

    async def links(self, project_id: str) -> list[WorkProjectLink]:
        def _work() -> list[WorkProjectLink]:
            with self._store._connect() as conn:
                rows = conn.execute(
                    f"SELECT {_LINK_COLS} FROM work_project_links"
                    " WHERE project_id = ? ORDER BY created_at DESC",
                    (project_id,),
                ).fetchall()
            return [WorkProjectLink.from_row(row) for row in rows]

        return await asyncio.to_thread(_work)

    async def add_link(
        self,
        project_id: str,
        *,
        target_type: str,
        target_id: str,
        title: str = "",
        metadata: dict[str, Any] | None = None,
    ) -> WorkProjectLink | None:
        target_type = str(target_type or "").strip()
        if target_type not in _LINK_TYPES:
            raise ValueError(f"invalid target_type: {target_type}")
        target_id = str(target_id or "").strip()
        if not target_id:
            raise ValueError("target_id is required")
        link_id = str(uuid.uuid4())
        ts = _now_iso()

        def _work() -> WorkProjectLink | None:
            with self._store._connect() as conn:
                exists = conn.execute(
                    "SELECT 1 FROM work_projects WHERE id = ?",
                    (project_id,),
                ).fetchone()
                if not exists:
                    return None
                conn.execute(
                    "INSERT OR REPLACE INTO work_project_links"
                    " (id, project_id, target_type, target_id, title, metadata, created_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (
                        link_id,
                        project_id,
                        target_type,
                        target_id,
                        str(title or ""),
                        _json_obj(metadata),
                        ts,
                    ),
                )
                conn.execute(
                    "UPDATE work_projects SET updated_at = ? WHERE id = ?",
                    (ts, project_id),
                )
                row = conn.execute(
                    f"SELECT {_LINK_COLS} FROM work_project_links WHERE id = ?",
                    (link_id,),
                ).fetchone()
            return WorkProjectLink.from_row(row) if row else None

        return await asyncio.to_thread(_work)

    async def remove_link(self, project_id: str, link_id: str) -> bool:
        def _work() -> int:
            with self._store._connect() as conn:
                cur = conn.execute(
                    "DELETE FROM work_project_links WHERE project_id = ? AND id = ?",
                    (project_id, link_id),
                )
                if cur.rowcount:
                    conn.execute(
                        "UPDATE work_projects SET updated_at = ? WHERE id = ?",
                        (_now_iso(), project_id),
                    )
                return cur.rowcount or 0

        return await asyncio.to_thread(_work) > 0

    async def detail(self, project_id: str) -> dict[str, Any] | None:
        project = await self.get(project_id)
        if project is None:
            return None
        links = await self.links(project_id)
        summary = {
            "linked_tasks": sum(1 for link in links if link.target_type == "task"),
            "linked_triages": sum(1 for link in links if link.target_type == "cv_triage"),
            "linked_notes": sum(1 for link in links if link.target_type == "note"),
            "overdue": bool(project.due_date and project.due_date < _today_iso()),
            "attention": project.priority == "high" or project.status == "paused",
        }
        return {
            "project": project.to_dict(),
            "links": [link.to_dict() for link in links],
            "summary": summary,
        }

    async def briefing(
        self,
        *,
        cv_jobs: Iterable[Any] | None = None,
    ) -> dict[str, Any]:
        projects = await self.list(status=None, include_archived=False, limit=80)
        active = [p for p in projects if p.status == "active"]
        today = _today_iso()
        due = [
            p for p in active
            if p.due_date and p.due_date <= today
        ]
        tasks = await self._open_tasks()
        active_triages: list[dict[str, Any]] = []
        for job in list(cv_jobs or []):
            data = job if isinstance(job, dict) else getattr(job, "to_dict", lambda: {})()
            if data.get("status") not in {"done", "failed", "cancelled"}:
                active_triages.append(data)
        return {
            "projects": [p.to_dict() for p in active],
            "open_tasks": tasks[:20],
            "active_triages": active_triages[:20],
            "due_projects": [p.to_dict() for p in due],
        }

    async def _open_tasks(self) -> list[dict[str, Any]]:
        if self._task_service is None:
            return []
        try:
            tasks = await self._task_service.list_tasks(limit=120)
        except TypeError:
            tasks = await self._task_service.list_tasks()
        except Exception:
            return []
        out: list[dict[str, Any]] = []
        for task in tasks:
            data = task if isinstance(task, dict) else getattr(task, "to_dict", lambda: {})()
            if data.get("status") in {"completed", "rejected", "failed"}:
                continue
            out.append(data)
        return out

    @staticmethod
    def _validate_status(status: Any) -> str:
        value = str(status or "active").strip()
        if value not in _STATUSES:
            raise ValueError(f"invalid status: {value}")
        return value

    @staticmethod
    def _validate_priority(priority: Any) -> str:
        value = str(priority or "medium").strip()
        if value == "med":
            value = "medium"
        if value not in _PRIORITIES:
            raise ValueError(f"invalid priority: {value}")
        return value
