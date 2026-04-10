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
    llm_base_url: str = "http://localhost:1234"
    llm_model: str = "gemma-4-26b-a4b-jang_4m-crack"
    llm_backend: str = "openai"  # "ollama" or "openai" (vMLX, LM Studio etc)
    embedding_model: str = "nomic-embed-text"

    sqlite_path: Path = Path("../data/seraphine.sqlite")
    chroma_path: Path = Path("../data/chroma")

    # TTS server. Currently the custom Qwen3-TTS-12Hz-1.7B-Base wrapper
    # at the RTX box, which exposes its own /v1/audio/voice-clone shape
    # with pre-registered voice aliases (the speaker x-vector is
    # pre-computed server-side from the mounted reference audio).
    # Local STT (mic input → text). Uses mlx-whisper, runs on MLX /
    # Metal on Apple Silicon. First call downloads the model weights
    # from Hugging Face to ~/.cache/huggingface/hub.
    stt_model: str = "mlx-community/whisper-small-mlx-q4"
    stt_language: str = "pt"

    tts_base_url: str = "http://192.168.15.6:8011"
    tts_voice: str = "dubgrav"
    tts_language: str = "Portuguese"
    tts_x_vector_only_mode: bool = False
    # Transcrição do áudio de referência do voice alias (necessária em ICL mode,
    # i.e. x_vector_only_mode=False). Deve casar literalmente com o que é falado
    # no WAV de referência montado no servidor sob o nome `tts_voice`.
    tts_ref_text: str = ""
    tts_max_new_tokens: int = 512
    tts_temperature: float = 0.85
    tts_top_k: int = 65
    tts_repetition_penalty: float = 1.05
    tts_seed: int = 42

    # MCP (Supertasks) integration — leave url empty to disable
    mcp_url: str = ""
    mcp_api_key: str = ""

    cors_origins: list[str] = ["*"]

    allowed_tool_roots: list[Path] = [Path.home()]

    # Directory where the LLM logs skill gap requests (via the
    # request_skill meta-tool). One markdown file per skill, keyed by
    # slug. Tracked in git so the backlog is reviewable.
    skills_dir: Path = Path("../skills")


settings = Settings()
