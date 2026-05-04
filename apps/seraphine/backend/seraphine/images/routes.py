"""068 — Image generation routes."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from seraphine.config import settings
from seraphine.images.service import ImageGenService

router = APIRouter(prefix="/images", tags=["images"])


class GenerateIn(BaseModel):
    prompt: str = Field(..., min_length=2, max_length=1200)
    style: str | None = Field(default=None)
    quality: str = Field(default="fast")


@router.post("")
async def generate_image(payload: GenerateIn, request: Request) -> dict[str, Any]:
    store = request.app.state.store
    svc = ImageGenService(store, settings)
    try:
        result = await svc.generate(
            payload.prompt, style=payload.style, quality=payload.quality,
        )
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"generation failed: {e}")
    return {"image": result}


@router.get("/{image_id}")
async def get_image(image_id: str, request: Request) -> Any:
    store = request.app.state.store
    svc = ImageGenService(store, settings)
    meta = await svc.get_image_meta(image_id)
    if meta is None:
        raise HTTPException(status_code=404, detail="image not found")
    local = meta.get("local_path")
    if local and Path(local).is_file():
        # Detect from extension — generated FLUX/Imagen are png, but
        # user uploads can be jpg/webp/gif and Replicate / browsers
        # need the right Content-Type.
        ext = Path(local).suffix.lstrip(".").lower()
        media = {
            "jpg": "image/jpeg",
            "jpeg": "image/jpeg",
            "webp": "image/webp",
            "gif": "image/gif",
        }.get(ext, "image/png")
        return FileResponse(local, media_type=media)
    # Fallback: redirect to original URL.
    if meta.get("url"):
        from fastapi.responses import RedirectResponse
        return RedirectResponse(url=str(meta["url"]))
    raise HTTPException(status_code=410, detail="image bytes lost")


@router.get("")
async def list_images(request: Request, limit: int = 20) -> dict[str, Any]:
    store = request.app.state.store
    import asyncio as _aio

    def _work() -> list[dict[str, Any]]:
        with store._connect() as conn:
            rows = conn.execute(
                "SELECT id, prompt, model, url, cost_usd, created_at"
                " FROM generated_images ORDER BY created_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [
            {"id": r[0], "prompt": r[1], "model": r[2],
             "url": r[3], "cost_usd": r[4], "created_at": r[5]}
            for r in rows
        ]

    return {"images": await _aio.to_thread(_work)}
