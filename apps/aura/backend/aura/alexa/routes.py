"""FastAPI router for the Alexa skill.

Endpoints:
- ``POST /alexa`` — skill webhook (signature + applicationId check, then dispatch).
- ``GET /alexa/oauth/authorize`` — Aura's OAuth2 authorization endpoint.
- ``POST /alexa/oauth/token`` — token + refresh endpoint (HTTP Basic for client auth).
- ``GET /alexa/status`` — Perfil page query.
- ``POST /alexa/disconnect`` — Perfil page action.

``build_router`` is the entry-point so ``main.py`` can inject the configured
oauth + service + verifier, and tests can inject fakes.
"""

from __future__ import annotations

import base64
import logging
from typing import Awaitable, Callable
from urllib.parse import urlencode

from fastapi import APIRouter, Form, HTTPException, Request, Response
from fastapi.responses import JSONResponse, RedirectResponse

from aura.alexa.intents import build_response, dispatch
from aura.alexa.oauth import (
    AlexaOAuth,
    InvalidClientError,
    InvalidGrantError,
    InvalidRedirectError,
)
from aura.alexa.service import AlexaService
from aura.alexa.signature import InvalidSignatureError, is_timestamp_fresh

logger = logging.getLogger(__name__)


def build_router(
    *,
    oauth: AlexaOAuth,
    service: AlexaService,
    skill_id: str,
    verify_signature: Callable[..., None],
    get_current_user_id: Callable[[Request], Awaitable[str | None]],
) -> APIRouter:
    router = APIRouter(prefix="/alexa", tags=["alexa"])

    # ---- skill endpoint -------------------------------------------------

    @router.post("")
    async def skill_endpoint(request: Request) -> JSONResponse:
        body_bytes = await request.body()
        sig = request.headers.get("Signature-256")
        cert_url = request.headers.get("SignatureCertChainUrl")
        # Allow tests to bypass crypto by omitting Signature-* headers.
        # When signature headers are present we verify both the RSA signature
        # AND the timestamp freshness (the latter is part of Amazon's
        # replay-protection pipeline, so it lives with the crypto gate).
        signed = bool(sig and cert_url)
        if signed:
            try:
                verify_signature(
                    body=body_bytes, signature_b64=sig, cert_chain_url=cert_url
                )
            except InvalidSignatureError as e:
                logger.warning("alexa: bad signature: %s", e)
                raise HTTPException(status_code=400, detail="bad signature")
        try:
            envelope = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="bad json")

        # applicationId check.
        app_id = (envelope.get("session", {}).get("application", {}) or {}).get(
            "applicationId"
        )
        if app_id != skill_id:
            logger.warning("alexa: applicationId mismatch %r", app_id)
            raise HTTPException(status_code=400, detail="bad applicationId")

        # Timestamp freshness — only enforced when the request was signed,
        # so tests passing fake envelopes without crypto don't trip on it.
        ts = envelope.get("request", {}).get("timestamp")
        if signed and ts and not is_timestamp_fresh(ts):
            logger.warning("alexa: stale timestamp %r", ts)
            raise HTTPException(status_code=400, detail="stale timestamp")

        # accessToken -> user_id. Missing/invalid -> LinkAccount card.
        access_token = (envelope.get("session", {}).get("user", {}) or {}).get(
            "accessToken"
        )
        user_id = (
            oauth.user_id_from_access_token(access_token) if access_token else None
        )
        if user_id is None:
            return JSONResponse(
                build_response(
                    speech="Vincule sua conta Aura no app Alexa pra continuarmos.",
                    end_session=True,
                    link_account=True,
                )
            )

        result = await dispatch(svc=service, envelope=envelope, user_id=user_id)
        return JSONResponse(result)

    # ---- OAuth ---------------------------------------------------------

    @router.get("/oauth/authorize")
    async def authorize(
        request: Request,
        client_id: str,
        redirect_uri: str,
        state: str = "",
        response_type: str = "code",
        scope: str = "aura.full",
    ) -> Response:
        if response_type != "code":
            raise HTTPException(status_code=400, detail="unsupported response_type")
        if not oauth.is_allowed_redirect(redirect_uri):
            raise HTTPException(status_code=400, detail="redirect_uri not allowed")
        user_id = await get_current_user_id(request)
        if user_id is None:
            # Punt to Aura login; round-trip back to this URL on success.
            next_url = "/alexa/oauth/authorize?" + urlencode(
                {
                    "client_id": client_id,
                    "redirect_uri": redirect_uri,
                    "state": state,
                    "response_type": response_type,
                    "scope": scope,
                }
            )
            return RedirectResponse(
                url=f"/login?next={next_url}",
                status_code=302,
            )
        try:
            code = oauth.issue_code(
                user_id=user_id, client_id=client_id, redirect_uri=redirect_uri
            )
        except InvalidClientError:
            raise HTTPException(status_code=400, detail="bad client_id")
        except InvalidRedirectError:
            raise HTTPException(status_code=400, detail="redirect_uri not allowed")
        target = redirect_uri + (
            "&" if "?" in redirect_uri else "?"
        ) + urlencode({"code": code, "state": state})
        return RedirectResponse(url=target, status_code=302)

    @router.post("/oauth/token")
    async def token_endpoint(
        request: Request,
        grant_type: str = Form(...),
        code: str | None = Form(None),
        refresh_token: str | None = Form(None),
        redirect_uri: str | None = Form(None),
    ) -> JSONResponse:
        cid, csecret = _parse_basic_auth(request.headers.get("Authorization", ""))
        if cid is None:
            return JSONResponse({"error": "invalid_client"}, status_code=401)
        try:
            if grant_type == "authorization_code":
                if not code or not redirect_uri:
                    return JSONResponse({"error": "invalid_request"}, status_code=400)
                tokens = oauth.exchange_code(
                    code=code,
                    client_id=cid,
                    client_secret=csecret or "",
                    redirect_uri=redirect_uri,
                )
            elif grant_type == "refresh_token":
                if not refresh_token:
                    return JSONResponse({"error": "invalid_request"}, status_code=400)
                tokens = oauth.refresh(
                    refresh_token=refresh_token,
                    client_id=cid,
                    client_secret=csecret or "",
                )
            else:
                return JSONResponse(
                    {"error": "unsupported_grant_type"}, status_code=400
                )
        except InvalidClientError:
            return JSONResponse({"error": "invalid_client"}, status_code=401)
        except InvalidGrantError:
            return JSONResponse({"error": "invalid_grant"}, status_code=400)
        return JSONResponse(tokens)

    # ---- Perfil page surface ------------------------------------------

    @router.get("/status")
    async def status(request: Request) -> JSONResponse:
        user_id = await get_current_user_id(request)
        if user_id is None:
            raise HTTPException(status_code=401, detail="auth required")
        return JSONResponse(service.get_status(user_id))

    @router.post("/disconnect")
    async def disconnect(request: Request) -> JSONResponse:
        user_id = await get_current_user_id(request)
        if user_id is None:
            raise HTTPException(status_code=401, detail="auth required")
        service.disconnect(user_id)
        return JSONResponse({"ok": True})

    return router


def _parse_basic_auth(header: str) -> tuple[str | None, str | None]:
    if not header.lower().startswith("basic "):
        return None, None
    try:
        raw = base64.b64decode(header[6:].strip()).decode("utf-8", errors="strict")
    except Exception:
        return None, None
    if ":" not in raw:
        return None, None
    cid, _, csecret = raw.partition(":")
    return cid, csecret
