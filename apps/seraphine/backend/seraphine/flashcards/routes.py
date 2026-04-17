"""067 — Flashcards HTTP routes."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from seraphine.flashcards.service import FlashcardsService

router = APIRouter(prefix="/flashcards", tags=["flashcards"])


class DeckIn(BaseModel):
    topic: str = Field(..., min_length=2, max_length=200)
    count: int = Field(default=10, ge=3, le=20)


class ReviewIn(BaseModel):
    card_id: str
    rating: int = Field(..., ge=0, le=5)


@router.get("/due")
async def due(request: Request, limit: int = 20) -> dict[str, Any]:
    store = request.app.state.store
    llm = request.app.state.llm
    cards = await FlashcardsService(store, llm).list_due(limit=limit)
    return {"cards": cards}


@router.post("/decks")
async def create_deck(payload: DeckIn, request: Request) -> dict[str, Any]:
    store = request.app.state.store
    llm = getattr(request.app.state, "llm", None)
    if llm is None:
        raise HTTPException(status_code=503, detail="llm not configured")
    cards = await FlashcardsService(store, llm).create_deck(payload.topic, payload.count)
    return {"cards": cards, "topic": payload.topic, "count": len(cards)}


@router.post("/review")
async def review(payload: ReviewIn, request: Request) -> dict[str, Any]:
    store = request.app.state.store
    llm = getattr(request.app.state, "llm", None)
    result = await FlashcardsService(store, llm).review(payload.card_id, payload.rating)
    if result is None:
        raise HTTPException(status_code=404, detail="card not found")
    return {"card": result}


@router.delete("/decks")
async def delete_deck(topic: str, request: Request) -> dict[str, Any]:
    """Apaga TODOS os cards de um topic (inclui futuros, não só os due).
    Topic vem via query (?topic=...) pra lidar com espaços/acentos sem
    quebrar o path."""
    store = request.app.state.store
    topic_s = (topic or "").strip()
    if not topic_s:
        raise HTTPException(status_code=400, detail="topic required")
    import asyncio as _aio

    def _work() -> int:
        with store._connect() as conn:
            cur = conn.execute("DELETE FROM flashcards WHERE topic = ?", (topic_s,))
            return cur.rowcount or 0

    deleted = await _aio.to_thread(_work)
    return {"ok": True, "deleted": deleted}


@router.delete("/{card_id}")
async def delete_card(card_id: str, request: Request) -> dict[str, Any]:
    store = request.app.state.store
    import asyncio as _aio

    def _work() -> int:
        with store._connect() as conn:
            cur = conn.execute("DELETE FROM flashcards WHERE id = ?", (card_id,))
            return cur.rowcount or 0

    deleted = await _aio.to_thread(_work)
    if not deleted:
        raise HTTPException(status_code=404, detail="card not found")
    return {"ok": True}
