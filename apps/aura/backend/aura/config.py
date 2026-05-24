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
    anthropic_model: str = "claude-sonnet-4-6"
    anthropic_base_url: str = "https://api.anthropic.com"

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

    # --- STT (speech-to-text)
    # Provider: "groq" (cloud whisper-large-v3-turbo, ~250 ms / 30 s) or
    # "local" (faster-whisper on CPU). main.py picks Groq when the key is
    # present and provider != "local"; otherwise it falls back to local.
    stt_provider: str = "groq"
    groq_api_key: str = ""
    groq_stt_model: str = "whisper-large-v3-turbo"
    # Local-backend knobs (used when stt_provider == "local" or when
    # Groq is selected but no key is configured).
    # The model is lazy-loaded on the first /chat/transcribe call so
    # startup isn't blocked by a ~500MB download. Swap `whisper_model`
    # for "tiny" / "base" / "medium" / "large-v3" as capacity grows.
    whisper_model: str = "small"
    whisper_compute_type: str = "int8"
    whisper_cache_dir: Path = Path("/data/whisper-models")

    # --- WhatsApp
    # backend: "bridge" (whatsapp-web.js, default) or "evolution"
    # (Baileys-based Evolution API). Bridge is the operational default
    # because Evolution v2 + current Baileys can't complete the WA Web
    # handshake on this VPS.
    whatsapp_backend: str = "bridge"
    # Service name was renamed in compose to avoid DNS alias collision
    # with seraphine's own bridge on the shared seraphine-net.
    whatsapp_bridge_url: str = "http://aura-whatsapp-bridge:3001"
    whatsapp_admin_token: str = ""

    # --- WhatsApp (Evolution API — kept available behind the backend switch)
    evolution_base_url: str = ""
    evolution_api_key: str = ""
    evolution_instance: str = ""
    evolution_webhook_token: str = ""

    @property
    def whatsapp_configured(self) -> bool:
        """True iff the chosen WhatsApp backend has its required env set.

        - bridge: always available (built into the compose stack)
        - evolution: needs base_url + api_key + instance. The webhook
          token is optional (v2 doesn't reliably propagate it).
        """
        if self.whatsapp_backend == "bridge":
            return bool(self.whatsapp_bridge_url)
        return bool(
            self.evolution_base_url
            and self.evolution_api_key
            and self.evolution_instance
        )


settings = Settings()
