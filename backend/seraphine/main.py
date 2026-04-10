from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from seraphine.config import settings
from seraphine.conversation.audio_engine import AudioEngine
from seraphine.conversation.engine import ConversationEngine
from seraphine.llm.client import OllamaClient
from seraphine.memory.embeddings import OllamaEmbeddings
from seraphine.memory.manager import MemoryManager
from seraphine.memory.store import MemoryStore
from seraphine.stt.whisper import WhisperSTT
from seraphine.tools.registry import build_default_registry
from seraphine.tts.qwen3 import Qwen3TtsAdapter
from seraphine.memory.routes import router as memory_router
from seraphine.ws.routes import router as ws_router

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("seraphine")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    store = MemoryStore(settings.sqlite_path)
    await store.ensure_schema()

    llm = OllamaClient(settings.ollama_base_url, settings.llm_model)
    # Warmup: fire a dummy chat so gemma4 is loaded, warm, and KV-cached
    # before the first user turn. Cold model load on Apple Silicon is
    # ~4.5 s for an 8B Q4 — we'd rather pay it here than on the first
    # real interaction.
    try:
        await llm.warmup()
        logger.info("LLM warmup complete (model=%s)", settings.llm_model)
    except Exception as e:
        logger.warning("LLM warmup failed (continuing anyway): %s", e)
    embeddings = OllamaEmbeddings(settings.ollama_base_url, settings.embedding_model)
    memory = MemoryManager(store, embeddings, settings.chroma_path, llm=llm)
    try:
        await memory.start()
    except Exception as e:
        logger.warning("MemoryManager.start() failed: %s", e)

    tools = build_default_registry(
        allowed_roots=list(settings.allowed_tool_roots),
        skills_dir=settings.skills_dir,
    )
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
    audio_engine = AudioEngine(llm, tts, store, stt=stt, engine=engine)

    app.state.store = store
    app.state.llm = llm
    app.state.embeddings = embeddings
    app.state.memory = memory
    app.state.engine = engine
    app.state.tts = tts
    app.state.audio_engine = audio_engine
    app.state.tools = tools

    logger.info("Seraphine lifespan started (model=%s)", settings.llm_model)
    try:
        yield
    finally:
        await llm.aclose()
        await embeddings.aclose()
        await tts.aclose()


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

    app.include_router(memory_router)
    app.include_router(ws_router)

    logger.info("Seraphine app initialized (model=%s)", settings.llm_model)
    return app


app = create_app()
