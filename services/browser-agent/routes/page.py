"""GET /page - return current page URL and title."""

from __future__ import annotations

from fastapi import APIRouter

from browser import BrowserManager

router = APIRouter()
_bm: BrowserManager


def init(bm: BrowserManager) -> None:
    global _bm
    _bm = bm


@router.get("/page")
async def get_page():
    try:
        page = _bm.page
        return {"url": page.url, "title": await page.title()}
    except RuntimeError as exc:
        return {"ok": False, "error": str(exc)}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
