"""GET /health - service liveness and browser readiness."""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from browser import BrowserManager

router = APIRouter()
_bm: BrowserManager


def init(bm: BrowserManager) -> None:
    global _bm
    _bm = bm


@router.get("/health")
async def health():
    ready = _bm.ready
    data: dict = {"status": "ok", "browser_ready": ready}
    if ready:
        try:
            data["url"] = _bm.page.url
        except Exception:
            data["url"] = None
    status_code = 200 if ready else 503
    return JSONResponse(content=data, status_code=status_code)
