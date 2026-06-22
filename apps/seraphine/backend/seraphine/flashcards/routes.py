"""067 — Flashcards HTTP routes."""

from __future__ import annotations

from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from seraphine.config import settings
from seraphine.flashcards.service import FlashcardsGenerationError, FlashcardsService

router = APIRouter(prefix="/flashcards", tags=["flashcards"])


class DeckIn(BaseModel):
    source: Literal["topic", "research", "note", "article", "chat"] = "topic"
    topic: str = Field(default="", max_length=200)
    count: int = Field(default=10, ge=3, le=20)
    note_id: Optional[str] = None
    reading_item_id: Optional[str] = None
    text: Optional[str] = None


class CardIn(BaseModel):
    topic: str = Field(..., min_length=1, max_length=200)
    front: str = Field(..., min_length=3, max_length=200)
    back: str = Field(..., min_length=3, max_length=500)
    tags: list[str] = Field(default_factory=list)
    source_url: Optional[str] = None


class CardEditIn(BaseModel):
    front: Optional[str] = None
    back: Optional[str] = None
    topic: Optional[str] = None
    tags: Optional[list[str]] = None
    source_url: Optional[str] = None
    source_title: Optional[str] = None
    image_url: Optional[str] = None


class ReviewIn(BaseModel):
    card_id: str
    rating: int = Field(..., ge=0, le=5)


def _svc(request: Request) -> FlashcardsService:
    return FlashcardsService(request.app.state.store, getattr(request.app.state, "llm", None))


def _build_engine(request: Request):
    from seraphine.deepsearch.engine import DeepResearchEngine
    from seraphine.deepsearch.providers import resolve_role_model

    llm = request.app.state.llm
    ds = getattr(request.app.state, "deepsearch_service", None)
    fanout_spec, synth_spec, key = "cliproxy:claude-haiku-4-5", "cliproxy:claude-haiku-4-5", ""
    if ds is not None:
        try:
            cfg = ds._read_config()
            fanout_spec, synth_spec, key = cfg.fanout_model, cfg.synth_model, cfg.openrouter_key
        except Exception:
            pass
    fanout = resolve_role_model(fanout_spec, app_llm=llm, openrouter_key=key)
    synth = resolve_role_model(synth_spec, app_llm=llm, openrouter_key=key)
    tools_reg = getattr(request.app.state, "tools", None)
    tools = {
        "search": tools_reg.get("web_search") if tools_reg else None,
        "fetch": tools_reg.get("web_fetch") if tools_reg else None,
        "news": tools_reg.get("search_news") if tools_reg else None,
    }
    return DeepResearchEngine(fanout=fanout, synth=synth, tools=tools)


@router.get("/due")
async def due(request: Request, limit: int = 20) -> dict[str, Any]:
    store = request.app.state.store
    llm = request.app.state.llm
    cards = await FlashcardsService(store, llm).list_due(limit=limit)
    return {"cards": cards}


@router.get("/decks")
async def deck_summaries(request: Request) -> dict[str, Any]:
    """Read-only deck summary: one row per topic over the EXISTING flashcards
    table (GROUP BY topic). Returns total card count, due count, avg ease/reps
    and a derived mastery %, so the grid can show every deck (even with 0 due)
    with real totals. Study queue stays on GET /due."""
    store = request.app.state.store
    llm = getattr(request.app.state, "llm", None)
    decks = await FlashcardsService(store, llm).deck_summaries()
    return {"decks": decks}


@router.post("/decks")
async def create_deck(payload: DeckIn, request: Request) -> dict[str, Any]:
    svc = _svc(request)
    if getattr(request.app.state, "llm", None) is None:
        raise HTTPException(status_code=503, detail="llm not configured")
    try:
        if payload.source == "topic":
            cards = await svc.create_deck(payload.topic, payload.count)
            topic = payload.topic
        elif payload.source == "research":
            cards = await svc.create_deck_from_research(
                payload.topic, count=payload.count, engine=_build_engine(request),
            )
            topic = payload.topic
        elif payload.source == "note":
            note = await request.app.state.note_service.get(payload.note_id or "")
            if note is None:
                raise HTTPException(status_code=404, detail="nota não encontrada")
            topic = note.title or "Nota"
            cards = await svc.create_deck_from_text(
                topic=topic, text=note.content, count=payload.count, tags=list(note.tags or []),
            )
        elif payload.source == "article":
            item = await request.app.state.reading_service.get_item(payload.reading_item_id or "")
            if item is None:
                raise HTTPException(status_code=404, detail="artigo não encontrado")
            topic = item.title or "Artigo"
            cards = await svc.create_deck_from_text(
                topic=topic, text=(item.content_text or item.summary or ""),
                count=payload.count, source_url=item.url, source_title=item.title,
            )
        else:  # chat
            topic = (payload.topic or "Chat").strip() or "Chat"
            cards = await svc.create_deck_from_text(
                topic=topic, text=payload.text or "", count=payload.count,
            )
    except FlashcardsGenerationError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"cards": cards, "topic": topic, "count": len(cards)}


@router.post("/cards")
async def create_card(payload: CardIn, request: Request) -> dict[str, Any]:
    try:
        card = await _svc(request).create_card(
            topic=payload.topic, front=payload.front, back=payload.back,
            tags=payload.tags, source_url=payload.source_url,
        )
    except FlashcardsGenerationError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"card": card}


@router.post("/review")
async def review(payload: ReviewIn, request: Request) -> dict[str, Any]:
    store = request.app.state.store
    llm = getattr(request.app.state, "llm", None)
    result = await FlashcardsService(store, llm).review(payload.card_id, payload.rating)
    if result is None:
        raise HTTPException(status_code=404, detail="card not found")
    return {"card": result}


@router.put("/{card_id}")
async def edit_card(card_id: str, payload: CardEditIn, request: Request) -> dict[str, Any]:
    card = await _svc(request).edit_card(card_id, **payload.model_dump(exclude_none=True))
    if card is None:
        raise HTTPException(status_code=404, detail="card not found")
    return {"card": card}


@router.post("/{card_id}/image")
async def card_image(card_id: str, request: Request) -> dict[str, Any]:
    from seraphine.images.service import ImageGenService

    image_service = ImageGenService(request.app.state.store, settings)
    try:
        out = await _svc(request).generate_card_image(card_id, image_service=image_service)
    except FlashcardsGenerationError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"falha ao gerar imagem: {e}")
    return {"card": out}


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
