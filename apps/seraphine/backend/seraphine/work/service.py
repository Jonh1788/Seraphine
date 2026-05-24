"""WorkProjectService -- projects, links and briefing helpers."""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime, timedelta, timezone
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


def _iso_in_hours(hours: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(hours=hours)).isoformat()


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

    async def auto_link_item(
        self,
        *,
        target_type: str,
        target_id: str,
        title: str,
        text: str = "",
        metadata: dict[str, Any] | None = None,
    ) -> WorkProjectLink | None:
        """Best-effort link of a new item to the most likely active project."""
        haystack = f"{title} {text}".lower()
        if not haystack.strip():
            return None
        projects = await self.list(status="active", limit=100)
        scored: list[tuple[int, WorkProject]] = []
        for project in projects:
            terms = [project.name, project.area, *project.tags]
            score = 0
            for term in terms:
                clean = str(term or "").strip().lower()
                if len(clean) < 3:
                    continue
                if clean in haystack:
                    score += 3 if clean == project.name.lower() else 1
                else:
                    for part in clean.replace("-", " ").replace("_", " ").split():
                        if len(part) >= 4 and part in haystack:
                            score += 1
            if score > 0:
                scored.append((score, project))
        if not scored:
            return None
        scored.sort(key=lambda item: item[0], reverse=True)
        project = scored[0][1]
        return await self.add_link(
            project.id,
            target_type=target_type,
            target_id=target_id,
            title=title,
            metadata={**(metadata or {}), "auto_linked": True, "score": scored[0][0]},
        )

    async def autopilot(
        self,
        *,
        cv_jobs: Iterable[Any] | None = None,
    ) -> dict[str, Any]:
        projects = await self.list(include_archived=False, limit=100)
        today = _today_iso()
        ignored = await self._suppressed_suggestions()
        suggestions: list[dict[str, Any]] = []
        for project in projects:
            if project.status != "active":
                continue
            links = await self.links(project.id)
            task_links = [link for link in links if link.target_type == "task"]
            if not task_links:
                suggestion = {
                    "id": f"project-no-task-{project.id}",
                    "kind": "project_next_action",
                    "severity": "high" if project.priority == "high" else "medium",
                    "project_id": project.id,
                    "title": f"Definir proxima acao para {project.name}",
                    "detail": "Projeto ativo sem tarefa vinculada.",
                    "action_label": "Criar tarefa",
                }
                if suggestion["id"] not in ignored:
                    suggestions.append(suggestion)
            if project.due_date and project.due_date < today:
                suggestion = {
                    "id": f"project-overdue-{project.id}",
                    "kind": "project_overdue",
                    "severity": "high",
                    "project_id": project.id,
                    "title": f"Revisar prazo de {project.name}",
                    "detail": f"Prazo venceu em {project.due_date}.",
                    "action_label": "Replanejar",
                }
                if suggestion["id"] not in ignored:
                    suggestions.append(suggestion)
            if project.priority == "high" and not project.due_date:
                suggestion = {
                    "id": f"project-high-no-date-{project.id}",
                    "kind": "project_missing_due_date",
                    "severity": "medium",
                    "project_id": project.id,
                    "title": f"Dar prazo para {project.name}",
                    "detail": "Projeto de alta prioridade sem prazo definido.",
                    "action_label": "Definir prazo",
                }
                if suggestion["id"] not in ignored:
                    suggestions.append(suggestion)

        linked_triages = await self._linked_target_ids("cv_triage")
        for job in list(cv_jobs or []):
            data = job if isinstance(job, dict) else getattr(job, "to_dict", lambda: {})()
            job_id = str(data.get("id") or "")
            if not job_id or job_id in linked_triages:
                continue
            if data.get("status") in {"done", "failed", "cancelled"}:
                continue
            suggestion = {
                "id": f"triage-unlinked-{job_id}",
                "kind": "triage_unlinked",
                "severity": "medium",
                "target_type": "cv_triage",
                "target_id": job_id,
                "title": f"Vincular triagem {data.get('target_label') or job_id}",
                "detail": "Triagem em andamento ainda nao esta ligada a um projeto.",
                "action_label": "Vincular",
            }
            if suggestion["id"] not in ignored:
                suggestions.append(suggestion)

        order = {"high": 0, "medium": 1, "low": 2}
        suggestions.sort(key=lambda item: order.get(str(item.get("severity")), 9))
        return {"suggestions": suggestions[:30]}

    async def apply_suggestion(self, suggestion_id: str) -> dict[str, Any]:
        if suggestion_id.startswith("project-no-task-"):
            project_id = suggestion_id.removeprefix("project-no-task-")
            project = await self.get(project_id)
            if project is None:
                raise ValueError("project not found")
            task_id = await self._create_linked_task(
                project,
                title=f"Definir proxima acao: {project.name}",
                description="Criada pelo autopilot de trabalho.",
            )
            await self._record_autopilot_action(suggestion_id, "applied")
            return {"ok": True, "created_task_id": task_id, "project": project.to_dict()}
        if suggestion_id.startswith("project-overdue-"):
            project_id = suggestion_id.removeprefix("project-overdue-")
            project = await self.get(project_id)
            if project is None:
                raise ValueError("project not found")
            task_id = await self._create_linked_task(
                project,
                title=f"Replanejar prazo: {project.name}",
                description=f"Projeto venceu em {project.due_date}.",
                priority="high",
            )
            await self._record_autopilot_action(suggestion_id, "applied")
            return {"ok": True, "created_task_id": task_id, "project": project.to_dict()}
        if suggestion_id.startswith("project-high-no-date-"):
            project_id = suggestion_id.removeprefix("project-high-no-date-")
            project = await self.get(project_id)
            if project is None:
                raise ValueError("project not found")
            task_id = await self._create_linked_task(
                project,
                title=f"Definir prazo: {project.name}",
                description="Projeto de alta prioridade sem prazo definido.",
                priority="high",
            )
            await self._record_autopilot_action(suggestion_id, "applied")
            return {"ok": True, "created_task_id": task_id, "project": project.to_dict()}
        if suggestion_id.startswith("triage-unlinked-"):
            await self._record_autopilot_action(suggestion_id, "applied")
            return {
                "ok": True,
                "message": "Abra Trabalhos para vincular a triagem ao projeto correto.",
            }
        raise ValueError("unknown suggestion")

    async def dismiss_suggestion(self, suggestion_id: str) -> dict[str, bool]:
        await self._record_autopilot_action(suggestion_id, "dismissed")
        return {"ok": True}

    async def snooze_suggestion(self, suggestion_id: str, *, hours: int = 24) -> dict[str, Any]:
        until = _iso_in_hours(max(1, min(int(hours), 24 * 14)))
        await self._record_autopilot_action(suggestion_id, "snoozed", snooze_until=until)
        return {"ok": True, "snooze_until": until}

    async def capture(
        self,
        text: str,
        *,
        due_date: str | None = None,
        due_time: str | None = None,
        priority: str | None = None,
    ) -> dict[str, Any]:
        clean = str(text or "").strip()
        if not clean:
            raise ValueError("text is required")
        lower = clean.lower()
        if lower.startswith(("projeto:", "projeto ")):
            name = clean.split(":", 1)[1].strip() if ":" in clean else clean[8:].strip()
            project = await self.create(name=name or clean, description=clean, tags=["captura"])
            return {"kind": "project", "project": project.to_dict()}
        task_markers = ("preciso ", "tenho que ", "lembrar ", "me lembra", "fazer ", "enviar ", "pagar ", "ligar ")
        if any(marker in lower for marker in task_markers):
            if self._task_service is None:
                raise ValueError("task service not configured")
            task_id = await self._task_service.create_task(
                type="generic",
                title=clean[:180],
                description="Captura inteligente.",
                source="quick_capture",
                payload={"raw": clean},
                due_date=due_date,
                due_time=due_time,
                priority=priority,
            )
            link = await self.auto_link_item(
                target_type="task",
                target_id=str(task_id),
                title=clean,
                text=clean,
                metadata={"source": "capture"},
            )
            return {
                "kind": "task",
                "task_id": task_id,
                "work_link": link.to_dict() if link else None,
            }
        note = await self._create_note_from_capture(clean)
        link = await self.auto_link_item(
            target_type="note",
            target_id=note["id"],
            title=note["title"],
            text=clean,
            metadata={"source": "capture"},
        )
        return {"kind": "note", "note": note, "work_link": link.to_dict() if link else None}

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
        items = await self._hydrate_links(links)
        return {
            "project": project.to_dict(),
            "links": [link.to_dict() for link in links],
            "items": items,
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

    async def _linked_target_ids(self, target_type: str) -> set[str]:
        def _work() -> set[str]:
            with self._store._connect() as conn:
                rows = conn.execute(
                    "SELECT target_id FROM work_project_links WHERE target_type = ?",
                    (target_type,),
                ).fetchall()
            return {str(row[0]) for row in rows}

        return await asyncio.to_thread(_work)

    async def _create_linked_task(
        self,
        project: WorkProject,
        *,
        title: str,
        description: str,
        priority: str | None = None,
    ) -> int:
        if self._task_service is None:
            raise ValueError("task service not configured")
        task_id = await self._task_service.create_task(
            type="generic",
            title=title,
            description=description,
            source="work_autopilot",
            payload={"project_id": project.id},
            priority=priority or ("high" if project.priority == "high" else None),
            tags=[project.area, *project.tags] if project.area else project.tags,
        )
        await self.add_link(
            project.id,
            target_type="task",
            target_id=str(task_id),
            title=title,
            metadata={"source": "work_autopilot"},
        )
        return int(task_id)

    async def _record_autopilot_action(
        self,
        suggestion_id: str,
        action: str,
        *,
        snooze_until: str | None = None,
    ) -> None:
        def _work() -> None:
            with self._store._connect() as conn:
                conn.execute(
                    "INSERT INTO work_autopilot_actions"
                    " (suggestion_id, action, created_at, snooze_until)"
                    " VALUES (?, ?, ?, ?)"
                    " ON CONFLICT(suggestion_id) DO UPDATE SET"
                    " action = excluded.action,"
                    " created_at = excluded.created_at,"
                    " snooze_until = excluded.snooze_until",
                    (suggestion_id, action, _now_iso(), snooze_until),
                )

        await asyncio.to_thread(_work)

    async def _suppressed_suggestions(self) -> set[str]:
        now = datetime.now(timezone.utc).isoformat()

        def _work() -> set[str]:
            with self._store._connect() as conn:
                rows = conn.execute(
                    "SELECT suggestion_id, action, snooze_until"
                    " FROM work_autopilot_actions"
                ).fetchall()
            out: set[str] = set()
            for suggestion_id, action, snooze_until in rows:
                if action in {"applied", "dismissed"}:
                    out.add(str(suggestion_id))
                elif action == "snoozed" and snooze_until and str(snooze_until) > now:
                    out.add(str(suggestion_id))
            return out

        return await asyncio.to_thread(_work)

    async def _hydrate_links(self, links: list[WorkProjectLink]) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        for link in links:
            data: dict[str, Any] | None = None
            if link.target_type == "task" and self._task_service is not None:
                try:
                    task = await self._task_service.get_task(int(link.target_id))
                    data = task.to_dict() if hasattr(task, "to_dict") else None
                    if data is None and task is not None:
                        import dataclasses
                        data = dataclasses.asdict(task)
                except Exception:
                    data = None
            elif link.target_type == "note":
                data = await self._read_note(link.target_id)
            elif link.target_type == "cv_triage":
                data = await self._read_cv_job(link.target_id)
            items.append({
                "link": link.to_dict(),
                "target_type": link.target_type,
                "target_id": link.target_id,
                "title": link.title,
                "data": data,
            })
        return items

    async def today(self, *, cv_jobs: Iterable[Any] | None = None) -> dict[str, Any]:
        briefing = await self.briefing(cv_jobs=cv_jobs)
        autopilot = await self.autopilot(cv_jobs=cv_jobs)
        projects = briefing.get("projects", [])
        due_projects = briefing.get("due_projects", [])
        open_tasks = briefing.get("open_tasks", [])
        active_triages = briefing.get("active_triages", [])
        top_project = projects[0] if projects else None
        top_task = open_tasks[0] if open_tasks else None
        top_decision = (autopilot.get("suggestions") or [None])[0]
        return {
            "top_project": top_project,
            "risk_project": due_projects[0] if due_projects else None,
            "next_task": top_task,
            "next_decision": top_decision,
            "counts": {
                "projects": len(projects),
                "open_tasks": len(open_tasks),
                "active_triages": len(active_triages),
                "decisions": len(autopilot.get("suggestions") or []),
            },
        }

    async def _read_note(self, note_id: str) -> dict[str, Any] | None:
        def _work() -> dict[str, Any] | None:
            with self._store._connect() as conn:
                row = conn.execute(
                    "SELECT id, title, content, tags, created_at, updated_at"
                    " FROM notes WHERE id = ?",
                    (note_id,),
                ).fetchone()
            if not row:
                return None
            try:
                tags = json.loads(row[3] or "[]")
            except Exception:
                tags = []
            return {
                "id": row[0],
                "title": row[1],
                "content": row[2],
                "tags": tags,
                "created_at": row[4],
                "updated_at": row[5],
            }

        return await asyncio.to_thread(_work)

    async def _read_cv_job(self, job_id: str) -> dict[str, Any] | None:
        def _work() -> dict[str, Any] | None:
            with self._store._connect() as conn:
                row = conn.execute(
                    "SELECT id, status, target_label, total_cvs, processed_cvs,"
                    " created_at, finished_at FROM cv_triage_jobs WHERE id = ?",
                    (job_id,),
                ).fetchone()
            if not row:
                return None
            return {
                "id": row[0],
                "status": row[1],
                "target_label": row[2],
                "total_cvs": row[3],
                "processed_cvs": row[4],
                "created_at": row[5],
                "finished_at": row[6],
            }

        return await asyncio.to_thread(_work)

    async def _create_note_from_capture(self, text: str) -> dict[str, Any]:
        note_id = str(uuid.uuid4())
        ts = _now_iso()
        title = text.splitlines()[0][:120] or "Captura"

        def _work() -> dict[str, Any]:
            with self._store._connect() as conn:
                conn.execute(
                    "INSERT INTO notes(id, title, content, tags, created_at, updated_at)"
                    " VALUES (?, ?, ?, ?, ?, ?)",
                    (note_id, title, text, json.dumps(["captura"], ensure_ascii=False), ts, ts),
                )
            return {
                "id": note_id,
                "title": title,
                "content": text,
                "tags": ["captura"],
                "created_at": ts,
                "updated_at": ts,
            }

        return await asyncio.to_thread(_work)

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
