"""Google connection endpoints — real multi-tenant OAuth.

The frontend drives the dance:
- ``POST /google/connect`` returns a ``{consent_url}`` (JWT-required).
- The browser opens the consent URL in a popup; Google redirects to
  ``GET /google/oauth/callback?code=...&state=...`` (public — Google
  hits it). We exchange the code for tokens, persist them keyed by the
  ``state`` JWT's ``sub``, and return a small HTML page that closes the
  popup and ``postMessage``s the opener.
- ``GET /google/status`` / ``POST /google/disconnect`` are JWT-scoped.

See :mod:`aura.google.service` for the core logic.
"""

from __future__ import annotations

import html
import json
import logging
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import HTMLResponse

from google_integration.client import GoogleAPIError, GoogleAuthError
from mod_tasks.routes import get_current_user_id

from aura.google.service import GoogleAuthService, GoogleOAuthError

router = APIRouter(prefix="/google", tags=["google"])
logger = logging.getLogger(__name__)


def _require_user(user_id: Optional[str]) -> str:
    if user_id is None:
        raise HTTPException(status_code=401, detail="autenticação requerida")
    return user_id


def _service(request: Request) -> GoogleAuthService:
    svc: Optional[GoogleAuthService] = getattr(
        request.app.state, "google_auth_service", None,
    )
    if svc is None:
        # Defensive — lifespan always wires this. A 503 here means the
        # app booted wrong, which is worth surfacing clearly.
        raise HTTPException(
            status_code=503, detail="google auth service not configured",
        )
    return svc


# ----------------------------------------------------------------------
# Status / connect / disconnect
# ----------------------------------------------------------------------


@router.get("/status")
async def google_status(
    request: Request,
    user_id: Optional[str] = Depends(get_current_user_id),
) -> dict:
    """Whether THIS user has connected their Google account."""
    uid = _require_user(user_id)
    svc = _service(request)
    return await svc.get_status(uid)


@router.post("/connect")
async def google_connect(
    request: Request,
    user_id: Optional[str] = Depends(get_current_user_id),
) -> dict:
    uid = _require_user(user_id)
    svc = _service(request)
    if not svc.is_configured:
        raise HTTPException(
            status_code=501,
            detail=(
                "Google OAuth não configurado no servidor "
                "(AURA_GOOGLE_CLIENT_ID/SECRET)."
            ),
        )
    try:
        consent_url = svc.build_consent_url(uid)
    except GoogleOAuthError as e:
        raise HTTPException(status_code=500, detail=str(e)) from None
    return {"consent_url": consent_url}


@router.post("/disconnect")
async def google_disconnect(
    request: Request,
    user_id: Optional[str] = Depends(get_current_user_id),
) -> dict:
    uid = _require_user(user_id)
    svc = _service(request)
    await svc.disconnect(uid)
    return {"ok": True}


# ----------------------------------------------------------------------
# Calendar — proxy to Google API via the user's stored token
# ----------------------------------------------------------------------


def _parse_iso(value: str) -> datetime:
    # Google's API wants RFC3339 with timezone. Browsers send full ISO
    # already (toISOString); just normalize trailing Z.
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    dt = datetime.fromisoformat(value)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


@router.get("/calendar/events")
async def google_calendar_events(
    request: Request,
    from_: Optional[str] = Query(None, alias="from"),
    to: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=250),
    user_id: Optional[str] = Depends(get_current_user_id),
) -> list[dict[str, Any]]:
    """List Google Calendar events for the authed user. Returns [] when
    the user hasn't connected Google (so the UI can degrade gracefully)."""
    uid = _require_user(user_id)
    svc = _service(request)
    client = await svc.client_for(uid)
    if client is None:
        return []
    try:
        time_min = _parse_iso(from_) if from_ else datetime.now(timezone.utc)
        time_max = _parse_iso(to) if to else None
        return await client.list_events(
            time_min=time_min, time_max=time_max, q=q, max_results=limit,
        )
    except GoogleAuthError as e:
        raise HTTPException(status_code=401, detail=str(e))
    except GoogleAPIError as e:
        raise HTTPException(status_code=502, detail=str(e))
    except Exception as e:
        logger.exception("calendar events failed")
        raise HTTPException(status_code=502, detail=str(e))


