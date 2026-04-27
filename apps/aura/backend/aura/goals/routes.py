"""Goals routes."""

from __future__ import annotations

from dataclasses import asdict

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from mod_tasks.routes import get_current_user_id

from aura.goals.service import ALLOWED_KIND, ALLOWED_STATUS, GoalsService

router = APIRouter(prefix="/goals", tags=["goals"])


def _service_or_503(request: Request) -> GoalsService:
    svc = getattr(request.app.state, "goals_service", None)
    if svc is None:
        raise HTTPException(status_code=503, detail="goals service não configurado")
    return svc


def _require_user(user_id: str | None) -> str:
    if user_id is None:
        raise HTTPException(status_code=401, detail="autenticação requerida")
    return user_id


class CreateGoalBody(BaseModel):
    title: str = Field(..., min_length=1, max_length=160)
    description: str | None = Field(None, max_length=600)
    kind: str = Field("general")
    target_value: float | None = None
    unit: str | None = Field(None, max_length=20)
    deadline: str | None = None


class UpdateGoalBody(BaseModel):
    title: str | None = Field(None, min_length=1, max_length=160)
    description: str | None = Field(None, max_length=600)
    kind: str | None = None
    target_value: float | None = None
    current_value: float | None = None
    unit: str | None = Field(None, max_length=20)
    deadline: str | None = None
    status: str | None = None


@router.get("/overview")
async def get_overview(
    request: Request,
    user_id: str | None = Depends(get_current_user_id),
) -> dict:
    uid = _require_user(user_id)
    svc = _service_or_503(request)
    return await svc.overview(uid)


@router.get("")
async def list_goals(
    request: Request,
    kind: str | None = None,
    include_archived: bool = False,
    user_id: str | None = Depends(get_current_user_id),
) -> dict:
    uid = _require_user(user_id)
    svc = _service_or_503(request)
    items = await svc.list_for_user(uid, kind=kind, include_archived=include_archived)
    return {"goals": [asdict(g) for g in items]}


@router.post("")
async def create_goal(
    body: CreateGoalBody,
    request: Request,
    user_id: str | None = Depends(get_current_user_id),
) -> dict:
    uid = _require_user(user_id)
    svc = _service_or_503(request)
    if body.kind not in ALLOWED_KIND:
        raise HTTPException(status_code=422, detail=f"kind inválido: {body.kind}")
    g = await svc.create(
        user_id=uid,
        title=body.title,
        description=body.description,
        kind=body.kind,
        target_value=body.target_value,
        unit=body.unit,
        deadline=body.deadline,
    )
    return asdict(g)


@router.patch("/{goal_id}")
async def update_goal(
    goal_id: str,
    body: UpdateGoalBody,
    request: Request,
    user_id: str | None = Depends(get_current_user_id),
) -> dict:
    uid = _require_user(user_id)
    svc = _service_or_503(request)
    if body.kind is not None and body.kind not in ALLOWED_KIND:
        raise HTTPException(status_code=422, detail=f"kind inválido: {body.kind}")
    if body.status is not None and body.status not in ALLOWED_STATUS:
        raise HTTPException(status_code=422, detail=f"status inválido: {body.status}")
    g = await svc.update(
        goal_id, uid,
        title=body.title, description=body.description, kind=body.kind,
        target_value=body.target_value, current_value=body.current_value,
        unit=body.unit, deadline=body.deadline, status=body.status,
    )
    if g is None:
        raise HTTPException(status_code=404, detail="meta não encontrada")
    return asdict(g)


@router.delete("/{goal_id}")
async def delete_goal(
    goal_id: str,
    request: Request,
    user_id: str | None = Depends(get_current_user_id),
) -> dict:
    uid = _require_user(user_id)
    svc = _service_or_503(request)
    n = await svc.delete(goal_id, uid)
    if n == 0:
        raise HTTPException(status_code=404, detail="meta não encontrada")
    return {"ok": True}
