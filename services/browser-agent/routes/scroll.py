"""POST /scroll - scroll the page in a given direction."""

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


class ScrollRequest(BaseModel):
    direction: str  # "up" | "down" | "left" | "right"
    amount: Optional[int] = 3  # number of "wheel ticks" (each ~100px)


@router.post("/scroll")
async def scroll(body: ScrollRequest):
    try:
        page = _bm.page
        pixels = (body.amount or 3) * 100
        dx, dy = 0, 0
        d = body.direction.lower()
        if d == "down":
            dy = pixels
        elif d == "up":
            dy = -pixels
        elif d == "right":
            dx = pixels
        elif d == "left":
            dx = -pixels
        else:
            return {"ok": False, "error": f"Unknown direction: {body.direction}"}
        await page.mouse.wheel(dx, dy)
        return {"ok": True}
    except RuntimeError as exc:
        return {"ok": False, "error": str(exc)}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
