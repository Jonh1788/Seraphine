"""Google connection status + connect/disconnect endpoints (stubs).

These exist so the frontend's GoogleCalendarChip has a stable contract
to talk to. The actual OAuth dance (consent URL, callback exchanging
code → tokens, per-user DBTokenStore) is a separate piece of work —
status will report disconnected and connect/disconnect 501 until it
lands.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request

from mod_tasks.routes import get_current_user_id

router = APIRouter(prefix="/google", tags=["google"])


def _require_user(user_id: Optional[str]) -> str:
    if user_id is None:
        raise HTTPException(status_code=401, detail="autenticação requerida")
    return user_id


@router.get("/status")
async def google_status(
    request: Request,
    user_id: Optional[str] = Depends(get_current_user_id),
) -> dict:
    """Whether THIS user has connected their Google account.

    Multi-tenant OAuth not yet wired — every call returns disconnected.
    """
    _require_user(user_id)
    # When the per-user DBTokenStore lands, look up by user_id here.
    return {"connected": False, "email": None}


@router.post("/connect")
async def google_connect(
    request: Request,
    user_id: Optional[str] = Depends(get_current_user_id),
) -> dict:
    _require_user(user_id)
    raise HTTPException(
        status_code=501,
        detail=(
            "Conexão com Google Calendar em construção. "
            "OAuth multi-tenant ainda não wired no Aura."
        ),
    )


@router.post("/disconnect")
async def google_disconnect(
    request: Request,
    user_id: Optional[str] = Depends(get_current_user_id),
) -> dict:
    _require_user(user_id)
    # No-op for now — there's nothing stored to clear.
    return {"ok": True}
