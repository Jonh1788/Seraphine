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

    # TTS server (OpenAI-compatible /v1/audio/speech). Default is the local
    # voxtral_tts_rs server (second-state/voxtral_tts_rs) which serves Voxtral
    # 4B TTS via MLX on Apple Silicon. Same adapter works against the Mistral
    # hosted API or any OpenAI-compatible TTS endpoint — only the URL changes.
    tts_base_url: str = "http://localhost:7860"
    tts_voice: str = "pt_female"
    tts_model: str = "voxtral-4b-tts"

    cors_origins: list[str] = ["http://localhost:5173"]

    allowed_tool_roots: list[Path] = [Path.home()]


settings = Settings()
