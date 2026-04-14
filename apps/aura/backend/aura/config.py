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
    # via a single env var. Defaults cover calendar read + write + gmail
    # modify (mirrors Seraphine's default set).
    google_scopes: str = (
        "https://www.googleapis.com/auth/calendar.readonly "
        "https://www.googleapis.com/auth/calendar.events "
        "https://www.googleapis.com/auth/gmail.modify"
    )


settings = Settings()
