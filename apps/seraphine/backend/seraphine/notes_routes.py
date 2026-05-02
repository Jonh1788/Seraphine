"""055 — Desktop sticky notes routes."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

router = APIRouter(prefix="/desktop_notes", tags=["desktop_notes"])


# Keep this Literal in sync with the StickyNoteCreateTool enum
# (seraphine/tools/sticky.py) and the desktop_notes table default
# (seraphine/memory/store.py).
NoteColor = Literal["yellow", "pink", "blue", "green"]


class NoteCreate(BaseModel):
    text: str = Field(..., min_length=1, max_length=800)
    color: NoteColor = "yellow"
    x: int = Field(default=120)
    y: int = Field(default=120)


class NoteUpdate(BaseModel):
    text: str | None = None
    x: int | None = None
    y: int | None = None


@router.get("")
async def list_notes(request: Request, include_dismissed: bool = False) -> dict[str, Any]:
    store = request.app.state.store
    notes = await store.list_desktop_notes(include_dismissed=include_dismissed)
    return {"notes": notes}


@router.post("")
async def create_note(payload: NoteCreate, request: Request) -> dict[str, Any]:
    store = request.app.state.store
    note = await store.create_desktop_note(
        text=payload.text, color=payload.color, x=payload.x, y=payload.y,
    )
    return {"note": note}


@router.patch("/{note_id}")
async def update_note(note_id: str, payload: NoteUpdate, request: Request) -> dict[str, Any]:
    store = request.app.state.store
    await store.update_desktop_note(
        note_id, x=payload.x, y=payload.y, text=payload.text,
    )
    return {"ok": True}


@router.delete("/{note_id}")
async def dismiss_note(note_id: str, request: Request) -> dict[str, Any]:
    store = request.app.state.store
    await store.dismiss_desktop_note(note_id)
    return {"ok": True}
