from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from seraphine.config import settings
from seraphine.conversation.engine import ConversationEngine
from seraphine.llm.client import OllamaClient
from seraphine.memory.store import MemoryStore
from seraphine.ws.routes import router as ws_router

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("seraphine")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    store = MemoryStore(settings.sqlite_path)
    await store.ensure_schema()
    llm = OllamaClient(settings.ollama_base_url, settings.llm_model)
    engine = ConversationEngine(llm, store)
    app.state.store = store
    app.state.llm = llm
    app.state.engine = engine
    logger.info("Seraphine lifespan started (model=%s)", settings.llm_model)
    try:
        yield
    finally:
        await llm.aclose()


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
