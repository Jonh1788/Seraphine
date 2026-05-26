"""Notes HTTP API -- single-tenant, no auth required."""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from seraphine.notes.service import NoteService

router = APIRouter(prefix="/notes", tags=["notes"])
logger = logging.getLogger(__name__)


class CreateNoteBody(BaseModel):
    title: str = Field(min_length=1, max_length=500)
    content: str | None = None
    tags: list[str] | None = None

    model_config = {"extra": "forbid"}


class PatchNoteBody(BaseModel):
    title: str | None = None
    content: str | None = None
    tags: list[str] | None = None

    model_config = {"extra": "forbid"}


def _service_or_503(request: Request) -> NoteService:
    svc: Optional[NoteService] = getattr(
        request.app.state, "note_service", None,
    )
    if svc is None:
        raise HTTPException(status_code=503, detail="note service not configured")
    return svc


# ------------------------------------------------------------------
# Tag aggregation  (SDD-084)
# NOTE: This route MUST be registered before /{note_id} so FastAPI
# doesn't treat "tags" as a note_id path parameter.
# ------------------------------------------------------------------

@router.get("/tags")
async def list_tags(request: Request) -> dict[str, Any]:
    svc = _service_or_503(request)
    tags = await svc.get_all_tags()
    return {"tags": tags}


@router.get("")
async def list_notes(
    request: Request,
    q: str | None = None,
    tag: str | None = None,
    limit: int = 50,
) -> dict[str, Any]:
    svc = _service_or_503(request)
    if q is not None and q.strip():
        items = await svc.search(q, limit=limit)
    else:
        items = await svc.list(limit=limit, tag=tag)
    return {"notes": [n.to_dict() for n in items]}


@router.get("/{note_id}")
async def get_note(request: Request, note_id: str) -> dict[str, Any]:
    svc = _service_or_503(request)
    note = await svc.get(note_id)
    if note is None:
        raise HTTPException(status_code=404, detail="note not found")
    return {"note": note.to_dict()}


@router.post("")
async def create_note(
    request: Request,
    body: CreateNoteBody,
) -> dict[str, Any]:
    svc = _service_or_503(request)
    try:
        note = await svc.create(
            title=body.title,
            content=body.content or "",
            tags=body.tags,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return {"note": note.to_dict()}


@router.patch("/{note_id}")
async def patch_note(
    request: Request,
    note_id: str,
    body: PatchNoteBody,
) -> dict[str, Any]:
    svc = _service_or_503(request)
    fields = body.model_dump(exclude_unset=True)
    try:
        note = await svc.update(note_id, **fields)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    if note is None:
        raise HTTPException(status_code=404, detail="note not found")
    return {"note": note.to_dict()}


@router.delete("/{note_id}")
async def delete_note(
    request: Request,
    note_id: str,
) -> dict[str, bool]:
    svc = _service_or_503(request)
    ok = await svc.delete(note_id)
    if not ok:
        raise HTTPException(status_code=404, detail="note not found")
    return {"ok": True}
