"""Google integration for Aura (multi-tenant OAuth).

Per-user DBTokenStore + web redirect flow. The UI's GoogleCalendarChip
drives ``/google/connect`` → consent popup → ``/google/oauth/callback``
which persists tokens and ``postMessage``s the opener.
"""

from aura.google.routes import router
from aura.google.service import GoogleAuthService, GoogleOAuthError

__all__ = ["router", "GoogleAuthService", "GoogleOAuthError"]
