from __future__ import annotations

from pathlib import Path
from typing import Annotated

from pydantic import field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


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
    # "openai" (vMLX/LM Studio), "ollama", "anthropic". Default stays
    # local-first; cloud backends are opt-in via .env.
    llm_backend: str = "openai"
    embedding_model: str = "nomic-embed-text"

    # Anthropic cloud LLM — optional alternative to the local stack.
    # Only consulted when llm_backend == "anthropic".
    anthropic_api_key: str = ""
    anthropic_model: str = "claude-sonnet-4-6"
    anthropic_base_url: str = "https://api.anthropic.com"

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
    # STT backend: "local" (mlx-whisper on Apple Silicon) or "remote"
    # (HTTP client for the RTX whisper service defined in spec 007).
    stt_backend: str = "local"
    stt_remote_base_url: str = "http://192.168.15.6:8012"
    stt_remote_timeout: float = 10.0

    # TTS backend: "qwen3" (local Qwen3-TTS) or "elevenlabs" (cloud).
    # Default stays local.
    tts_backend: str = "qwen3"

    # ElevenLabs cloud TTS — optional alternative to Qwen3-TTS.
    # Only consulted when tts_backend == "elevenlabs".
    elevenlabs_api_key: str = ""
    elevenlabs_voice_id: str = ""  # user sets this from their ElevenLabs account
    elevenlabs_model_id: str = "eleven_turbo_v2_5"
    # Server-side speed (0.7..1.2 for turbo_v2_5). Setting this server-side
    # eliminates the need for frontend PLAYBACK_RATE (which caused pitch shift).
    elevenlabs_speed: float = 1.10
    # ElevenLabs "optimize_streaming_latency" knob (0-4). 3 shaves ~400ms
    # off first-chunk latency by disabling the text normalizer; good for
    # realtime voice. Bump to 4 for maximum speed, 0 for best quality.
    elevenlabs_optimize_latency: int = 3
    # Voice stability (0..1). Lower = snappier/more expressive start,
    # higher = more conservative. 0.35 is a good low-latency default.
    elevenlabs_stability: float = 0.35

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
    # Streaming TTS server port (Qwen3-TTS-streaming). If set, uses
    # /v1/audio/voice-clone-stream for real-time chunked audio (~25ms TTFB).
    # Falls back to non-streaming /v1/audio/voice-clone if unavailable.
    tts_streaming_port: int = 8013

    # WhatsApp bridge — leave url empty to disable entirely
    whatsapp_bridge_url: str = ""

    # MCP (Supertasks) integration — leave url empty to disable
    mcp_url: str = ""
    mcp_api_key: str = ""

    cors_origins: list[str] = ["*"]

    # Bootstrap / service orchestration — consumed by seraphine.bootstrap
    cloudflared_tunnel_id: str = ""  # empty = skip tunnel startup

    allowed_tool_roots: list[Path] = [Path.home()]

    # Directory where the LLM logs skill gap requests (via the
    # request_skill meta-tool). One markdown file per skill, keyed by
    # slug. Tracked in git so the backlog is reviewable.
    skills_dir: Path = Path("../skills")

    # ------------------------------------------------------------------
    # Google Workspace (Calendar + Gmail) — optional
    # ------------------------------------------------------------------
    # Leave client_id/client_secret empty to disable the integration
    # entirely. See specs/006-google-integration.md.
    google_client_id: str = ""
    google_client_secret: str = ""
    google_oauth_port: int = 8765
    google_scopes: Annotated[list[str], NoDecode] = [
        "https://www.googleapis.com/auth/calendar.readonly",
        "https://www.googleapis.com/auth/calendar.events",
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.send",
    ]
    google_token_path: Path = Path.home() / ".seraphine" / "google_tokens.enc"

    @field_validator("google_scopes", mode="before")
    @classmethod
    def _split_google_scopes(cls, v):  # type: ignore[no-untyped-def]
        """Accept a comma- or space-separated string from .env.

        pydantic-settings defaults to JSON parsing for list[str] fields
        which is awkward for env files. A plain comma-separated value
        like ``a,b,c`` is more natural and matches the shape the user
        actually wrote in .env.
        """
        if isinstance(v, str):
            s = v.strip()
            if not s:
                return []
            # Allow either commas or whitespace as the separator.
            parts: list[str] = []
            for chunk in s.split(","):
                parts.extend(p for p in chunk.split() if p)
            return parts
        return v


settings = Settings()
