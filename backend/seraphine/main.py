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
from seraphine.tools.registry import build_default_registry
from seraphine.tts.moss import MossTTSAdapter
from seraphine.ws.routes import router as ws_router

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("seraphine")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    store = MemoryStore(settings.sqlite_path)
    await store.ensure_schema()

    llm = OllamaClient(settings.ollama_base_url, settings.llm_model)
    embeddings = OllamaEmbeddings(settings.ollama_base_url, settings.embedding_model)
    memory = MemoryManager(store, embeddings, settings.chroma_path, llm=llm)
    try:
        await memory.start()
    except Exception as e:
        logger.warning("MemoryManager.start() failed: %s", e)

    tools = build_default_registry(allowed_roots=list(settings.allowed_tool_roots))
    engine = ConversationEngine(llm, store, memory=memory, tools=tools)
    tts = MossTTSAdapter(settings.moss_tts_url)
    audio_engine = AudioEngine(llm, tts, store)

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

    app.include_router(ws_router)

    logger.info("Seraphine app initialized (model=%s)", settings.llm_model)
    return app


app = create_app()
