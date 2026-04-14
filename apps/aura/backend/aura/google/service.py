"""Google OAuth orchestration for Aura (multi-tenant, web redirect flow).

Responsibilities:
- Build a per-user consent URL with a short-lived signed ``state``.
- Handle the OAuth callback: verify state, exchange code for tokens,
  persist them to the user's ``google_tokens`` row, cache the email.
- Answer connection-status queries and do best-effort token revocation
  on disconnect.

The state we attach to the consent URL is a JWT (HS256, signed with the
app's ``jwt_secret``, 10-minute expiry) whose ``sub`` carries the
requesting user_id. This binds the eventual callback to the user that
initiated the flow without any server-side session bookkeeping.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from core_auth import issue as jwt_issue, verify as jwt_verify, JWTError
from google_integration import (
    DBTokenStore,
    GoogleClient,
    TokenBundle,
    WebOAuthFlow,
)

from aura.config import Settings

logger = logging.getLogger(__name__)

GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke"
GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"

# Consent states expire quickly — the user is live-clicking through a
# popup. 10 minutes is generous and still well below the ``exp`` a
# browser tab could accidentally surface from history.
_STATE_TTL_SECONDS = 600


class GoogleOAuthError(RuntimeError):
    """Raised when OAuth setup or callback handling fails."""


class GoogleAuthService:
    """Service-level wrapper around the Google OAuth dance + token store."""

    def __init__(self, store: Any, settings: Settings) -> None:
        self._store = store
        self._settings = settings

    # ------------------------------------------------------------------
    # Configuration
    # ------------------------------------------------------------------

    @property
    def is_configured(self) -> bool:
        return bool(
            self._settings.google_client_id
            and self._settings.google_client_secret
        )

    def _scopes(self) -> list[str]:
        raw = (self._settings.google_scopes or "").split()
        return [s for s in raw if s]

    def _flow(self) -> WebOAuthFlow:
        return WebOAuthFlow(
            client_id=self._settings.google_client_id,
            client_secret=self._settings.google_client_secret,
            scopes=self._scopes(),
            redirect_uri=self._settings.google_oauth_redirect_url,
        )

    def _token_store(self, user_id: str) -> DBTokenStore:
        return DBTokenStore(self._store, user_id)

    # ------------------------------------------------------------------
    # Consent URL
    # ------------------------------------------------------------------

    def build_consent_url(self, user_id: str) -> str:
        if not self.is_configured:
            raise GoogleOAuthError("google oauth not configured")
        state = jwt_issue(
            user_id,
            self._settings.jwt_secret,
            expires_in_seconds=_STATE_TTL_SECONDS,
        )
        return self._flow().build_consent_url(state)

    # ------------------------------------------------------------------
    # Callback
    # ------------------------------------------------------------------

    async def handle_callback(self, code: str, state: str) -> dict[str, Any]:
        if not self.is_configured:
            raise GoogleOAuthError("google oauth not configured")
        if not code or not state:
            raise GoogleOAuthError("missing code or state")

        try:
            user_id = jwt_verify(state, self._settings.jwt_secret)
        except JWTError as e:
            raise GoogleOAuthError(f"invalid state: {e}") from None

        bundle = await self._flow().exchange_code(code)
        token_store = self._token_store(user_id)
        await token_store.save(bundle)

        email = await self._fetch_userinfo_email(bundle)
        if email:
            await token_store.set_email(email)

        logger.info(
            "google oauth connected user_id=%s email=%s scopes=%s",
            user_id, email or "-", ",".join(bundle.scopes),
        )
        return {"user_id": user_id, "email": email}

    async def _fetch_userinfo_email(self, bundle: TokenBundle) -> str | None:
        """Best-effort: fetch the Google account's primary email.

        Uses the OIDC userinfo endpoint — works with the default scope
        set (which includes ``openid``/``email`` implicitly via Google's
        auth server when ``access_type=offline`` is used). Returns None
        on any failure; callers should treat email as optional.
        """
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(
                    GOOGLE_USERINFO_URL,
                    headers={"Authorization": f"Bearer {bundle.access_token}"},
                )
            if resp.status_code >= 400:
                logger.debug(
                    "google userinfo %d: %s", resp.status_code, resp.text[:200],
                )
                return None
            data = resp.json()
            email = data.get("email")
            return email if isinstance(email, str) else None
        except Exception as e:
            logger.debug("google userinfo failed: %s", e)
            return None

    # ------------------------------------------------------------------
    # Status / disconnect
    # ------------------------------------------------------------------

    async def get_status(self, user_id: str) -> dict[str, Any]:
        token_store = self._token_store(user_id)
        bundle = await token_store.load()
        if bundle is None:
            return {"connected": False, "email": None}
        email = await token_store.get_email()
        return {"connected": True, "email": email}

    async def disconnect(self, user_id: str) -> bool:
        token_store = self._token_store(user_id)
        bundle = await token_store.load()
        await token_store.clear()
        # Best-effort revoke — we already removed the row locally, so a
        # failed revoke must NOT fail the route. Users can also revoke
        # from their Google account page.
        if bundle is not None:
            token_to_revoke = bundle.refresh_token or bundle.access_token
            if token_to_revoke:
                try:
                    async with httpx.AsyncClient(timeout=10.0) as client:
                        await client.post(
                            GOOGLE_REVOKE_URL,
                            data={"token": token_to_revoke},
                        )
                except Exception as e:
                    logger.debug(
                        "google token revoke best-effort failed: %s", e,
                    )
        return True

    # ------------------------------------------------------------------
    # Convenience: build a GoogleClient scoped to a user (for future
    # calendar/gmail routes — not called by the chip today).
    # ------------------------------------------------------------------

    async def client_for(self, user_id: str) -> GoogleClient | None:
        token_store = self._token_store(user_id)
        bundle = await token_store.load()
        if bundle is None:
            return None
        return GoogleClient(
            token_store=token_store,
            client_id=self._settings.google_client_id,
            client_secret=self._settings.google_client_secret,
            scopes=self._scopes(),
        )
