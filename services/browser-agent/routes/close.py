"""POST /close - shut down the browser context."""

from __future__ import annotations

from fastapi import APIRouter

from browser import BrowserManager

router = APIRouter()
_bm: BrowserManager


def init(bm: BrowserManager) -> None:
    global _bm
    _bm = bm


@router.post("/close")
async def close():
    try:
        await _bm.close()
        return {"ok": True}
    except RuntimeError as exc:
        return {"ok": False, "error": str(exc)}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
