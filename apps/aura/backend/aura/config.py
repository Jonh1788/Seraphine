"""Settings — read from environment / .env via pydantic-settings.

Keep this thin. All app wiring reads from a single Settings instance so
swapping providers (e.g., DB path, JWT secret) is one env-var change
and never a code edit.
"""

from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
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


settings = Settings()
