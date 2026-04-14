"""google-integration — OAuth + Gmail + Calendar client.

Public surface:
- ``client.GoogleClient``: HTTP client wrapping Gmail + Calendar APIs
- ``client.GoogleAuthError`` / ``GoogleAPIError``: typed exceptions
- ``token_store.TokenStore``: encrypted file persistence for OAuth tokens
- ``token_store.TokenBundle``: the persisted shape (access/refresh/scopes)
- ``oauth.OAuthFlow``: one-shot consent flow with local callback server
- ``routes.router``: FastAPI router for /google/* endpoints

Aura will add a DB-backed multi-tenant TokenStore alongside the
file-backed default. The routes are app-agnostic — they read
``request.app.state.google_client``.
"""

from google_integration.client import (
    GoogleAPIError,
    GoogleAuthError,
    GoogleClient,
)
from google_integration.token_store import TokenBundle, TokenStore
from google_integration.oauth import OAuthFlow
from google_integration import routes

__all__ = [
    "GoogleClient",
    "GoogleAuthError",
    "GoogleAPIError",
    "TokenStore",
    "TokenBundle",
    "OAuthFlow",
    "routes",
]
