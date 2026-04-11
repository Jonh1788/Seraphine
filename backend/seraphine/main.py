from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

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

    if settings.llm_backend == "openai":
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

    tools = build_default_registry(
        allowed_roots=list(settings.allowed_tool_roots),
        skills_dir=settings.skills_dir,
        store=store,
        google_client=google_client,
    )
    # ------------------------------------------------------------------
    # MCP (Supertasks) integration — optional
    # ------------------------------------------------------------------
    mcp_client = None
    if settings.mcp_url:
        from seraphine.tools.mcp_client import McpClient
        from seraphine.tools.mcp_tools import register_mcp_tools

        mcp_client = McpClient(
            base_url=settings.mcp_url,
            api_key=settings.mcp_api_key,
        )
        try:
            n = await register_mcp_tools(tools, mcp_client)
            logger.info("Registered %d MCP tools from %s", n, settings.mcp_url)
        except Exception as e:
            logger.warning("MCP tool registration failed (continuing without): %s", e)
            await mcp_client.aclose()
            mcp_client = None

    engine = ConversationEngine(llm, store, memory=memory, tools=tools)
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
    # Local STT for the mic path. Lazy-loads mlx-whisper + model on
    # first transcribe() call so backend startup isn't blocked.
    stt = WhisperSTT(model=settings.stt_model, language=settings.stt_language)
    logger.info(
        "WhisperSTT wired (model=%s language=%s)",
        settings.stt_model,
        settings.stt_language,
    )
    # Warmup: transcribe a tiny silent PCM so mlx-whisper imports + loads
    # model weights before the first real mic input. ~5s one-time cost.
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
    # Connected WS clients — the event listener pushes notifications here
    app.state.ws_clients: set = set()

    logger.info("Seraphine lifespan started (model=%s)", settings.llm_model)
    try:
        yield
    finally:
        if mcp_event_listener is not None:
            await mcp_event_listener.stop()
        await llm.aclose()
        await embeddings.aclose()
        await tts.aclose()
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

    logger.info("Seraphine app initialized (model=%s)", settings.llm_model)
    return app


app = create_app()
