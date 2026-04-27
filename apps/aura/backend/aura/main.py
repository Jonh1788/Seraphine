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

import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone
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
from aura.briefing.routes import router as briefing_router
from aura.briefing.service import BriefingService
from aura.chat.routes import router as chat_router
from aura.chat import schema as chat_schema
from aura.chat.service import ConversationService
from aura.config import settings
from aura.google import schema as google_schema
from aura.google.routes import router as google_router
from aura.google.service import GoogleAuthService
from aura.habits import schema as habits_schema
from aura.habits.routes import router as habits_router
from aura.habits.service import HabitsService
from aura.knowledge import schema as knowledge_schema
from aura.knowledge.routes import router as knowledge_router
from aura.knowledge.service import KnowledgeService
from aura.goals import schema as goals_schema
from aura.goals.routes import router as goals_router
from aura.goals.service import GoalsService
from aura.projects import schema as projects_schema
from aura.projects.routes import router as projects_router
from aura.projects.service import ProjectsService
from aura.push import schema as push_schema
from aura.push.routes import router as push_router
from aura.push.service import PushService
from aura.recurring import schema as recurring_schema
from aura.recurring.routes import router as recurring_router
from aura.recurring.service import RecurringService
from aura.stt.routes import router as stt_router
from aura.stt.service import STTService

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
    store.register_migrator("aura_recurring", recurring_schema.migrate)
    store.register_migrator("aura_google", google_schema.migrate)
    store.register_migrator("aura_habits", habits_schema.migrate)
    store.register_migrator("aura_knowledge", knowledge_schema.migrate)
    store.register_migrator("aura_projects", projects_schema.migrate)
    store.register_migrator("aura_goals", goals_schema.migrate)
    store.register_migrator("aura_push", push_schema.migrate)
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
    recurring_service = RecurringService(store, task_service)
    google_auth_service = GoogleAuthService(store, settings)
    briefing_service = BriefingService(
        llm=llm, tasks=task_service, finance=finance_service,
    )
    habits_service = HabitsService(store)
    knowledge_service = KnowledgeService(store)
    projects_service = ProjectsService(store)
    goals_service = GoalsService(store)
    push_service = PushService(
        store=store,
        tasks=task_service,
        vapid_subject=settings.vapid_subject,
        vapid_private_pem=settings.vapid_private_pem or None,
        vapid_public_b64=settings.vapid_public_b64 or None,
    )

    # ---- STT (lazy model load on first /chat/transcribe call).
    # mkdir is best-effort: in dev the default /data isn't writable;
    # devs can override via AURA_WHISPER_CACHE_DIR. The transcribe call
    # will surface a clear error if the cache dir really is unusable.
    try:
        settings.whisper_cache_dir.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        logger.warning(
            "STT cache dir %s not writable (%s) — set "
            "AURA_WHISPER_CACHE_DIR if you intend to use /chat/transcribe",
            settings.whisper_cache_dir, e,
        )
    stt_service = STTService(
        model_name=settings.whisper_model,
        compute_type=settings.whisper_compute_type,
        cache_dir=settings.whisper_cache_dir,
    )
    logger.info(
        "STT service wired (model=%s, compute=%s, cache=%s) — "
        "first request will download ~500MB",
        settings.whisper_model,
        settings.whisper_compute_type,
        settings.whisper_cache_dir,
    )

    app.state.store = store
    app.state.llm = llm
    app.state.users_service = users_service
    app.state.task_service = task_service
    app.state.finance_service = finance_service
    app.state.conversations_service = conversations_service
    app.state.recurring_service = recurring_service
    app.state.google_auth_service = google_auth_service
    app.state.briefing_service = briefing_service
    app.state.habits_service = habits_service
    app.state.knowledge_service = knowledge_service
    app.state.projects_service = projects_service
    app.state.goals_service = goals_service
    app.state.push_service = push_service
    app.state.stt_service = stt_service

    # Background materialize loop — every 10 minutes, create today's
    # occurrences for any active rule that is due and hasn't fired yet.
    # Stdlib-only on purpose: a pip dependency for something this small
    # isn't worth it.
    materialize_task: asyncio.Task[None] | None = None

    async def _materialize_loop() -> None:
        interval = 600  # 10 min
        while True:
            try:
                created = await recurring_service.materialize_due(
                    datetime.now(timezone.utc),
                )
                if created:
                    logger.info(
                        "recurring: materialized %d occurrences", len(created),
                    )
            except Exception:
                logger.exception("recurring materialize loop failed")
            try:
                await asyncio.sleep(interval)
            except asyncio.CancelledError:
                raise

    # Fire once at startup so boot-time misses are caught immediately.
    try:
        await recurring_service.materialize_due(datetime.now(timezone.utc))
    except Exception:
        logger.exception("initial recurring materialize failed")

    materialize_task = asyncio.create_task(_materialize_loop())

    # Push dispatch loop — every 60s, scan reminders due in the last
    # minute and send a push to subscribed browsers. Idempotent via the
    # push_dispatches table.
    push_task: asyncio.Task[None] | None = None

    async def _push_loop() -> None:
        interval = 60
        # Small initial delay so the first tick lines up off-clock with
        # materialize and we don't burst-write at boot.
        await asyncio.sleep(15)
        while True:
            try:
                sent = await push_service.dispatch_due_reminders()
                if sent:
                    logger.info("push: dispatched %d reminder(s)", sent)
            except Exception:
                logger.exception("push dispatch loop failed")
            try:
                await asyncio.sleep(interval)
            except asyncio.CancelledError:
                raise

    push_task = asyncio.create_task(_push_loop())

    logger.info("Aura ready — DB=%s", settings.sqlite_path)
    try:
        yield
    finally:
        for t in (materialize_task, push_task):
            if t is not None:
                t.cancel()
                try:
                    await t
                except (asyncio.CancelledError, Exception):
                    pass
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
    app.include_router(stt_router)
    app.include_router(tasks_router)
    app.include_router(finance_router)
    app.include_router(recurring_router)
    app.include_router(google_router)
    app.include_router(briefing_router)
    app.include_router(habits_router)
    app.include_router(knowledge_router)
    app.include_router(projects_router)
    app.include_router(goals_router)
    app.include_router(push_router)

    @app.get("/health")
    async def health() -> dict:
        return {"status": "ok"}

    return app


app = create_app()
