"""Aura backend entrypoint.

Wires the shared packages into a multi-tenant FastAPI app:
- core-db Store (one SQLite shared by every module)
- core-auth: jwt_dep override for ``mod_tasks.routes.get_current_user_id``
- llm-adapters: AnthropicClient with the user's API key
- mod-tasks + mod-finance + google-integration: routers mounted as-is

Every request that depends on ``get_current_user_id`` extracts user_id
from the Authorization Bearer JWT — no code in the modules knew this
was coming.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from core_auth import jwt_dep
from core_db import Store
from llm_adapters import AnthropicClient
from mod_finance import schema as finance_schema
from mod_finance.routes import router as finance_router
from mod_finance.service import FinanceService
from mod_tasks import schema as tasks_schema
from mod_tasks.routes import get_current_user_id, router as tasks_router
from mod_tasks.service import TaskService

from aura.auth.routes import router as auth_router
from aura.auth import schema as auth_schema
from aura.auth.service import UsersService
from aura.chat.routes import router as chat_router
from aura.chat import schema as chat_schema
from aura.chat.service import ConversationService
from aura.config import settings

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("aura")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # ---- Storage
    store = Store(settings.sqlite_path)
    store.register_migrator("aura_users", auth_schema.migrate)
    store.register_migrator("aura_chat", chat_schema.migrate)
    store.register_migrator("mod_tasks", tasks_schema.migrate)
    store.register_migrator("mod_finance", finance_schema.migrate)
    await store.ensure_schema()

    # ---- LLM (optional — Aura still boots without it for offline dev)
    llm: AnthropicClient | None = None
    key = settings.anthropic_api_key.strip()
    if key:
        llm = AnthropicClient(api_key=key, model=settings.anthropic_model)
        logger.info(
            "Anthropic client wired (model=%s, key=%s...%s, len=%d)",
            settings.anthropic_model, key[:6], key[-4:], len(key),
        )
    else:
        logger.warning(
            "AURA_ANTHROPIC_API_KEY not set — chat will return 503. "
            "Looked at .env: %s (exists=%s)",
            (Path(__file__).resolve().parent / ".env"),
            (Path(__file__).resolve().parent / ".env").exists(),
        )

    # ---- Domain services
    users_service = UsersService(store)
    task_service = TaskService(store, llm_client=llm, app_state=app.state)
    finance_service = FinanceService(store)
    conversations_service = ConversationService(store)

    app.state.store = store
    app.state.llm = llm
    app.state.users_service = users_service
    app.state.task_service = task_service
    app.state.finance_service = finance_service
    app.state.conversations_service = conversations_service

    logger.info("Aura ready — DB=%s", settings.sqlite_path)
    try:
        yield
    finally:
        await store.aclose()


def create_app() -> FastAPI:
    app = FastAPI(
        title="Aura",
        version="0.1.0",
        description="Multi-tenant personal assistant SaaS",
        lifespan=lifespan,
    )

    # CORS — open during dev. Lock down in production.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Plug JWT auth into shared modules. mod_tasks owns
    # ``get_current_user_id``; every shared module that needs scoping
    # depends on the same symbol, so one override scopes everything.
    app.dependency_overrides[get_current_user_id] = jwt_dep(settings.jwt_secret)

    app.include_router(auth_router)
    app.include_router(chat_router)
    app.include_router(tasks_router)
    app.include_router(finance_router)

    @app.get("/health")
    async def health() -> dict:
        return {"status": "ok"}

    return app


app = create_app()
