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
    ollama_num_ctx: int | None = None
    ollama_num_batch: int = 2048
    llm_base_url: str = "http://localhost:1234"
    llm_model: str = "gemma-4-26b-a4b-jang_4m-crack"
    # "openai" (vMLX/LM Studio), "ollama", "anthropic", "claude_max".
    # claude_max reads the OAuth token from macOS Keychain (Claude Code
    # login) and uses the Max subscription with 20× higher rate limits
    # and zero API cost. Default stays local-first.
    llm_backend: str = "openai"
    # Official local Codex CLI; an empty model uses the CLI's default.
    codex_model: str = ""
    codex_executable: str = "codex"
    embedding_model: str = "nomic-embed-text"

    # Anthropic cloud LLM — optional alternative to the local stack.
    # Only consulted when llm_backend == "anthropic".
    anthropic_api_key: str = ""
    anthropic_model: str = "claude-haiku-4-5-20251001"
    anthropic_base_url: str = "https://api.anthropic.com"
    # Smart model routing: set to a stronger model (e.g. claude-sonnet-4-6)
    # to auto-escalate on complex turns (tool calls, vision, thinking).
    # Leave empty to always use anthropic_model.
    anthropic_smart_model: str = ""

    # Cost-aware routing: daily USD cap on *metered* (cloud) spend. When the
    # last-24h metered spend reaches this, the router refuses to escalate to the
    # metered smart model and stays on the cheap/local default. <= 0 disables.
    routing_daily_cap_usd: float = 0.0

    sqlite_path: Path = Path("../data/seraphine.sqlite")
    chroma_path: Path = Path("../data/chroma")

    # TTS server. Currently the custom Qwen3-TTS-12Hz-1.7B-Base wrapper
    # at the RTX box, which exposes its own /v1/audio/voice-clone shape
    # with pre-registered voice aliases (the speaker x-vector is
    # pre-computed server-side from the mounted reference audio).
    # Local STT (mic input → text). Uses mlx-whisper, runs on MLX /
    # Metal on Apple Silicon. First call downloads the model weights
    # from Hugging Face to ~/.cache/huggingface/hub.
    stt_model: str = "mlx-community/whisper-small-mlx"
    stt_language: str = "pt"
    # STT backend: "local" (mlx-whisper on Apple Silicon), "faster_whisper"
    # (Windows/Linux CPU int8; install the windows extra), or "remote"
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
    # Aura's bridge (joins seraphine-net so the unified Manager UI
    # at /wa can list both side-by-side). Empty hides the second card.
    whatsapp_aura_bridge_url: str = "http://aura-whatsapp-bridge:3001"

    # Email urgency triage → WhatsApp push (all-Seraphine).
    # Background scanner classifies new unread Gmail and pushes a
    # WhatsApp message for genuinely-urgent ("high") mail only.
    email_urgency_enabled: bool = True
    email_urgency_interval_s: int = 600  # 10 min
    email_urgency_quiet_start: str = "22:00"  # America/Sao_Paulo, "HH:MM"
    email_urgency_quiet_end: str = "07:00"
    # Destination chat-id for the push. The user's own WhatsApp number
    # (already referenced in whatsapp/_USER_MENTIONS). Override via
    # SERAPHINE_OWNER_WHATSAPP_CHAT_ID. Empty disables the push (the
    # scan still classifies + records).
    owner_whatsapp_chat_id: str = "557388836445@c.us"
    # Public base URL the deep-link points at (the web frontend).
    app_public_url: str = "https://sera.jonhdev.io"

    # Scheduled whole-store memory consolidation/audit pass. Merges
    # paraphrased facts and drops clear junk across the WHOLE store
    # (coarser complement to per-write dedup). Cheap to run thanks to a
    # fingerprint short-circuit, so a daily cadence is plenty.
    memory_audit_interval_s: int = 86400  # 24h

    # Learning-loop candidate gate. Thresholds live here (NOT in the knob
    # registry) because the optimizer proposes knobs — it must not tune its own
    # gate. A candidate is surfaced as 'pending' only if it BEATS the active
    # policy by learning_min_margin on the (repeated) eval; below that → rejected.
    learning_min_margin: float = 0.05
    learning_min_traces: int = 5
    learning_min_convs: int = 2
    learning_eval_repeats: int = 2

    # Scheduled read-only "LLM wiki" build pass (Karpathy pattern): synthesizes
    # /data/wiki markdown from new deepsearch runs + captured attachments +
    # people. Daily cadence; watermark short-circuits when nothing is new.
    wiki_build_interval_s: int = 86400  # 24h

    # Browser automation — leave url empty to disable
    browser_agent_url: str = ""  # "http://localhost:3002"

    # MCP (Supertasks) integration — leave url empty to disable
    mcp_url: str = ""
    mcp_api_key: str = ""

    cors_origins: Annotated[list[str], NoDecode] = ["*"]

    # 024 — proactive scheduler kill switch. Silences day-review,
    # weekly reflection, and stalled-task jobs when False.
    proactive_enabled: bool = True

    # 068 — image generation. Switch provider via SERAPHINE_IMAGE_PROVIDER
    # ("fal" | "replicate"); set the matching API key. The image_model_*
    # defaults adapt to the provider in ImageGenService.__init__, so for
    # the standard FLUX path you only need to set the provider + token.
    image_provider: str = "fal"
    fal_api_key: str = ""
    replicate_api_token: str = ""
    image_model_fast: str = ""  # provider-default if blank
    image_model_hq: str = ""    # provider-default if blank
    image_daily_budget_usd: float = 5.0
    image_storage_dir: str = "~/.seraphine/images"

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
    # When set, the backend uses the web-redirect OAuth flow
    # (``/google/oauth/callback`` on this server) instead of binding a
    # local loopback server on ``google_oauth_port``. Required when the
    # backend runs remotely (VPS) — the loopback flow only works when
    # backend + browser share a localhost. Leave empty for the legacy
    # Mac-local flow.
    google_oauth_redirect_url: str = ""
    google_scopes: Annotated[list[str], NoDecode] = [
        "https://www.googleapis.com/auth/calendar.readonly",
        "https://www.googleapis.com/auth/calendar.events",
        # gmail.modify supersets gmail.readonly (read + label changes +
        # trash/untrash) and is required by /messages/{id}/modify, which
        # powers the "mark as read" action. It does NOT grant full
        # access; gmail.send below covers outbound.
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/gmail.send",
    ]
    google_token_path: Path = Path.home() / ".seraphine" / "google_tokens.enc"

    # ------------------------------------------------------------------
    # Wise (TransferWise) — PIX transfers
    # ------------------------------------------------------------------
    # Leave wise_api_key empty to disable the integration entirely.
    wise_api_key: str = ""
    wise_profile_id: int = 0  # 0 = auto-detect
    wise_sandbox: bool = False

    # ------------------------------------------------------------------
    # Web Push (VAPID) — leave empty to disable push notifications
    # ------------------------------------------------------------------
    vapid_private_key: str = ""
    vapid_public_key: str = ""

    # ------------------------------------------------------------------
    # Agent harness (agents/) — OFF by default. When disabled every
    # /agents route answers 404 and no service/tool is registered.
    # ------------------------------------------------------------------
    agents_enabled: bool = False
    # Browser origins allowed to call /agents (and to read the bootstrap
    # token). CORS is "*" for the rest of the app, so this list is the only
    # thing stopping an arbitrary web page from talking to the harness.
    agents_allowed_origins: Annotated[list[str], NoDecode] = [
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "tauri://localhost",
        "http://tauri.localhost",
    ]
    agents_max_concurrent: int = 3
    agents_command_timeout_s: int = 600
    # Seconds an approval request stays approvable before the harness expires it.
    agents_approval_ttl_s: int = 86400
    # Shutdown: seconds running turns get to finish before the engines are killed
    # (a run cut off stays "running" and the next boot decides what to do).
    agents_shutdown_drain_s: int = 20
    # Automatic resumes of one run after restarts, and the age (seconds since it
    # started) beyond which a run is no longer resumed on its own.
    agents_recovery_max: int = 2
    agents_recovery_max_age_s: int = 21600
    # Parked runs (provider outage, plan limit, expired login): seconds after the
    # first parking before the run gives up; seconds between plan-limit checks when
    # the engine gave no reset time; and the longest wait for a reported reset time.
    agents_park_max_s: int = 86400
    agents_park_plan_poll_s: int = 1800
    agents_park_plan_max_s: int = 691200
    # Messages in the middle of the work: seconds of silence a run created by a
    # message waits before starting (0 = no wait), how many times a new message
    # restarts that wait, and the pending messages one run's inbox holds.
    agents_quiet_window_s: float = 2.5
    agents_quiet_window_max: int = 4
    agents_inbox_max: int = 20
    # Conversation continuity: a new message to an agent resumes its last session in that
    # conversation when the run ended less than ``agents_session_reuse_s`` ago and its last turn
    # used fewer than ``agents_session_reuse_max_tokens`` input tokens; otherwise the agent gets
    # the last ``agents_history_messages`` messages (at most ``agents_history_max_chars`` characters).
    agents_session_reuse_s: int = 3600
    agents_session_reuse_max_tokens: int = 150000
    agents_history_messages: int = 30
    agents_history_max_chars: int = 12000
    # Run limits: actions per run (a warning two before it, then the run fails
    # ``step_limit``); seconds without any engine event, and seconds one engine turn may
    # last, before the harness ends the turn (``engine_silent`` / ``turn_timeout``).
    agents_run_max_actions: int = 200
    agents_engine_silence_s: int = 900
    agents_turn_max_s: int = 10800
    # Codex on native Windows only enforces a writable sandbox when its Windows
    # sandbox level is configured; ``--ignore-user-config`` drops the owner's
    # ``[windows] sandbox`` so the harness passes it explicitly.
    # Allowed: "unelevated" | "elevated".
    agents_codex_windows_sandbox: str = "unelevated"
    # Optional explicit path of the Claude Code CLI (``claude`` / ``claude.exe``).
    # Empty: PATH, then the copy bundled with the Claude desktop app (Windows).
    agents_claude_path: str = ""
    # LM Studio server used by agents (the Ollama one is ``ollama_base_url``).
    agents_lmstudio_base_url: str = "http://localhost:1234"
    # JSON list of extra OpenAI-compatible providers, e.g.
    # [{"id":"meu","label":"Meu","kind":"api_key","base_url":"https://x/v1",
    #   "env_key":"MEU_API_KEY","default_model":"m"}]. API keys are NEVER put
    # here: only the NAME of the environment variable that holds the key.
    agents_extra_providers: str = ""
    # Seraphine tools for agents (3b). The MCP bridge of an engine turn calls the gateway at this
    # address with the turn token, so it must be where THIS backend listens and must be a loopback
    # address (the token never leaves the machine). 8000 is the port ``bootstrap.py`` and the
    # README start uvicorn on; change it when you serve the backend on another port.
    agents_bridge_base_url: str = "http://127.0.0.1:8000"
    agents_bridge_call_timeout_s: int = 30
    # Seconds the bridge has to say "hello" after the engine starts a turn offered tools.
    agents_bridge_hello_timeout_s: int = 10
    agents_bridge_result_max_chars: int = 50000
    # Writes and asking the owner (3c). Seconds the owner may undo an agent's write; seconds a run
    # waits for the owner's answer to a question before it gives up; limit of the real turn the
    # bridge test runs.
    agents_undo_window_s: int = 300
    agents_owner_answer_max_s: int = 86400
    agents_bridge_test_timeout_s: int = 60
    # First steps and ready-made teams (6a). Folder under which every agent gets its own
    # "home" folder (empty: ``<user folder>/Seraphine/agentes``, resolved when used); seconds the
    # assistant's brain has to propose a team; most agents one team creation accepts.
    agents_home_dir: str = ""
    agents_guide_timeout_s: float = 90.0
    agents_team_max: int = 6
    # Routines (6b). Seconds between looks at the clock; how old (seconds) a missed time may be and
    # still run once on return (older ones are recorded as missed); consecutive failures that pause
    # a routine; shortest interval (minutes) between two times; most enabled routines per agent.
    agents_routine_tick_s: float = 30.0
    agents_routine_catchup_s: int = 43200
    agents_routine_fail_pause: int = 5
    agents_routine_min_interval_min: int = 15
    agents_routine_max_active: int = 20
    # Conversation with the guide (6c): seconds a proposal card stays valid; earlier messages given to the
    # brain; characters of one agent's instructions given to the brain.
    agents_proposal_ttl_s: int = 86400
    agents_guide_history: int = 12
    agents_guide_instructions_chars: int = 6000
    # Undo of a freshly created team (6c part 2): seconds the owner has to undo it.
    agents_team_undo_s: int = 86400

    @field_validator("agents_codex_windows_sandbox", mode="before")
    @classmethod
    def _check_codex_windows_sandbox(cls, v):  # type: ignore[no-untyped-def]
        value = str(v or "").strip().lower()
        if value not in ("unelevated", "elevated"):
            raise ValueError("agents_codex_windows_sandbox must be 'unelevated' or 'elevated'")
        return value

    @field_validator("agents_bridge_base_url", mode="before")
    @classmethod
    def _check_bridge_base_url(cls, v):  # type: ignore[no-untyped-def]
        from urllib.parse import urlsplit

        value = str(v or "").strip().rstrip("/")
        host = (urlsplit(value).hostname or "").lower()
        if host not in ("127.0.0.1", "localhost", "::1"):
            raise ValueError("agents_bridge_base_url must be a loopback address (127.0.0.1, localhost or ::1)")
        return value

    @field_validator("agents_allowed_origins", mode="before")
    @classmethod
    def _split_agents_origins(cls, v):  # type: ignore[no-untyped-def]
        """Accept comma-separated origins from .env (same shape as CORS)."""
        if isinstance(v, str):
            return [p.strip() for p in v.split(",") if p.strip()]
        return v

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

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _split_cors_origins(cls, v):  # type: ignore[no-untyped-def]
        """Accept comma-separated origins from .env.

        `SERAPHINE_CORS_ORIGINS=https://a,tauri://localhost` is more
        natural than the JSON-array shape pydantic-settings defaults to.
        A bare `*` remains the library-default when unset.
        """
        if isinstance(v, str):
            s = v.strip()
            if not s:
                return ["*"]
            return [p.strip() for p in s.split(",") if p.strip()]
        return v


settings = Settings()
