"""REST API for the memory panel (Fase 6).

Exposes CRUD over facts stored in SQLite. Episodes (ChromaDB) are
read-only for now — they're surfaced via the recall endpoint.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field

router = APIRouter(prefix="/memory", tags=["memory"])


class FactCreate(BaseModel):
    text: str = Field(..., min_length=1)
    source: str = "explicit"
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)


class FactUpdate(BaseModel):
    text: str | None = None
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)


class RecallQuery(BaseModel):
    query: str = Field(..., min_length=1)
    k: int = Field(default=5, ge=1, le=50)


@router.get("/facts")
async def list_facts(
    request: Request,
    limit: int = 50,
    include_superseded: bool = False,
) -> list[dict[str, Any]]:
    store = request.app.state.store
    facts = await store.list_facts(limit=limit, include_superseded=include_superseded)
    return [f.model_dump() for f in facts]


@router.get("/facts/{fact_id}")
async def get_fact(request: Request, fact_id: str) -> dict[str, Any]:
    store = request.app.state.store
    fact = await store.get_fact(fact_id)
    if fact is None:
        raise HTTPException(status_code=404, detail="Fact not found")
    return fact.model_dump()


@router.post("/facts", status_code=201)
async def create_fact(request: Request, body: FactCreate) -> dict[str, Any]:
    memory = request.app.state.memory
    fact = await memory.learn_fact(
        body.text, source=body.source, confidence=body.confidence
    )
    return fact.model_dump()


@router.patch("/facts/{fact_id}")
async def update_fact(
    request: Request, fact_id: str, body: FactUpdate
) -> dict[str, Any]:
    store = request.app.state.store
    if body.text is None and body.confidence is None:
        raise HTTPException(status_code=400, detail="Nothing to update")
    fact = await store.update_fact(fact_id, text=body.text, confidence=body.confidence)
    if fact is None:
        raise HTTPException(status_code=404, detail="Fact not found")
    return fact.model_dump()


@router.delete("/facts/{fact_id}", status_code=204)
async def delete_fact(request: Request, fact_id: str) -> None:
    store = request.app.state.store
    deleted = await store.delete_fact(fact_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Fact not found")


class ImportPayload(BaseModel):
    version: int = 1
    exported_at: str = ""
    facts: list[dict[str, Any]]


@router.get("/export")
async def export_facts(request: Request) -> dict[str, Any]:
    """Export all active facts as a JSON download."""
    store = request.app.state.store
    facts = await store.list_facts(limit=10_000, include_superseded=False)
    return {
        "version": 1,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "facts": [f.model_dump() for f in facts],
    }


@router.post("/import")
async def import_facts(request: Request, body: ImportPayload) -> dict[str, Any]:
    """Import facts from a previously exported JSON payload, skipping duplicates."""
    store = request.app.state.store
    existing = await store.list_facts(limit=10_000, include_superseded=False)
    existing_texts: set[str] = {f.text for f in existing}

    imported = 0
    skipped = 0
    for item in body.facts:
        text = item.get("text", "").strip()
        if not text or text in existing_texts:
            skipped += 1
            continue
        source = item.get("source", "explicit")
        confidence = item.get("confidence", 1.0)
        await store.add_fact(text, source=source, confidence=confidence)
        existing_texts.add(text)
        imported += 1

    return {"imported": imported, "skipped": skipped}


@router.post("/recall")
async def recall(request: Request, body: RecallQuery) -> list[dict[str, Any]]:
    memory = request.app.state.memory
    memories = await memory.recall(body.query, k=body.k)
    return [m.model_dump() for m in memories]
