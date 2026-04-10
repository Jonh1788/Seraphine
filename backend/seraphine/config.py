from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="SERAPHINE_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    ollama_base_url: str = "http://localhost:11434"
    llm_model: str = "gemma4:e4b"
    embedding_model: str = "nomic-embed-text"

    sqlite_path: Path = Path("../data/seraphine.sqlite")
    chroma_path: Path = Path("../data/chroma")

    # TTS server. Currently the custom Qwen3-TTS-12Hz-1.7B-Base wrapper
    # at the RTX box, which exposes its own /v1/audio/voice-clone shape
    # with pre-registered voice aliases (the speaker x-vector is
    # pre-computed server-side from the mounted reference audio).
    tts_base_url: str = "http://192.168.15.6:8011"
    tts_voice: str = "dubgrav"
    tts_language: str = "Portuguese"
    tts_x_vector_only_mode: bool = True

    cors_origins: list[str] = ["http://localhost:5173"]

    allowed_tool_roots: list[Path] = [Path.home()]

    # Directory where the LLM logs skill gap requests (via the
    # request_skill meta-tool). One markdown file per skill, keyed by
    # slug. Tracked in git so the backlog is reviewable.
    skills_dir: Path = Path("../skills")


settings = Settings()
