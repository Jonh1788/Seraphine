"""Knowledge routes — notebooks + notes + search."""

from __future__ import annotations

from dataclasses import asdict

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from mod_tasks.routes import get_current_user_id

from aura.knowledge.service import KnowledgeService

router = APIRouter(prefix="/knowledge", tags=["knowledge"])


def _service_or_503(request: Request) -> KnowledgeService:
    svc = getattr(request.app.state, "knowledge_service", None)
    if svc is None:
        raise HTTPException(status_code=503, detail="knowledge service não configurado")
    return svc


def _require_user(user_id: str | None) -> str:
    if user_id is None:
        raise HTTPException(status_code=401, detail="autenticação requerida")
    return user_id


class CreateNotebookBody(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    color: str = Field("chat", max_length=20)


class RenameNotebookBody(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)


class CreateNoteBody(BaseModel):
    notebook_id: str
    title: str | None = Field(None, max_length=200)
    content_md: str = ""


class UpdateNoteBody(BaseModel):
    title: str | None = Field(None, max_length=200)
    content_md: str | None = None


@router.get("/notebooks")
async def list_notebooks(
    request: Request,
    user_id: str | None = Depends(get_current_user_id),
) -> dict:
    uid = _require_user(user_id)
    svc = _service_or_503(request)
    nbs = await svc.list_notebooks(uid)
    return {"notebooks": [asdict(nb) for nb in nbs]}


@router.post("/notebooks")
async def create_notebook(
    body: CreateNotebookBody,
    request: Request,
    user_id: str | None = Depends(get_current_user_id),
) -> dict:
    uid = _require_user(user_id)
    svc = _service_or_503(request)
    nb = await svc.create_notebook(user_id=uid, name=body.name, color=body.color)
    return asdict(nb)


@router.patch("/notebooks/{notebook_id}")
async def rename_notebook(
    notebook_id: str,
    body: RenameNotebookBody,
    request: Request,
    user_id: str | None = Depends(get_current_user_id),
) -> dict:
    uid = _require_user(user_id)
    svc = _service_or_503(request)
    nb = await svc.rename_notebook(notebook_id, uid, name=body.name)
    if nb is None:
        raise HTTPException(status_code=404, detail="caderno não encontrado")
    return asdict(nb)


@router.delete("/notebooks/{notebook_id}")
async def delete_notebook(
    notebook_id: str,
    request: Request,
    user_id: str | None = Depends(get_current_user_id),
) -> dict:
    uid = _require_user(user_id)
    svc = _service_or_503(request)
    rows = await svc.delete_notebook(notebook_id, uid)
    if rows == 0:
        raise HTTPException(status_code=404, detail="caderno não encontrado")
    return {"ok": True}


@router.get("/notebooks/{notebook_id}/notes")
async def list_notes(
    notebook_id: str,
    request: Request,
    user_id: str | None = Depends(get_current_user_id),
) -> dict:
    uid = _require_user(user_id)
    svc = _service_or_503(request)
    notes = await svc.list_notes(notebook_id, uid)
    return {"notes": [asdict(n) for n in notes]}


@router.get("/notes/{note_id}")
async def get_note(
    note_id: str,
    request: Request,
    user_id: str | None = Depends(get_current_user_id),
) -> dict:
    uid = _require_user(user_id)
    svc = _service_or_503(request)
    note = await svc.get_note(note_id, uid)
    if note is None:
        raise HTTPException(status_code=404, detail="nota não encontrada")
    return asdict(note)


@router.post("/notes")
async def create_note(
    body: CreateNoteBody,
    request: Request,
    user_id: str | None = Depends(get_current_user_id),
) -> dict:
    uid = _require_user(user_id)
    svc = _service_or_503(request)
    note = await svc.create_note(
        notebook_id=body.notebook_id,
        user_id=uid,
        title=body.title,
        content_md=body.content_md,
    )
    if note is None:
        raise HTTPException(status_code=404, detail="caderno não encontrado")
    return asdict(note)


@router.patch("/notes/{note_id}")
async def update_note(
    note_id: str,
    body: UpdateNoteBody,
    request: Request,
    user_id: str | None = Depends(get_current_user_id),
) -> dict:
    uid = _require_user(user_id)
    svc = _service_or_503(request)
    note = await svc.update_note(
        note_id, uid, title=body.title, content_md=body.content_md,
    )
    if note is None:
        raise HTTPException(status_code=404, detail="nota não encontrada")
    return asdict(note)


@router.delete("/notes/{note_id}")
async def delete_note(
    note_id: str,
    request: Request,
    user_id: str | None = Depends(get_current_user_id),
) -> dict:
    uid = _require_user(user_id)
    svc = _service_or_503(request)
    rows = await svc.delete_note(note_id, uid)
    if rows == 0:
        raise HTTPException(status_code=404, detail="nota não encontrada")
    return {"ok": True}


@router.get("/search")
async def search(
    request: Request,
    q: str = "",
    user_id: str | None = Depends(get_current_user_id),
) -> dict:
    uid = _require_user(user_id)
    svc = _service_or_503(request)
    notes = await svc.search(uid, q)
    return {"notes": [asdict(n) for n in notes]}
