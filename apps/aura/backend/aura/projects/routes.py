"""Projects routes."""

from __future__ import annotations

from dataclasses import asdict

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from mod_tasks.routes import get_current_user_id

from aura.projects.service import ALLOWED_STATUS, ProjectsService

router = APIRouter(prefix="/projects", tags=["projects"])


def _service_or_503(request: Request) -> ProjectsService:
    svc = getattr(request.app.state, "projects_service", None)
    if svc is None:
        raise HTTPException(status_code=503, detail="projects service não configurado")
    return svc


def _require_user(user_id: str | None) -> str:
    if user_id is None:
        raise HTTPException(status_code=401, detail="autenticação requerida")
    return user_id


class CreateProjectBody(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    description: str | None = Field(None, max_length=600)
    color: str = Field("blue", max_length=20)
    status: str = Field("active")
    target_date: str | None = None


class UpdateProjectBody(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=120)
    description: str | None = Field(None, max_length=600)
    color: str | None = Field(None, max_length=20)
    status: str | None = None
    target_date: str | None = None
    progress: int | None = Field(None, ge=0, le=100)


@router.get("/overview")
async def get_overview(
    request: Request,
    user_id: str | None = Depends(get_current_user_id),
) -> dict:
    uid = _require_user(user_id)
    svc = _service_or_503(request)
    return await svc.overview(uid)


@router.get("")
async def list_projects(
    request: Request,
    include_archived: bool = False,
    user_id: str | None = Depends(get_current_user_id),
) -> dict:
    uid = _require_user(user_id)
    svc = _service_or_503(request)
    items = await svc.list_for_user(uid, include_archived=include_archived)
    return {"projects": [asdict(p) for p in items]}


@router.get("/{project_id}")
async def get_project(
    project_id: str,
    request: Request,
    user_id: str | None = Depends(get_current_user_id),
) -> dict:
    uid = _require_user(user_id)
    svc = _service_or_503(request)
    p = await svc.get(project_id, uid)
    if p is None:
        raise HTTPException(status_code=404, detail="projeto não encontrado")
    return asdict(p)


@router.post("")
async def create_project(
    body: CreateProjectBody,
    request: Request,
    user_id: str | None = Depends(get_current_user_id),
) -> dict:
    uid = _require_user(user_id)
    svc = _service_or_503(request)
    if body.status not in ALLOWED_STATUS:
        raise HTTPException(status_code=422, detail=f"status inválido: {body.status}")
    p = await svc.create(
        user_id=uid,
        name=body.name,
        description=body.description,
        color=body.color,
        status=body.status,
        target_date=body.target_date,
    )
    return asdict(p)


@router.patch("/{project_id}")
async def update_project(
    project_id: str,
    body: UpdateProjectBody,
    request: Request,
    user_id: str | None = Depends(get_current_user_id),
) -> dict:
    uid = _require_user(user_id)
    svc = _service_or_503(request)
    if body.status is not None and body.status not in ALLOWED_STATUS:
        raise HTTPException(status_code=422, detail=f"status inválido: {body.status}")
    p = await svc.update(
        project_id, uid,
        name=body.name,
        description=body.description,
        color=body.color,
        status=body.status,
        target_date=body.target_date,
        progress=body.progress,
    )
    if p is None:
        raise HTTPException(status_code=404, detail="projeto não encontrado")
    return asdict(p)


@router.delete("/{project_id}")
async def delete_project(
    project_id: str,
    request: Request,
    user_id: str | None = Depends(get_current_user_id),
) -> dict:
    uid = _require_user(user_id)
    svc = _service_or_503(request)
    n = await svc.delete(project_id, uid)
    if n == 0:
        raise HTTPException(status_code=404, detail="projeto não encontrado")
    return {"ok": True}
