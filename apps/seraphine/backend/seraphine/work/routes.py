"""Work projects HTTP API."""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from seraphine.work.service import WorkProjectService

router = APIRouter(prefix="/work", tags=["work"])


class CreateProjectBody(BaseModel):
    name: str = Field(min_length=1, max_length=240)
    description: str | None = None
    area: str | None = None
    priority: str = "medium"
    tags: list[str] | None = None
    due_date: str | None = None

    model_config = {"extra": "forbid"}


class PatchProjectBody(BaseModel):
    name: str | None = None
    description: str | None = None
    area: str | None = None
    status: str | None = None
    priority: str | None = None
    tags: list[str] | None = None
    due_date: str | None = None

    model_config = {"extra": "forbid"}


class LinkBody(BaseModel):
    target_type: str
    target_id: str
    title: str | None = None
    metadata: dict[str, Any] | None = None

    model_config = {"extra": "forbid"}


def _service_or_503(request: Request) -> WorkProjectService:
    svc: Optional[WorkProjectService] = getattr(
        request.app.state, "work_service", None,
    )
    if svc is None:
        raise HTTPException(status_code=503, detail="work service not configured")
    return svc


@router.get("/projects")
async def list_projects(
    request: Request,
    status: str | None = None,
    include_archived: bool = False,
    limit: int = 100,
) -> dict[str, Any]:
    svc = _service_or_503(request)
    try:
        projects = await svc.list(
            status=status,
            include_archived=include_archived,
            limit=limit,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return {"projects": [project.to_dict() for project in projects]}


@router.post("/projects")
async def create_project(
    request: Request,
    body: CreateProjectBody,
) -> dict[str, Any]:
    svc = _service_or_503(request)
    try:
        project = await svc.create(
            name=body.name,
            description=body.description or "",
            area=body.area or "",
            priority=body.priority,
            tags=body.tags,
            due_date=body.due_date,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return {"project": project.to_dict()}


@router.get("/projects/{project_id}")
async def get_project(request: Request, project_id: str) -> dict[str, Any]:
    svc = _service_or_503(request)
    detail = await svc.detail(project_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="project not found")
    return detail


@router.patch("/projects/{project_id}")
async def patch_project(
    request: Request,
    project_id: str,
    body: PatchProjectBody,
) -> dict[str, Any]:
    svc = _service_or_503(request)
    try:
        project = await svc.update(project_id, **body.model_dump(exclude_unset=True))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    return {"project": project.to_dict()}


@router.post("/projects/{project_id}/links")
async def add_project_link(
    request: Request,
    project_id: str,
    body: LinkBody,
) -> dict[str, Any]:
    svc = _service_or_503(request)
    try:
        link = await svc.add_link(
            project_id,
            target_type=body.target_type,
            target_id=body.target_id,
            title=body.title or "",
            metadata=body.metadata,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    if link is None:
        raise HTTPException(status_code=404, detail="project not found")
    return {"link": link.to_dict()}


@router.delete("/projects/{project_id}/links/{link_id}")
async def remove_project_link(
    request: Request,
    project_id: str,
    link_id: str,
) -> dict[str, bool]:
    svc = _service_or_503(request)
    ok = await svc.remove_link(project_id, link_id)
    if not ok:
        raise HTTPException(status_code=404, detail="link not found")
    return {"ok": True}


@router.get("/briefing")
async def work_briefing(request: Request) -> dict[str, Any]:
    svc = _service_or_503(request)
    cv_jobs = await _read_cv_jobs(request)
    return await svc.briefing(cv_jobs=cv_jobs)


@router.get("/autopilot")
async def work_autopilot(request: Request) -> dict[str, Any]:
    svc = _service_or_503(request)
    cv_jobs = await _read_cv_jobs(request)
    return await svc.autopilot(cv_jobs=cv_jobs)


async def _read_cv_jobs(request: Request) -> list[Any]:
    cv_jobs: list[Any] = []
    store = getattr(request.app.state, "store", None)
    if store is not None:
        try:
            from seraphine.cv_triage.storage import list_jobs

            def _read_jobs() -> list[Any]:
                with store._connect() as conn:
                    return [
                        {
                            "id": job.id,
                            "status": job.status.value,
                            "target_label": job.target_label,
                            "total_cvs": job.total_cvs,
                            "processed_cvs": job.processed_cvs,
                            "created_at": job.created_at,
                        }
                        for job in list_jobs(conn, limit=50)
                    ]

            import asyncio

            cv_jobs = await asyncio.to_thread(_read_jobs)
        except Exception:
            cv_jobs = []
    return cv_jobs
