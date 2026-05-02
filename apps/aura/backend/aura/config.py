"""Settings — read from environment / .env via pydantic-settings.

Keep this thin. All app wiring reads from a single Settings instance so
swapping providers (e.g., DB path, JWT secret) is one env-var change
and never a code edit.
"""

from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# Resolve .env relative to this file (apps/aura/backend/aura/config.py
# → apps/aura/backend/.env), not the process cwd. Avoids the silent
# "key not loaded" symptom when uvicorn is started from a parent dir.
_ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(_ENV_FILE),
        env_file_encoding="utf-8",
        env_prefix="AURA_",
        case_sensitive=False,
        extra="ignore",
    )

    # --- Server
    host: str = "0.0.0.0"
    port: int = 8001
    reload: bool = False

    # --- Storage
    sqlite_path: Path = Path("./data/aura.sqlite")

    # --- Auth
    # MUST be set in production. Default lets dev/test boot without
    # forcing every developer to invent a secret; production enforce
    # via a real value or refuse to start.
    jwt_secret: str = "dev-only-do-not-use-in-prod"
    jwt_expires_seconds: int = 60 * 60 * 24 * 7  # 7 days

    # --- LLM
    anthropic_api_key: str = ""
    anthropic_model: str = "claude-sonnet-4-5"

    # --- Google OAuth (multi-tenant, web redirect flow)
    # If client_id or client_secret is empty, /google/connect returns
    # 501 so the frontend chip renders a helpful hint instead of
    # crashing. The redirect URL must match EXACTLY what is registered
    # in the Google Cloud console for this OAuth client.
    google_client_id: str = ""
    google_client_secret: str = ""
    google_oauth_redirect_url: str = (
        "http://localhost:8001/google/oauth/callback"
    )
    # Scopes requested on consent. Space-separated so ops can override
    # via a single env var.
    #
    # Defaults cover Calendar read + write plus the openid/email/profile
    # set needed to fetch the user's email address via userinfo. Gmail
    # was intentionally dropped — gmail.modify / gmail.readonly are
    # restricted scopes (Google demands a CASA audit to publish), and
    # Aura doesn't have a Gmail feature yet. Add it back if/when the
    # inbox UI lands and a separate verification track starts.
    google_scopes: str = (
        "openid "
        "email "
        "profile "
        "https://www.googleapis.com/auth/calendar.readonly "
        "https://www.googleapis.com/auth/calendar.events"
    )

    # --- Push notifications (VAPID)
    # When private/public are empty, an ephemeral pair is generated on
    # boot — fine for dev, NOT for prod (browser subscriptions break on
    # restart because the public key changes). Generate a stable pair
    # once with `uv run python -m aura.push.gen_keys` and persist the
    # output in the prod env.
    vapid_subject: str = "mailto:contact@minha-aura.com"
    vapid_private_pem: str = ""
    vapid_public_b64: str = ""

    # --- STT (speech-to-text) — faster-whisper
    # The model is lazy-loaded on the first /chat/transcribe call so
    # startup isn't blocked by a ~500MB download. Swap `whisper_model`
    # for "tiny" / "base" / "medium" / "large-v3" as capacity grows.
    whisper_model: str = "small"
    whisper_compute_type: str = "int8"
    whisper_cache_dir: Path = Path("/data/whisper-models")

    # --- WhatsApp (Evolution API)
    evolution_base_url: str = ""
    evolution_api_key: str = ""
    evolution_instance: str = ""
    evolution_webhook_token: str = ""
    whatsapp_admin_token: str = ""

    @property
    def whatsapp_configured(self) -> bool:
        """True iff the core Evolution env vars are non-empty.

        Why: ``evolution_webhook_token`` is treated as optional. Evolution
        v2.1.0 doesn't reliably attach WEBHOOK_GLOBAL_HEADERS to outgoing
        events, so the webhook auth gate degrades to "any inbound" when
        the token is empty. The router still 401s when the token IS set
        and the inbound header doesn't match (defense in depth).
        """
        return bool(
            self.evolution_base_url
            and self.evolution_api_key
            and self.evolution_instance
        )


settings = Settings()
