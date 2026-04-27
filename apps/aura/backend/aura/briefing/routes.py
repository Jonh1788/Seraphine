"""Briefing routes — read-only endpoint that narrates the user's day."""

from __future__ import annotations

from dataclasses import asdict

from fastapi import APIRouter, Depends, HTTPException, Request

from mod_tasks.routes import get_current_user_id

from aura.briefing.service import BriefingService

router = APIRouter(prefix="/briefing", tags=["briefing"])


def _service_or_503(request: Request) -> BriefingService:
    svc = getattr(request.app.state, "briefing_service", None)
    if svc is None:
        raise HTTPException(status_code=503, detail="briefing service não configurado")
    return svc


def _require_user(user_id: str | None) -> str:
    if user_id is None:
        raise HTTPException(status_code=401, detail="autenticação requerida")
    return user_id


@router.get("/today")
async def get_today(
    request: Request,
    user_id: str | None = Depends(get_current_user_id),
) -> dict:
    uid = _require_user(user_id)
    svc = _service_or_503(request)
    result = await svc.get_today(uid)
    return {
        "text": result.text,
        "segments": [asdict(seg) for seg in result.segments],
        "generated_at": result.generated_at,
        "ttl_seconds": result.ttl_seconds,
    }


@router.post("/refresh")
async def refresh(
    request: Request,
    user_id: str | None = Depends(get_current_user_id),
) -> dict:
    """Drop the cached briefing for this user. Next /today regenerates."""
    uid = _require_user(user_id)
    svc = _service_or_503(request)
    svc.invalidate(uid)
    return {"ok": True}
