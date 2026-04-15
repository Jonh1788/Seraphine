"""google-integration — OAuth + Gmail + Calendar client.

Public surface:
- ``client.GoogleClient``: HTTP client wrapping Gmail + Calendar APIs
- ``client.GoogleAuthError`` / ``GoogleAPIError``: typed exceptions
- ``token_store.FileTokenStore``: encrypted on-disk token persistence
  (Seraphine). ``TokenStore`` remains as a back-compat alias.
- ``token_store.TokenStoreProtocol``: the common contract every store
  implements (load/save/clear).
- ``token_store.TokenBundle``: the persisted shape
  (access/refresh/scopes).
- ``db_token_store.DBTokenStore``: per-user SQLite-backed token store
  (Aura).
- ``oauth.OAuthFlow``: one-shot loopback consent flow (Seraphine).
- ``oauth.WebOAuthFlow``: server-side web redirect consent flow (Aura).
- ``routes.router``: FastAPI router for Seraphine's /google/* endpoints
  (import explicitly — it depends on ``seraphine.config`` and so is
  only usable inside Seraphine, not Aura).
"""

from google_integration.client import (
    GoogleAPIError,
    GoogleAuthError,
    GoogleClient,
)
from google_integration.db_token_store import DBTokenStore
from google_integration.oauth import OAuthFlow, WebOAuthFlow
from google_integration.token_store import (
    FileTokenStore,
    TokenBundle,
    TokenStore,
    TokenStoreProtocol,
)

# Note: ``routes`` is NOT re-exported here — it eagerly imports
# ``seraphine.config`` and would break Aura's container, which doesn't
# ship the Seraphine app. Seraphine imports it directly via
# ``from google_integration.routes import router``.

__all__ = [
    "GoogleClient",
    "GoogleAuthError",
    "GoogleAPIError",
    "FileTokenStore",
    "TokenStore",
    "TokenStoreProtocol",
    "TokenBundle",
    "DBTokenStore",
    "OAuthFlow",
    "WebOAuthFlow",
]
