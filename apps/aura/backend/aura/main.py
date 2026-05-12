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
from typing import Any

from fastapi import FastAPI, HTTPException
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
from aura.google import calendar_sync as google_calendar_sync
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
from aura.whatsapp import schema as whatsapp_schema
from aura.whatsapp.bridge_client import BridgeClient
from aura.whatsapp.client import EvolutionClient
from aura.whatsapp.routes import router as whatsapp_router
from aura.whatsapp.service import WhatsAppService
from aura.alexa import schema as alexa_schema
from aura.alexa.oauth import AlexaOAuth
from aura.alexa.routes import build_router as build_alexa_router
from aura.alexa.service import AlexaService
from aura.alexa.signature import verify_signature as verify_alexa_signature

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
    store.register_migrator("aura_whatsapp", whatsapp_schema.migrate)
    store.register_migrator("aura_alexa", alexa_schema.migrate)
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

    # Wire participant features (Aura sharing) into the shared TaskService.
    task_service.attach_user_lookup(
        email_to_user_id=users_service.get_user_id_by_email,
        user_id_to_email=users_service.get_email,
    )
    task_service.attach_push(push_service)

    # Best-effort: mirror every newly created task/reminder to the user's
    # Google Calendar (no-op when the user hasn't connected Google).
    google_calendar_sync.register(task_service, google_auth_service)

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

    # ---- WhatsApp — backend chosen by settings.whatsapp_backend
    whatsapp_client: Any = None
    whatsapp_service: WhatsAppService | None = None
    if settings.whatsapp_configured:
        if settings.whatsapp_backend == "bridge":
            whatsapp_client = BridgeClient(base_url=settings.whatsapp_bridge_url)
            logger.info(
                "WhatsApp wired via bridge backend (url=%s)",
                settings.whatsapp_bridge_url,
            )
        else:
            whatsapp_client = EvolutionClient(
                base_url=settings.evolution_base_url,
                api_key=settings.evolution_api_key,
                instance=settings.evolution_instance,
            )
            logger.info(
                "WhatsApp wired via evolution backend (instance=%s, base=%s)",
                settings.evolution_instance, settings.evolution_base_url,
            )
        whatsapp_service = WhatsAppService(store=store, client=whatsapp_client)
        whatsapp_service.bind_dependencies(
            llm=llm,
            finance=finance_service,
            tasks=task_service,
            recurring=recurring_service,
            projects=projects_service,
            habits=habits_service,
            knowledge=knowledge_service,
            goals=goals_service,
            conversations=conversations_service,
        )
        if not settings.whatsapp_admin_token:
            logger.warning(
                "AURA_WHATSAPP_ADMIN_TOKEN unset — /whatsapp/admin/* "
                "will return 401 (admin operations disabled)"
            )
        # Late-bind the WhatsApp service onto PushService so reminders
        # fan out to web push + WhatsApp in parallel.
        push_service.attach_whatsapp(whatsapp_service)
    else:
        logger.warning(
            "WhatsApp not configured — /whatsapp/* will return 503"
        )

    # ---- Alexa Custom Skill (Beta distribution)
    alexa_service: AlexaService | None = None
    if settings.alexa_configured:
        alexa_conn = store._connect()
        alexa_oauth = AlexaOAuth(
            conn=alexa_conn,
            client_id=settings.alexa_client_id,
            client_secret=settings.alexa_client_secret,
            allowed_redirects=tuple(
                f"https://{host}/api/skill/link/{settings.alexa_vendor_id}"
                for host in (
                    "layla.amazon.com",
                    "alexa.amazon.co.jp",
                    "pitangui.amazon.com",
                )
            ) if settings.alexa_vendor_id else (),
        )

        async def _run_alexa_agentic(*, uid, conversation_id, user_text):
            # Thin adapter so AlexaService can call the chat agentic loop
            # without dragging every service into its constructor. All
            # singletons live on app.state by the time a request arrives.
            from aura.chat.routes import _run_agentic_collect
            return await _run_agentic_collect(
                llm=app.state.llm,
                finance=app.state.finance_service,
                tasks_svc=app.state.task_service,
                recurring_svc=app.state.recurring_service,
                projects_svc=getattr(app.state, "projects_service", None),
                habits_svc=getattr(app.state, "habits_service", None),
                knowledge_svc=getattr(app.state, "knowledge_service", None),
                goals_svc=getattr(app.state, "goals_service", None),
                svc=app.state.conversations_service,
                uid=uid,
                conversation_id=conversation_id,
                user_text=user_text,
                msgs=[],
                is_first_exchange=False,
            )

        alexa_service = AlexaService(
            conn=alexa_conn,
            run_agentic=_run_alexa_agentic,
            timeout_seconds=7.0,
        )

        _alexa_jwt_resolver = jwt_dep(settings.jwt_secret)

        async def _alexa_user(request):
            try:
                return _alexa_jwt_resolver(
                    authorization=request.headers.get("authorization")
                )
            except HTTPException:
                return None

        app.include_router(
            build_alexa_router(
                oauth=alexa_oauth,
                service=alexa_service,
                skill_id=settings.alexa_skill_id,
                verify_signature=verify_alexa_signature,
                get_current_user_id=_alexa_user,
            )
        )
    else:
        logger.info(
            "alexa: not configured (AURA_ALEXA_* envs missing); skill routes disabled"
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
    app.state.whatsapp_client = whatsapp_client
    app.state.whatsapp_service = whatsapp_service
    app.state.whatsapp_webhook_token = settings.evolution_webhook_token
    app.state.whatsapp_admin_token = settings.whatsapp_admin_token
    app.state.alexa_service = alexa_service

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
        if whatsapp_client is not None:
            try:
                await whatsapp_client.aclose()
            except Exception:
                logger.exception("whatsapp client aclose failed")
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
    app.include_router(whatsapp_router)

    @app.get("/health")
    async def health() -> dict:
        return {"status": "ok"}

    return app


app = create_app()
