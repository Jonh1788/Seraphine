"""Chat tools for work projects."""

from __future__ import annotations

import logging
from typing import Any

from seraphine.tools.base import Tool, ToolResult
from seraphine.tools.cards import text as _esc
from seraphine.tools.svg_icons import CLIPBOARD
from seraphine.work.service import WorkProjectService

logger = logging.getLogger(__name__)


def _project_card(project: dict[str, Any], subtitle: str = "Projeto de trabalho") -> str:
    name = str(project.get("name") or "Projeto")
    priority = str(project.get("priority") or "medium")
    area = str(project.get("area") or "Trabalho")
    due = str(project.get("due_date") or "sem prazo")
    return (
        '<!--card--><div class="rich-card rich-card--work work-chat-card">'
        '<div class="rich-card__header">'
        f'<div class="rich-card__icon rich-card__icon--work">{CLIPBOARD}</div>'
        '<div>'
        f'<div class="rich-card__title">{_esc(name)}</div>'
        f'<div class="rich-card__subtitle">{_esc(subtitle)}</div>'
        '</div></div>'
        '<div class="rich-card__details">'
        f'<div class="rich-card__detail"><span>Area</span><strong>{_esc(area)}</strong></div>'
        f'<div class="rich-card__detail"><span>Prioridade</span><strong>{_esc(priority)}</strong></div>'
        f'<div class="rich-card__detail"><span>Prazo</span><strong>{_esc(due)}</strong></div>'
        '</div></div><!--/card-->'
    )


class CreateWorkProjectTool(Tool):
    name = "create_work_project"
    description = (
        "Create a work project for an ongoing initiative, delivery, client, "
        "research effort or operational workstream. Use when the user asks "
        "to start, track, organize or planejar um trabalho/projeto."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "name": {"type": "string"},
            "description": {"type": "string"},
            "area": {"type": "string"},
            "priority": {"type": "string", "enum": ["low", "medium", "high"]},
            "tags": {"type": "array", "items": {"type": "string"}},
            "due_date": {"type": "string", "description": "YYYY-MM-DD, optional"},
        },
        "required": ["name"],
    }
    requires_confirmation = False
    category = "other"

    def __init__(self, work_service: WorkProjectService) -> None:
        self._svc = work_service

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        try:
            project = await self._svc.create(
                name=str(args.get("name") or ""),
                description=str(args.get("description") or ""),
                area=str(args.get("area") or ""),
                priority=str(args.get("priority") or "medium"),
                tags=args.get("tags") if isinstance(args.get("tags"), list) else None,
                due_date=args.get("due_date") or None,
            )
        except ValueError as exc:
            return ToolResult(ok=False, error=str(exc))
        except Exception as exc:
            logger.exception("create_work_project failed")
            return ToolResult(ok=False, error=str(exc))
        return ToolResult(
            ok=True,
            output=f"Projeto criado: {project.name}.",
            metadata={
                "project": project.to_dict(),
                "html_card": _project_card(project.to_dict(), "Projeto criado"),
            },
        )


class ListWorkProjectsTool(Tool):
    name = "list_work_projects"
    description = (
        "List active work projects. Use when the user asks what projects, "
        "trabalhos, frentes, entregas or iniciativas are open."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "status": {
                "type": "string",
                "enum": ["active", "paused", "done", "archived"],
            },
            "limit": {"type": "integer", "minimum": 1, "maximum": 100},
        },
    }
    requires_confirmation = False
    category = "other"

    def __init__(self, work_service: WorkProjectService) -> None:
        self._svc = work_service

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        try:
            projects = await self._svc.list(
                status=args.get("status") or None,
                limit=int(args.get("limit") or 20),
            )
        except Exception as exc:
            logger.exception("list_work_projects failed")
            return ToolResult(ok=False, error=str(exc))
        return ToolResult(
            ok=True,
            output=f"{len(projects)} projeto(s) encontrado(s).",
            metadata={
                "projects": [project.to_dict() for project in projects],
                "project": projects[0].to_dict() if projects else None,
                "html_card": _project_card(projects[0].to_dict(), "Projeto ativo") if projects else None,
            },
        )


class LinkWorkProjectTool(Tool):
    name = "link_work_project_item"
    description = (
        "Link a task, note, CV triage job, URL, memory or file to an existing "
        "work project. The project id must come from list_work_projects or "
        "create_work_project."
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "project_id": {"type": "string"},
            "target_type": {
                "type": "string",
                "enum": ["task", "note", "cv_triage", "url", "memory", "file", "other"],
            },
            "target_id": {"type": "string"},
            "title": {"type": "string"},
            "metadata": {"type": "object"},
        },
        "required": ["project_id", "target_type", "target_id"],
    }
    requires_confirmation = False
    category = "other"

    def __init__(self, work_service: WorkProjectService) -> None:
        self._svc = work_service

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        try:
            link = await self._svc.add_link(
                str(args.get("project_id") or ""),
                target_type=str(args.get("target_type") or ""),
                target_id=str(args.get("target_id") or ""),
                title=str(args.get("title") or ""),
                metadata=args.get("metadata") if isinstance(args.get("metadata"), dict) else None,
            )
        except ValueError as exc:
            return ToolResult(ok=False, error=str(exc))
        except Exception as exc:
            logger.exception("link_work_project_item failed")
            return ToolResult(ok=False, error=str(exc))
        if link is None:
            return ToolResult(ok=False, error="project not found")
        return ToolResult(
            ok=True,
            output="Item vinculado ao projeto.",
            metadata={"link": link.to_dict()},
        )
