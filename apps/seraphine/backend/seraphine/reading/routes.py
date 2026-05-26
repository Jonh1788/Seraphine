"""Reading list HTTP API -- single-tenant, no auth required."""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from seraphine.reading.service import ReadingService

router = APIRouter(prefix="/reading", tags=["reading"])
logger = logging.getLogger(__name__)


class SaveItemBody(BaseModel):
    url: str = Field(min_length=1, max_length=2048)
    tags: list[str] | None = None

    model_config = {"extra": "forbid"}


class PatchItemBody(BaseModel):
    status: str | None = None
    tags: list[str] | None = None

    model_config = {"extra": "forbid"}


def _service_or_503(request: Request) -> ReadingService:
    svc: Optional[ReadingService] = getattr(
        request.app.state, "reading_service", None,
    )
    if svc is None:
        raise HTTPException(status_code=503, detail="reading service not configured")
    return svc


@router.post("/items")
async def save_item(
    request: Request,
    body: SaveItemBody,
) -> dict[str, Any]:
    svc = _service_or_503(request)
    try:
        item = await svc.save_item(url=body.url, tags=body.tags)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return {"item": item.to_dict()}


@router.get("/items")
async def list_items(
    request: Request,
    status: str | None = None,
    tag: str | None = None,
    q: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> dict[str, Any]:
    svc = _service_or_503(request)
    items = await svc.list_items(
        status=status, tag=tag, q=q, limit=limit, offset=offset,
    )
    return {"items": [i.to_dict() for i in items]}


@router.get("/items/{item_id}")
async def get_item(request: Request, item_id: str) -> dict[str, Any]:
    svc = _service_or_503(request)
    item = await svc.get_item(item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="reading item not found")
    return {"item": item.to_dict()}


@router.patch("/items/{item_id}")
async def patch_item(
    request: Request,
    item_id: str,
    body: PatchItemBody,
) -> dict[str, Any]:
    svc = _service_or_503(request)
    fields = body.model_dump(exclude_unset=True)
    try:
        item = await svc.update_item(item_id, **fields)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    if item is None:
        raise HTTPException(status_code=404, detail="reading item not found")
    return {"item": item.to_dict()}


@router.delete("/items/{item_id}")
async def delete_item(
    request: Request,
    item_id: str,
) -> dict[str, bool]:
    svc = _service_or_503(request)
    ok = await svc.delete_item(item_id)
    if not ok:
        raise HTTPException(status_code=404, detail="reading item not found")
    return {"ok": True}


@router.get("/search")
async def search_items(
    request: Request,
    q: str = "",
    limit: int = 10,
) -> dict[str, Any]:
    svc = _service_or_503(request)
    if not q.strip():
        raise HTTPException(status_code=422, detail="query is required")
    items = await svc.search(q, limit=limit)
    return {"items": [i.to_dict() for i in items]}
