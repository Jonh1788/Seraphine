"""POST /type - type text into the focused element."""

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


class TypeRequest(BaseModel):
    text: str
    clear_first: Optional[bool] = False
    press_enter: Optional[bool] = False


@router.post("/type")
async def type_text(body: TypeRequest):
    try:
        page = _bm.page
        if body.clear_first:
            await page.keyboard.press("Control+A")
            await page.keyboard.press("Backspace")
        await page.keyboard.type(body.text, delay=50)
        if body.press_enter:
            await page.keyboard.press("Enter")
        return {"ok": True}
    except RuntimeError as exc:
        return {"ok": False, "error": str(exc)}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
