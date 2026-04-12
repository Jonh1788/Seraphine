"""POST /click - click by coordinates or CSS selector."""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel
from fastapi import APIRouter

from browser import BrowserManager

router = APIRouter()
_bm: BrowserManager


def init(bm: BrowserManager) -> None:
    global _bm
    _bm = bm


class ClickRequest(BaseModel):
    x: Optional[float] = None
    y: Optional[float] = None
    selector: Optional[str] = None


@router.post("/click")
async def click(body: ClickRequest):
    try:
        page = _bm.page
        if body.selector:
            await page.click(body.selector)
        elif body.x is not None and body.y is not None:
            await page.mouse.click(body.x, body.y)
        else:
            return {"ok": False, "error": "Provide either 'selector' or both 'x' and 'y'"}
        return {"ok": True}
    except RuntimeError as exc:
        return {"ok": False, "error": str(exc)}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
