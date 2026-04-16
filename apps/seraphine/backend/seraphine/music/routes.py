"""Music HTTP API — focus auto-play + now-playing probe (SDD 017-A).

Both routes are best-effort by design. ``/music/focus-start`` is fired
silently by the frontend when the Pomodoro timer enters a ``work``
phase, so it must return quickly and never raise a 5xx the user would
see. ``/music/now-playing`` simply forwards the ``now_playing`` tool
result for frontend polling/debug.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request

from seraphine.music.service import FocusMusicService
from seraphine.tools.base import ToolResult

router = APIRouter(prefix="/music", tags=["music"])
logger = logging.getLogger(__name__)


def _service_or_503(request: Request) -> FocusMusicService:
    svc: Optional[FocusMusicService] = getattr(
        request.app.state, "music_service", None,
    )
    if svc is None:
        raise HTTPException(status_code=503, detail="music service not configured")
    return svc


@router.post("/focus-start")
async def start_focus_music(request: Request) -> dict[str, Any]:
    """Trigger taste-driven focus playback. Fired by the Pomodoro timer.

    Always returns 200 (even on internal failure) so the frontend's
    fire-and-forget fetch doesn't bubble an error to the user.
    """

    svc: Optional[FocusMusicService] = getattr(
        request.app.state, "music_service", None,
    )
    if svc is None:
        return {
            "ok": False,
            "query": None,
            "error": "music service not configured",
        }
    try:
        result = await svc.start_focus_music()
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("/music/focus-start crashed")
        return {"ok": False, "query": None, "error": str(exc)}
    return result


@router.get("/now-playing")
async def now_playing(request: Request) -> dict[str, Any]:
    """Return the current YouTube Music state as a card-shaped dict.

    Uses the ``now_playing`` tool so the behaviour stays aligned with
    what the LLM sees when it calls the same tool mid-conversation.
    """

    tools = getattr(request.app.state, "tools", None)
    tool = tools.get("now_playing") if tools is not None else None
    if tool is None:
        raise HTTPException(status_code=503, detail="now_playing tool not registered")
    try:
        result: ToolResult = await tool.execute({})
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("/music/now-playing crashed")
        raise HTTPException(status_code=500, detail=str(exc))
    card = None
    if result.metadata:
        card = result.metadata.get("music_card")
    return {
        "ok": bool(result.ok),
        "output": result.output,
        "error": result.error,
        "music_card": card,
    }
