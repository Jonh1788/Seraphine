"""POST /select - choose an option from a <select> element."""

from __future__ import annotations

from pydantic import BaseModel
from fastapi import APIRouter

from browser import BrowserManager

router = APIRouter()
_bm: BrowserManager


def init(bm: BrowserManager) -> None:
    global _bm
    _bm = bm


class SelectRequest(BaseModel):
    selector: str
    value: str


@router.post("/select")
async def select(body: SelectRequest):
    try:
        page = _bm.page
        await page.select_option(body.selector, body.value)
        return {"ok": True}
    except RuntimeError as exc:
        return {"ok": False, "error": str(exc)}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