# ----------------------------------------------------------------------
# OAuth callback (public — Google hits this from the user's browser)
# ----------------------------------------------------------------------


@router.get("/oauth/callback")
async def google_oauth_callback(
    request: Request,
    code: Optional[str] = Query(None),
    state: Optional[str] = Query(None),
    error: Optional[str] = Query(None),
) -> HTMLResponse:
    """Handle the post-consent redirect from Google.

    This endpoint is public — we verify the short-lived ``state`` JWT to
    know which user initiated the flow. On success, write the tokens
    and return a page that ``postMessage``s the opener window and
    closes the popup. On failure, same page shape but ``ok: false``.
    """
    svc = _service(request)

    if error:
        return _callback_html(ok=False, detail=f"Google retornou erro: {error}")

    if not code or not state:
        return _callback_html(
            ok=False,
            detail="Parâmetros ausentes no callback (code/state).",
            status_code=400,
        )

    try:
        await svc.handle_callback(code, state)
    except GoogleOAuthError as e:
        msg = str(e)
        logger.info("google oauth callback rejected: %s", msg)
        return _callback_html(ok=False, detail=msg, status_code=400)
    except Exception as e:
        logger.exception("google oauth callback: unexpected failure")
        return _callback_html(
            ok=False,
            detail=f"Falha inesperada: {e}",
            status_code=500,
        )

    return _callback_html(ok=True, detail="Conta Google conectada.")


# ----------------------------------------------------------------------
# HTML helper
# ----------------------------------------------------------------------


_PAGE_TEMPLATE = """<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <title>Aura — Google</title>
  <style>
    body {{ font-family: -apple-system, system-ui, sans-serif;
            background: #0b0b0b; color: #eee; display: flex;
            align-items: center; justify-content: center;
            height: 100vh; margin: 0; }}
    .card {{ background: #161616; padding: 28px 40px; border-radius: 12px;
             box-shadow: 0 8px 32px rgba(0,0,0,.4); text-align: center;
             max-width: 420px; }}
    h1 {{ margin: 0 0 6px; font-size: 20px; }}
    p  {{ margin: 0; color: #aaa; font-size: 14px; }}
  </style>
</head>
<body>
  <div class="card">
    <h1>{heading}</h1>
    <p>{detail}</p>
  </div>
  <script>
    (function () {{
      var ok = {ok_json};
      try {{
        if (window.opener) {{
          // Popup flow (e.g. GoogleCalendarChip): notify the opener and
          // close ourselves — the opener refreshes its own state.
          window.opener.postMessage(
            {{ source: "aura.google.oauth", ok: ok, error: {error_json} }},
            "*"
          );
          setTimeout(function () {{ try {{ window.close(); }} catch (e) {{}} }}, 400);
          return;
        }}
      }} catch (e) {{ /* ignore */ }}
      // Full-page redirect flow (PerfilPage): bring the user back to the
      // page they started from. Falls back to /perfil when nothing was
      // stashed (e.g. landed here from an external link).
      var ret = "/perfil";
      try {{
        var stashed = sessionStorage.getItem("aura.google.return_to");
        if (stashed) {{
          ret = stashed;
          sessionStorage.removeItem("aura.google.return_to");
        }}
      }} catch (e) {{ /* sessionStorage may be unavailable */ }}
      setTimeout(function () {{ window.location.replace(ret); }}, 800);
    }})();
  </script>
</body>
</html>
"""


def _callback_html(
    *,
    ok: bool,
    detail: str,
    status_code: int = 200,
) -> HTMLResponse:
    heading = "Conectado!" if ok else "Não foi possível conectar"
    # json.dumps escapes quotes/backslashes correctly for a JS string
    # context; then we prevent ``</script>`` injection by escaping ``<``.
    error_js = "null" if ok else json.dumps(detail).replace("<", "\\u003c")
    body = _PAGE_TEMPLATE.format(
        heading=html.escape(heading),
        detail=html.escape(detail),
        ok_json="true" if ok else "false",
        error_json=error_js,
    )
    return HTMLResponse(content=body, status_code=status_code)
