from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from seraphine.config import settings
from seraphine.conversation.audio_engine import AudioEngine
from seraphine.conversation.engine import ConversationEngine
from seraphine.llm.client import OllamaClient, OpenAICompatClient
from seraphine.memory.embeddings import OllamaEmbeddings
from seraphine.memory.manager import MemoryManager
from seraphine.memory.store import MemoryStore
from seraphine.stt.whisper import WhisperSTT
from seraphine.tools.registry import build_default_registry
from seraphine.tts.qwen3 import Qwen3TtsAdapter
from seraphine.conversation.routes import router as conversation_router
from seraphine.google.routes import router as google_router
from seraphine.memory.routes import router as memory_router
from seraphine.ws.routes import router as ws_router

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("seraphine")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    store = MemoryStore(settings.sqlite_path)
    await store.ensure_schema()

    if settings.llm_backend in ("anthropic", "claude_max"):
        from seraphine.llm.anthropic import AnthropicClient

        if settings.llm_backend == "claude_max":
            from seraphine.llm.keychain import get_access_token, KeychainError

            try:
                api_key = get_access_token()
            except KeychainError as e:
                raise RuntimeError(
                    f"SERAPHINE_LLM_BACKEND=claude_max but Keychain read failed: {e}. "
                    f"Make sure Claude Code is installed and you're logged in."
                ) from e
            logger.info(
                "Using Claude Max backend via Keychain OAuth (model=%s)",
                settings.anthropic_model,
            )
        else:
            if not settings.anthropic_api_key:
                raise RuntimeError(
                    "SERAPHINE_LLM_BACKEND=anthropic but SERAPHINE_ANTHROPIC_API_KEY is empty"
                )
            api_key = settings.anthropic_api_key
            logger.info(
                "Using Anthropic API backend (model=%s)", settings.anthropic_model
            )
        llm = AnthropicClient(
            api_key=api_key,
            model=settings.anthropic_model,
            base_url=settings.anthropic_base_url,
        )
    elif settings.llm_backend == "openai":
        llm = OpenAICompatClient(settings.llm_base_url, settings.llm_model)
        logger.info("Using OpenAI-compatible backend (vMLX/LM Studio) at %s", settings.llm_base_url)
    else:
        llm = OllamaClient(settings.ollama_base_url, settings.llm_model)
    try:
        from seraphine.conversation.engine import DEFAULT_SYSTEM_PROMPT
        await llm.warmup(system_prompt=DEFAULT_SYSTEM_PROMPT)
        logger.info("LLM warmup complete — system prompt cached (model=%s)", settings.llm_model)
    except Exception as e:
        logger.warning("LLM warmup failed (continuing anyway): %s", e)
    embeddings = OllamaEmbeddings(settings.ollama_base_url, settings.embedding_model)
    memory = MemoryManager(store, embeddings, settings.chroma_path, llm=llm)
    try:
        await memory.start()
    except Exception as e:
        logger.warning("MemoryManager.start() failed: %s", e)

    # ------------------------------------------------------------------
    # Google Workspace integration — optional
    # ------------------------------------------------------------------
    google_client = None
    if settings.google_client_id and settings.google_client_secret:
        from seraphine.google.client import GoogleClient
        from seraphine.google.token_store import TokenStore

        token_store = TokenStore(settings.google_token_path)
        google_client = GoogleClient(
            token_store=token_store,
            client_id=settings.google_client_id,
            client_secret=settings.google_client_secret,
            scopes=settings.google_scopes,
        )
        logger.info(
            "Google client wired (token_path=%s)", settings.google_token_path
        )

    # ------------------------------------------------------------------
    # WhatsApp bridge integration — optional
    # ------------------------------------------------------------------
    whatsapp_client = None
    if settings.whatsapp_bridge_url:
        from seraphine.whatsapp.client import WhatsAppBridgeClient

        whatsapp_client = WhatsAppBridgeClient(
            base_url=settings.whatsapp_bridge_url,
        )
        logger.info(
            "WhatsApp bridge client wired (url=%s)", settings.whatsapp_bridge_url
        )

    # ------------------------------------------------------------------
    # Wise (TransferWise) integration — optional
    # ------------------------------------------------------------------
    wise_client = None
    if settings.wise_api_key:
        from seraphine.wise.client import WiseClient

        wise_client = WiseClient(
            api_key=settings.wise_api_key,
            profile_id=settings.wise_profile_id,
            sandbox=settings.wise_sandbox,
        )
        logger.info(
            "Wise client wired (sandbox=%s, profile_id=%s)",
            settings.wise_sandbox,
            settings.wise_profile_id or "auto-detect",
        )

    # ------------------------------------------------------------------
    # Browser automation integration — optional
    # ------------------------------------------------------------------
    browser_client = None
    if settings.browser_agent_url:
        from seraphine.browser.client import BrowserAgentClient

        browser_client = BrowserAgentClient(
            base_url=settings.browser_agent_url,
        )
        logger.info(
            "Browser agent client wired (url=%s)", settings.browser_agent_url
        )

    tools = build_default_registry(
        allowed_roots=list(settings.allowed_tool_roots),
        skills_dir=settings.skills_dir,
        store=store,
        google_client=google_client,
        whatsapp_client=whatsapp_client,
        browser_client=browser_client,
        wise_client=wise_client,
    )
    # ------------------------------------------------------------------
    # MCP (Supertasks) integration — optional
    # ------------------------------------------------------------------
    mcp_client = None
    mcp_tools_watcher = None
    if settings.mcp_url:
        from seraphine.tools.mcp_client import McpClient
        from seraphine.tools.mcp_tools import register_mcp_tools, start_tools_changed_watcher

        mcp_client = McpClient(
            base_url=settings.mcp_url,
            api_key=settings.mcp_api_key,
        )
        try:
            n = await register_mcp_tools(tools, mcp_client)
            logger.info("Registered %d MCP tools from %s", n, settings.mcp_url)
            # Watch for tools/list_changed so new tools appear without restart
            events_url = settings.mcp_url.rstrip("/").rsplit("/", 1)[0] + "/events"
            mcp_tools_watcher = start_tools_changed_watcher(
                tools, mcp_client, events_url, settings.mcp_api_key,
            )
        except Exception as e:
            logger.warning("MCP tool registration failed (continuing without): %s", e)
            await mcp_client.aclose()
            mcp_client = None

    engine = ConversationEngine(llm, store, memory=memory, tools=tools)
    if settings.tts_backend == "elevenlabs":
        from seraphine.tts.elevenlabs import ElevenLabsAdapter

        if not settings.elevenlabs_api_key:
            raise RuntimeError(
                "SERAPHINE_TTS_BACKEND=elevenlabs but SERAPHINE_ELEVENLABS_API_KEY is empty"
            )
        if not settings.elevenlabs_voice_id:
            raise RuntimeError(
                "SERAPHINE_TTS_BACKEND=elevenlabs but SERAPHINE_ELEVENLABS_VOICE_ID is empty"
            )
        tts = ElevenLabsAdapter(
            api_key=settings.elevenlabs_api_key,
            voice_id=settings.elevenlabs_voice_id,
            model_id=settings.elevenlabs_model_id,
            speed=settings.elevenlabs_speed,
            optimize_streaming_latency=settings.elevenlabs_optimize_latency,
            stability=settings.elevenlabs_stability,
        )
        logger.info(
            "ElevenLabs TTS adapter wired (voice_id=%s model_id=%s)",
            settings.elevenlabs_voice_id,
            settings.elevenlabs_model_id,
        )
    else:
        tts = Qwen3TtsAdapter(
            settings.tts_base_url,
            default_voice=settings.tts_voice,
            language=settings.tts_language,
            x_vector_only_mode=settings.tts_x_vector_only_mode,
            ref_text=settings.tts_ref_text,
            max_new_tokens=settings.tts_max_new_tokens,
            temperature=settings.tts_temperature,
            top_k=settings.tts_top_k,
            repetition_penalty=settings.tts_repetition_penalty,
            seed=settings.tts_seed,
            streaming_port=settings.tts_streaming_port or None,
        )
        logger.info(
            "Qwen3-TTS adapter wired (base_url=%s voice=%s)",
            settings.tts_base_url,
            settings.tts_voice,
        )
    # STT backend: local MLX Whisper on Apple Silicon or remote HTTP
    # service on the RTX box (spec 007). Toggle via SERAPHINE_STT_BACKEND.
    stt: Any
    if settings.stt_backend == "remote":
        from seraphine.stt.remote import RemoteWhisperSTT

        stt = RemoteWhisperSTT(
            base_url=settings.stt_remote_base_url,
            language=settings.stt_language,
            timeout=settings.stt_remote_timeout,
        )
        logger.info(
            "RemoteWhisperSTT wired (base_url=%s language=%s)",
            settings.stt_remote_base_url,
            settings.stt_language,
        )
        try:
            await stt.warmup()
        except Exception as e:
            logger.warning("RemoteWhisperSTT warmup failed: %s", e)
    else:
        # Local MLX Whisper. Lazy-loads mlx-whisper + model on first
        # transcribe() call so backend startup isn't blocked.
        stt = WhisperSTT(
            model=settings.stt_model, language=settings.stt_language
        )
        logger.info(
            "WhisperSTT wired (model=%s language=%s)",
            settings.stt_model,
            settings.stt_language,
        )
        # Warmup: transcribe a tiny silent PCM so mlx-whisper imports +
        # loads model weights before first real input. ~5s one-time cost.
        try:
            await stt.transcribe(b"\x00" * 3200, sample_rate=16000)  # 100ms silence
            logger.info("WhisperSTT warmup complete")
        except Exception as e:
            logger.warning("WhisperSTT warmup failed (continuing anyway): %s", e)
    audio_engine = AudioEngine(llm, tts, store, stt=stt, engine=engine)

    # ------------------------------------------------------------------
    # MCP SSE event listener — proactive notifications
    # ------------------------------------------------------------------
    mcp_event_listener = None
    if mcp_client is not None and settings.mcp_url:
        from seraphine.tools.mcp_events import McpEventListener

        events_url = settings.mcp_url.rsplit("/", 1)[0] + "/events"
        mcp_event_listener = McpEventListener(
            events_url=events_url,
            api_key=settings.mcp_api_key,
        )
        mcp_event_listener.start()

    app.state.store = store
    app.state.llm = llm
    app.state.embeddings = embeddings
    app.state.memory = memory
    app.state.engine = engine
    app.state.tts = tts
    app.state.audio_engine = audio_engine
    app.state.tools = tools
    app.state.mcp_client = mcp_client
    app.state.mcp_event_listener = mcp_event_listener
    app.state.google_client = google_client
    app.state.whatsapp_client = whatsapp_client
    app.state.browser_client = browser_client
    app.state.wise_client = wise_client
    # Connected WS clients — the event listener pushes notifications here
    app.state.ws_clients: set = set()

    logger.info("Seraphine lifespan started (model=%s)", settings.llm_model)
    try:
        yield
    finally:
        if mcp_tools_watcher is not None:
            mcp_tools_watcher.cancel()
            try:
                await mcp_tools_watcher
            except BaseException:
                pass
        if mcp_event_listener is not None:
            await mcp_event_listener.stop()
        await llm.aclose()
        await embeddings.aclose()
        await tts.aclose()
        if whatsapp_client is not None:
            await whatsapp_client.aclose()
        if browser_client is not None:
            await browser_client.aclose()
        if wise_client is not None:
            await wise_client.aclose()
        if mcp_client is not None:
            await mcp_client.aclose()


def create_app() -> FastAPI:
    app = FastAPI(title="Seraphine", version="0.1.0", lifespan=lifespan)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    app.include_router(conversation_router)
    app.include_router(memory_router)
    app.include_router(ws_router)
    app.include_router(google_router)

    if settings.whatsapp_bridge_url:
        from seraphine.whatsapp.routes import router as whatsapp_router

        app.include_router(whatsapp_router)

    logger.info("Seraphine app initialized (model=%s)", settings.llm_model)
    return app


app = create_app()
