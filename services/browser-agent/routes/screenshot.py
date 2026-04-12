"""POST /screenshot - capture the current page as a base64 PNG."""

from __future__ import annotations

import base64
from typing import Optional

from pydantic import BaseModel
from fastapi import APIRouter

from browser import BrowserManager

router = APIRouter()
_bm: BrowserManager


def init(bm: BrowserManager) -> None:
    global _bm
    _bm = bm


class ScreenshotRequest(BaseModel):
    full_page: Optional[bool] = False


@router.post("/screenshot")
async def screenshot(body: ScreenshotRequest):
    try:
        page = _bm.page
        buf = await page.screenshot(full_page=body.full_page or False)
        b64 = base64.b64encode(buf).decode()
        return {
            "image": f"data:image/png;base64,{b64}",
            "width": _bm.viewport_w,
            "height": _bm.viewport_h,
        }
    except RuntimeError as exc:
        return {"ok": False, "error": str(exc)}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
