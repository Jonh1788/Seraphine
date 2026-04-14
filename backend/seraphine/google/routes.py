"""REST router for the Google Workspace integration.

All endpoints pull ``request.app.state.google_client`` (wired in
``seraphine.main.lifespan``). If the client isn't configured (no
client_id/client_secret in env), every route returns a 503.

The OAuth consent flow is driven from the frontend: the user clicks
"Conectar Google" → ``POST /google/oauth/start`` returns a consent
URL → the frontend opens it in a new tab → Google redirects to
``http://localhost:<port>/callback`` which is handled by the local
one-shot HTTP server inside :class:`OAuthFlow` (NOT this router).
After the callback server captures the code and exchanges it, the
tokens are persisted and any subsequent ``GET /google/oauth/status``
will return ``{authed: true}``.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

from seraphine.config import settings
from seraphine.google.client import GoogleAuthError, GoogleClient
from seraphine.google.oauth import OAuthFlow

router = APIRouter(prefix="/google", tags=["google"])
logger = logging.getLogger(__name__)


def _client_or_503(request: Request) -> GoogleClient:
    client: Optional[GoogleClient] = getattr(
        request.app.state, "google_client", None
    )
    if client is None:
        raise HTTPException(
            status_code=503,
            detail="google integration not configured (set SERAPHINE_GOOGLE_CLIENT_ID/SECRET)",
        )
    return client


# ----------------------------------------------------------------------
# OAuth
# ----------------------------------------------------------------------


class OAuthStartResponse(BaseModel):
    consent_url: str


@router.post("/oauth/start", response_model=OAuthStartResponse)
async def oauth_start(request: Request) -> OAuthStartResponse:
    client = _client_or_503(request)
    flow = OAuthFlow(
        client_id=settings.google_client_id,
        client_secret=settings.google_client_secret,
        scopes=settings.google_scopes,
        port=settings.google_oauth_port,
    )
    consent_url = await flow.start()

    async def _complete() -> None:
        try:
            code = await flow.wait_for_callback(timeout=300.0)
            bundle = await flow.exchange_code(code)
            await client.save_bundle(bundle)
            logger.info("google oauth completed; tokens persisted")
        except Exception as e:
            logger.warning("google oauth flow failed: %s", e)

    # Fire-and-forget: the HTTP response returns immediately with the
    # consent URL, and the background task waits for the callback.
    asyncio.create_task(_complete())
    return OAuthStartResponse(consent_url=consent_url)


class OAuthStatus(BaseModel):
    authed: bool
    email: Optional[str] = None
    scopes: list[str] = []
    expires_at: Optional[datetime] = None


@router.get("/oauth/status", response_model=OAuthStatus)
async def oauth_status(request: Request) -> OAuthStatus:
    client = _client_or_503(request)
    try:
        authed = await client.is_authed()
    except Exception as e:
        logger.warning("oauth_status: is_authed failed: %s", e)
        return OAuthStatus(authed=False)

    if not authed:
        return OAuthStatus(authed=False)

    bundle = await client.get_bundle()
    email: Optional[str] = None
    try:
        profile = await client.get_profile()
        email = profile.get("emailAddress")
    except Exception as e:
        logger.debug("get_profile failed during status: %s", e)

    return OAuthStatus(
        authed=True,
        email=email,
        scopes=list(bundle.scopes) if bundle else [],
        expires_at=bundle.expires_at if bundle else None,
    )


@router.post("/oauth/logout")
async def oauth_logout(request: Request) -> dict[str, bool]:
    client = _client_or_503(request)
    await client.clear()
    return {"ok": True}


# ----------------------------------------------------------------------
# Calendar
# ----------------------------------------------------------------------


@router.get("/calendar/events")
async def calendar_events(
    request: Request,
    from_: Optional[str] = Query(None, alias="from"),
    to: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=250),
) -> list[dict[str, Any]]:
    client = _client_or_503(request)
    try:
        time_min = _parse_iso(from_) if from_ else datetime.now(timezone.utc)
        time_max = _parse_iso(to) if to else None
        return await client.list_events(
            time_min=time_min, time_max=time_max, q=q, max_results=limit
        )
    except GoogleAuthError as e:
        raise HTTPException(status_code=401, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.get("/calendar/calendars")
async def calendar_calendars(request: Request) -> list[dict[str, Any]]:
    client = _client_or_503(request)
    try:
        return await client.list_calendars()
    except GoogleAuthError as e:
        raise HTTPException(status_code=401, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


# ----------------------------------------------------------------------
# Gmail
# ----------------------------------------------------------------------


@router.get("/gmail/important")
async def gmail_important(
    request: Request, limit: int = Query(20, ge=1, le=100)
) -> list[dict[str, Any]]:
    client = _client_or_503(request)
    try:
        return await client.list_important_unread(max_results=limit)
    except GoogleAuthError as e:
        raise HTTPException(status_code=401, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.get("/gmail/messages/{message_id}")
async def gmail_message(request: Request, message_id: str) -> dict[str, Any]:
    client = _client_or_503(request)
    try:
        return await client.get_message(message_id)
    except GoogleAuthError as e:
        raise HTTPException(status_code=401, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.post("/gmail/messages/{message_id}/mark-read")
async def gmail_mark_read(request: Request, message_id: str) -> dict[str, bool]:
    client = _client_or_503(request)
    try:
        await client.mark_as_read(message_id)
        return {"ok": True}
    except GoogleAuthError as e:
        raise HTTPException(status_code=401, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------


def _parse_iso(s: str) -> datetime:
    """Parse an ISO-8601 timestamp, accepting trailing 'Z'."""
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        dt = datetime.fromisoformat(s)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"invalid datetime: {s}") from e
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt
