"""POST /navigate - go to a URL."""

from __future__ import annotations

from pydantic import BaseModel
from fastapi import APIRouter
from playwright.async_api import TimeoutError as PlaywrightTimeout

from browser import BrowserManager

router = APIRouter()
_bm: BrowserManager  # injected at startup


def init(bm: BrowserManager) -> None:
    global _bm
    _bm = bm


class NavigateRequest(BaseModel):
    url: str


@router.post("/navigate")
async def navigate(body: NavigateRequest):
    try:
        page = _bm.page
        await page.goto(body.url, wait_until="domcontentloaded", timeout=30000)
        return {"ok": True, "url": page.url, "title": await page.title()}
    except PlaywrightTimeout:
        return {"ok": False, "error": f"Navigation to {body.url} timed out"}
    except RuntimeError as exc:
        return {"ok": False, "error": str(exc)}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
