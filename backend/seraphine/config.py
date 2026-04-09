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

    # TTS server (OpenAI-compatible /v1/audio/speech). The same adapter
    # talks to either:
    #   - vllm-omni serving mistralai/Voxtral-4B-TTS-2603 (CUDA box, raw
    #     audio/pcm chunked body) — current default, fastest path.
    #   - second-state/voxtral_tts_rs Rust server (Apple Silicon MLX, SSE
    #     base64) — set tts_base_url=http://localhost:7860 and
    #     tts_model=voxtral-4b-tts.
    #   - mlx-omni-server, Mistral hosted API, or any other OpenAI-compat
    #     TTS — only the URL/model/voice change.
    tts_base_url: str = "http://192.168.15.6:8000"
    tts_voice: str = "pt_female"
    tts_model: str = "mistralai/Voxtral-4B-TTS-2603"
    # Optional voice cloning reference. WAV file (any sample rate, will be
    # passed through verbatim as base64 data URL). Set to None to use the
    # bare preset voice from `tts_voice`.
    tts_ref_audio_path: Path | None = Path("../data/voice-samples/seraphine_ref.wav")

    cors_origins: list[str] = ["http://localhost:5173"]

    allowed_tool_roots: list[Path] = [Path.home()]


settings = Settings()
