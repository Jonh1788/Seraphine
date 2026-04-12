"""POST /keyboard - press a single key or key combo."""

from __future__ import annotations

from pydantic import BaseModel
from fastapi import APIRouter

from browser import BrowserManager

router = APIRouter()
_bm: BrowserManager


def init(bm: BrowserManager) -> None:
    global _bm
    _bm = bm


class KeyboardRequest(BaseModel):
    key: str  # e.g. "Enter", "Tab", "Control+C", "Escape"


@router.post("/keyboard")
async def keyboard(body: KeyboardRequest):
    try:
        page = _bm.page
        await page.keyboard.press(body.key)
        return {"ok": True}
    except RuntimeError as exc:
        return {"ok": False, "error": str(exc)}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
