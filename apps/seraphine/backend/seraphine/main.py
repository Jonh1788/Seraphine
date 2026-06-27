from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Any, AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from seraphine.config import settings
from seraphine.conversation.audio_engine import AudioEngine
from seraphine.conversation.engine import ConversationEngine
from seraphine.memory.embeddings import OllamaEmbeddings
from seraphine.memory.manager import MemoryManager
from seraphine.memory.store import MemoryStore
from seraphine.stt.whisper import WhisperSTT
from seraphine.tools.registry import build_default_registry
from seraphine.tts.qwen3 import Qwen3TtsAdapter
from seraphine.conversation.routes import router as conversation_router
from google_integration.routes import router as google_router
from seraphine.memory.routes import router as memory_router
from seraphine.ws.routes import router as ws_router
from seraphine.recurring import schema as recurring_schema
from seraphine.recurring.routes import router as recurring_router
from seraphine.recurring.routine_service import RoutineService
from seraphine.recurring.service import RecurringService
from seraphine.habits import schema as habits_schema
from seraphine.habits.routes import router as habits_router
from seraphine.habits.service import HabitService
from seraphine.water import schema as water_schema
from seraphine.water.routes import router as water_router
from seraphine.water.service import WaterService
from seraphine.health import schema as health_schema
from seraphine.health.routes import router as health_router
from seraphine.health.service import HealthService
from seraphine.insights import schema as insights_schema
from seraphine.insights.routes import router as insights_router
from seraphine.insights.service import InsightEngine
from seraphine.notes import schema as notes_schema
from seraphine.notes.routes import router as notes_router
from seraphine.notes.service import NoteService
from seraphine.work import schema as work_schema
from seraphine.work.routes import router as work_router
from seraphine.work.service import WorkProjectService
from seraphine.music.routes import router as music_router
from seraphine.music.service import FocusMusicService
from seraphine.mood import schema as mood_schema
from seraphine.mood.routes import router as mood_router
from seraphine.mood.service import MoodService
from seraphine.journal import schema as journal_schema
from seraphine.journal.routes import router as journal_router
from seraphine.journal.service import JournalService
from seraphine.focus import schema as focus_schema
from seraphine.focus.routes import router as focus_router
from seraphine.focus.service import FocusService
from seraphine.goals import schema as goals_schema
from seraphine.goals.routes import router as goals_router
from seraphine.goals.service import GoalService
from seraphine.cv_triage import schema as cv_triage_schema
from seraphine.cv_triage import storage as cv_triage_storage
from seraphine.cv_triage.routes import router as cv_triage_router
from seraphine.reading import schema as reading_schema
from seraphine.reading.routes import router as reading_router
from seraphine.reading.service import ReadingService
from seraphine.planning import schema as planning_schema
from seraphine.planning.routes import router as planning_router
from seraphine.planning.service import PlanningService
from seraphine.contextual import schema as contextual_schema
from seraphine.contextual.routes import router as contextual_router
from seraphine.contextual.service import ContextualActionsService
from seraphine.notifications import schema as notifications_schema
from seraphine.notifications.routes import router as notifications_router
from seraphine.notifications.service import NotificationService
from seraphine.deepsearch import schema as deepsearch_schema
from seraphine.deepsearch.routes import router as deepsearch_router
from seraphine.deepsearch.service import DeepSearchService

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("seraphine")

# Top-level reference for ReminderScheduler callback (must be pickleable).
_app_ref: FastAPI | None = None


def _on_reminder_fire(rid: str, msg: str) -> None:
    import asyncio as _aio
    if _app_ref is not None:
        from seraphine.reminders.notify import notify_reminder
        _aio.create_task(notify_reminder(_app_ref.state, rid, msg))


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    store = MemoryStore(settings.sqlite_path)
    # Telemetry — register its migrator BEFORE ensure_schema so the
    # llm_usage table exists, then build the service (needed by the
    # AnthropicClient sink constructed below).
    from seraphine.telemetry import TelemetryService
    from seraphine.telemetry import schema as telemetry_schema
    store.register_migrator("telemetry", telemetry_schema.migrate)
    # Learning loop (OpenJarvis #1): register its migrator alongside telemetry
    # so the learning_* tables are created by this early ensure_schema() call.
    from seraphine.learning import schema as learning_schema
    store.register_migrator("learning", learning_schema.migrate)
    await store.ensure_schema()
    telemetry_service = TelemetryService(store)

    def _telemetry_sink(rec: dict) -> None:
        # Fire-and-forget: telemetry must add ZERO latency to a turn.
        try:
            import asyncio as _aio
            _aio.create_task(telemetry_service.record(
                backend=rec.get("backend", "?"), model=rec.get("model", "?"),
                feature="chat",
                input_tokens=rec.get("input_tokens", 0),
                output_tokens=rec.get("output_tokens", 0),
            ))
        except Exception:
            pass

    from seraphine.llm.factory import build_engine
    llm, engine_info = build_engine(settings, telemetry=_telemetry_sink)
    try:
        from seraphine.conversation.engine import DEFAULT_SYSTEM_PROMPT
        await llm.warmup(system_prompt=DEFAULT_SYSTEM_PROMPT)
        logger.info("LLM warmup complete — system prompt cached (model=%s)", settings.llm_model)
    except Exception as e:
        logger.warning("LLM warmup failed (continuing anyway): %s", e)
    embeddings = OllamaEmbeddings(settings.ollama_base_url, settings.embedding_model)
    memory = MemoryManager(
        store, embeddings, settings.chroma_path,
        llm=llm, embedding_model=settings.embedding_model,
    )
    try:
        await memory.start()
    except Exception as e:
        logger.warning("MemoryManager.start() failed: %s", e)

    # ------------------------------------------------------------------
    # Google Workspace integration — optional
    # ------------------------------------------------------------------
    google_client = None
    if settings.google_client_id and settings.google_client_secret:
        from google_integration.client import GoogleClient
        from google_integration.token_store import TokenStore

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
    whatsapp_task_detector = None
    if settings.whatsapp_bridge_url:
        try:
            from seraphine.whatsapp.client import WhatsAppBridgeClient

            whatsapp_client = WhatsAppBridgeClient(
                base_url=settings.whatsapp_bridge_url,
            )
            logger.info("WhatsApp bridge client wired (url=%s)", settings.whatsapp_bridge_url)

            from seraphine.whatsapp.task_detector import WhatsAppTaskDetector
            whatsapp_task_detector = WhatsAppTaskDetector(
                app_state=None,
                whatsapp_client=whatsapp_client,
                llm_client=llm,
            )
            logger.info("WhatsApp task detector wired")
        except Exception as e:
            logger.warning("WhatsApp integration failed (non-critical): %s", e)

    # ------------------------------------------------------------------
    # Finance module — always enabled (SQLite-backed)
    # ------------------------------------------------------------------
    finance_service = None
    try:
        from mod_finance import FinanceService
        from mod_finance import schema as finance_schema
        store.register_migrator("mod_finance", finance_schema.migrate)
        await store.ensure_schema()  # idempotent — re-runs all migrators
        finance_service = FinanceService(store)
        logger.info("Finance service wired (mod-finance)")
    except Exception as e:
        logger.warning("Finance service failed (non-critical): %s", e)

    # ------------------------------------------------------------------
    # Internal task system — always enabled (MemoryStore-backed)
    # ------------------------------------------------------------------
    task_service = None
    email_scanner = None
    try:
        from mod_tasks import TaskService
        from mod_tasks import schema as tasks_schema
        # Register the mod-tasks schema migrator so its tables are
        # created/migrated on the next ensure_schema() call.
        store.register_migrator("mod_tasks", tasks_schema.migrate)
        await store.ensure_schema()  # idempotent — re-runs all registered migrators
        task_service = TaskService(
            store,
            google_client=google_client,
            llm_client=llm,
            app_state=app.state,
        )
        logger.info("Task service wired (mod-tasks)")

        if google_client:
            from mod_tasks.email_scanner import EmailScanner
            email_scanner = EmailScanner(
                google_client, task_service, llm_client=llm, store=store,
            )
            logger.info("Email scanner wired")
    except Exception as e:
        logger.warning("Task service failed (non-critical): %s", e)

    # ------------------------------------------------------------------
    # Email urgency triage → WhatsApp push (all-Seraphine)
    # ------------------------------------------------------------------
    email_urgency_service = None
    if google_client is not None:
        try:
            from seraphine.email_urgency import schema as email_urgency_schema
            from seraphine.email_urgency.service import EmailUrgencyService

            store.register_migrator("email_urgency", email_urgency_schema.migrate)
            await store.ensure_schema()  # idempotent
            email_urgency_service = EmailUrgencyService(
                store=store,
                google_client=google_client,
                llm=llm,
                whatsapp_client=whatsapp_client,
                owner_chat_id=settings.owner_whatsapp_chat_id,
                public_url=settings.app_public_url,
                quiet_start=settings.email_urgency_quiet_start,
                quiet_end=settings.email_urgency_quiet_end,
            )
            logger.info("Email urgency scanner wired")
        except Exception as e:
            logger.warning("Email urgency scanner failed (non-critical): %s", e)

    # ------------------------------------------------------------------
    # Recurring tasks — always enabled (SQLite-backed)
    # ------------------------------------------------------------------
    recurring_service = None
    routine_service = None
    try:
        store.register_migrator("seraphine_recurring", recurring_schema.migrate)
        await store.ensure_schema()  # idempotent
        if task_service is not None:
            recurring_service = RecurringService(store, task_service)
            logger.info("Recurring service wired")
        # Routines (prompt launchers) share the recurring migrator. Seed the
        # code-owned catalog once; seeding is idempotent (keyed by stable id).
        routine_service = RoutineService(store)
        seeded = await routine_service.seed_defaults()
        logger.info("Routine service wired (seeded %d default routines)", seeded)
    except Exception as e:
        logger.warning("Recurring/routine service failed (non-critical): %s", e)

    # ------------------------------------------------------------------
    # Habits — always enabled (SQLite-backed)
    # ------------------------------------------------------------------
    habit_service = None
    try:
        store.register_migrator("seraphine_habits", habits_schema.migrate)
        await store.ensure_schema()  # idempotent
        habit_service = HabitService(store)
        logger.info("Habit service wired")
    except Exception as e:
        logger.warning("Habit service failed (non-critical): %s", e)

    # ------------------------------------------------------------------
    # Water tracking — always enabled (SQLite-backed)
    # ------------------------------------------------------------------
    water_service = None
    try:
        store.register_migrator("seraphine_water", water_schema.migrate)
        await store.ensure_schema()  # idempotent
        water_service = WaterService(store)
        logger.info("Water service wired")
    except Exception as e:
        logger.warning("Water service failed (non-critical): %s", e)

    # ------------------------------------------------------------------
    # Apple Health — always enabled (SQLite-backed; data ingested from
    # the Tauri HealthKit bridge via POST /health/snapshot).
    # ------------------------------------------------------------------
    health_service = None
    try:
        store.register_migrator("seraphine_health", health_schema.migrate)
        await store.ensure_schema()  # idempotent
        health_service = HealthService(
            store,
            habit_service=habit_service,
            water_service=water_service,
        )
        logger.info("Health service wired")
    except Exception as e:
        logger.warning("Health service failed (non-critical): %s", e)

    # ------------------------------------------------------------------
    # Mood tracking — always enabled (SQLite-backed). Mood events from
    # the conversation engine are persisted as time series.
    # ------------------------------------------------------------------
    mood_service = None
    try:
        store.register_migrator("seraphine_mood", mood_schema.migrate)
        await store.ensure_schema()  # idempotent
        mood_service = MoodService(store)
        logger.info("Mood service wired")
    except Exception as e:
        logger.warning("Mood service failed (non-critical): %s", e)

    # ------------------------------------------------------------------
    # Journal / Diario — always enabled (SQLite + ChromaDB for search)
    # ------------------------------------------------------------------
    journal_service = None
    try:
        store.register_migrator("seraphine_journal", journal_schema.migrate)
        await store.ensure_schema()  # idempotent
        journal_service = JournalService(
            store,
            chroma_path=settings.chroma_path,
            embeddings=embeddings,
            llm=llm,
        )
        await journal_service.start()
        logger.info("Journal service wired")
    except Exception as e:
        logger.warning("Journal service failed (non-critical): %s", e)

    # ------------------------------------------------------------------
    # Focus analytics — always enabled (SQLite-backed)
    # ------------------------------------------------------------------
    focus_service = None
    try:
        store.register_migrator("seraphine_focus", focus_schema.migrate)
        await store.ensure_schema()  # idempotent
        focus_service = FocusService(store)
        logger.info("Focus service wired")
    except Exception as e:
        logger.warning("Focus service failed (non-critical): %s", e)

    # ------------------------------------------------------------------
    # Goals (OKRs) — always enabled (SQLite-backed)
    # ------------------------------------------------------------------
    goal_service = None
    try:
        store.register_migrator("seraphine_goals", goals_schema.migrate)
        await store.ensure_schema()  # idempotent
        goal_service = GoalService(store)
        logger.info("Goal service wired")
    except Exception as e:
        logger.warning("Goal service failed (non-critical): %s", e)

    # ------------------------------------------------------------------
    # CV Triage — always enabled (SQLite-backed). Worker dispatched
    # from the REST routes; nothing to instantiate up-front.
    # ------------------------------------------------------------------
    try:
        store.register_migrator("seraphine_cv_triage", cv_triage_schema.migrate)
        await store.ensure_schema()  # idempotent

        import sqlite3 as _sqlite3

        def _cv_triage_reap() -> int:
            _conn = store._connect()
            _conn.row_factory = _sqlite3.Row
            return cv_triage_storage.mark_active_jobs_failed_on_startup(
                _conn, "interrupted_by_restart",
            )

        _interrupted = await asyncio.to_thread(_cv_triage_reap)
        if _interrupted:
            logger.info(
                "cv_triage: marked %d active jobs as failed (interrupted by restart)",
                _interrupted,
            )
    except Exception as e:
        logger.warning("CV triage init failed (non-critical): %s", e)

    # ------------------------------------------------------------------
    # Freshness — schema migration (adds facts.archived_at and
    # idx_tasks_status_due). Daily archive cron is registered below
    # alongside the other proactive-scheduler crons.
    # ------------------------------------------------------------------
    try:
        from seraphine.freshness import migrate as freshness_migrate
        store.register_migrator("seraphine_freshness", freshness_migrate)
        await store.ensure_schema()  # idempotent
        logger.info("Freshness migrator registered")
    except Exception as e:
        logger.warning("Freshness migrator failed (non-critical): %s", e)

    # ------------------------------------------------------------------
    # Proactive preferences — persisted runtime controls for scheduler jobs.
    # ------------------------------------------------------------------
    try:
        from seraphine.proactive.schema import migrate as proactive_migrate
        store.register_migrator("seraphine_proactive", proactive_migrate)
        await store.ensure_schema()
        logger.info("Proactive preferences migrator registered")
    except Exception as e:
        logger.warning("Proactive preferences migrator failed (non-critical): %s", e)

    # ------------------------------------------------------------------
    # Notes — always enabled (SQLite-backed)
    # ------------------------------------------------------------------
    note_service = None
    try:
        store.register_migrator("seraphine_notes", notes_schema.migrate)
        await store.ensure_schema()  # idempotent
        note_service = NoteService(store=store, task_service=task_service)
        logger.info("Note service wired")
    except Exception as e:
        logger.warning("Note service failed (non-critical): %s", e)

    # ------------------------------------------------------------------
    # Work projects — always enabled (SQLite-backed)
    # ------------------------------------------------------------------
    work_service = None
    try:
        store.register_migrator("seraphine_work", work_schema.migrate)
        await store.ensure_schema()  # idempotent
        work_service = WorkProjectService(store=store, task_service=task_service)
        logger.info("Work project service wired")
    except Exception as e:
        logger.warning("Work project service failed (non-critical): %s", e)

    # ------------------------------------------------------------------
    # Reading list / knowledge base — always enabled (SQLite + ChromaDB)
    # ------------------------------------------------------------------
    reading_service = None
    try:
        store.register_migrator("seraphine_reading", reading_schema.migrate)
        await store.ensure_schema()  # idempotent
        reading_service = ReadingService(
            store=store,
            llm=llm,
            embeddings=embeddings,
            chroma_path=settings.chroma_path,
        )
        await reading_service.start()
        logger.info("Reading service wired")
    except Exception as e:
        logger.warning("Reading service failed (non-critical): %s", e)

    # ------------------------------------------------------------------
    # Planning (SDD 093) — always enabled (SQLite-backed)
    # ------------------------------------------------------------------
    planning_service = None
    try:
        store.register_migrator("seraphine_planning", planning_schema.migrate)
        await store.ensure_schema()  # idempotent
        planning_service = PlanningService(
            store,
            google_client=google_client,
            task_service=task_service,
            habit_service=habit_service,
            health_service=health_service,
            goal_service=goal_service,
            mood_service=mood_service,
            llm=llm,
        )
        logger.info("Planning service wired")
    except Exception as e:
        logger.warning("Planning service failed (non-critical): %s", e)

    # ------------------------------------------------------------------
    # Contextual shortcuts (SDD 095) — always enabled (SQLite-backed)
    # ------------------------------------------------------------------
    contextual_service = None
    try:
        store.register_migrator("seraphine_contextual", contextual_schema.migrate)
        await store.ensure_schema()  # idempotent
        contextual_service = ContextualActionsService(store)
        logger.info("Contextual actions service wired")
    except Exception as e:
        logger.warning("Contextual actions service failed (non-critical): %s", e)

    # ------------------------------------------------------------------
    # Notification Intelligence (SDD 094) — always enabled (SQLite-backed)
    # ------------------------------------------------------------------
    notification_service = None
    try:
        store.register_migrator("seraphine_notifications", notifications_schema.migrate)
        await store.ensure_schema()  # idempotent
        notification_service = NotificationService(
            store,
            google_client=google_client,
            focus_service=focus_service,
        )
        logger.info("Notification intelligence service wired")
    except Exception as e:
        logger.warning("Notification service failed (non-critical): %s", e)

    # ------------------------------------------------------------------
    # Insights — always enabled (SQLite-backed); analysers fan out over
    # whichever of finance/tasks/habits happened to come up.
    # ------------------------------------------------------------------
    insight_engine = None
    try:
        store.register_migrator("seraphine_insights", insights_schema.migrate)
        await store.ensure_schema()  # idempotent
        insight_engine = InsightEngine(
            store,
            finance_service=finance_service,
            task_service=task_service,
            habit_service=habit_service,
            health_service=health_service,
        )
        logger.info("Insight engine wired")
    except Exception as e:
        logger.warning("Insight engine failed (non-critical): %s", e)

    # ------------------------------------------------------------------
    # Wise (TransferWise) integration — optional
    # ------------------------------------------------------------------
    wise_client = None
    if settings.wise_api_key:
        try:
            from seraphine.wise.client import WiseClient
            wise_client = WiseClient(
                api_key=settings.wise_api_key,
                profile_id=settings.wise_profile_id,
                sandbox=settings.wise_sandbox,
            )
            logger.info("Wise client wired (sandbox=%s, profile_id=%s)", settings.wise_sandbox, settings.wise_profile_id or "auto-detect")
        except Exception as e:
            logger.warning("Wise integration failed (non-critical): %s", e)

    # ------------------------------------------------------------------
    # Browser automation integration — optional
    # ------------------------------------------------------------------
    browser_client = None
    if settings.browser_agent_url:
        try:
            from seraphine.browser.client import BrowserAgentClient
            browser_client = BrowserAgentClient(base_url=settings.browser_agent_url)
            logger.info("Browser agent client wired (url=%s)", settings.browser_agent_url)
        except Exception as e:
            logger.warning("Browser agent failed (non-critical): %s", e)

    # ------------------------------------------------------------------
    # Web Push notifications — optional (VAPID keys in .env)
    # ------------------------------------------------------------------
    push_service = None
    if settings.vapid_private_key and settings.vapid_public_key:
        try:
            from seraphine.push.service import PushService
            push_service = PushService(
                vapid_private_key=settings.vapid_private_key,
                vapid_public_key=settings.vapid_public_key,
                store=store,
            )
            await push_service.load_from_store()
            logger.info(
                "Web Push service wired (VAPID public key=%s..., %d subs loaded)",
                settings.vapid_public_key[:20],
                push_service.subscription_count,
            )
        except Exception as e:
            logger.warning("Web Push failed (non-critical): %s", e)

    # ------------------------------------------------------------------
    # Reminders scheduler — always enabled (SQLite-backed)
    # ------------------------------------------------------------------
    reminder_scheduler = None
    try:
        global _app_ref
        from seraphine.reminders.scheduler import ReminderScheduler

        _app_ref = app
        _reminders_db = str(settings.sqlite_path).replace("seraphine.sqlite", "reminders.sqlite")
        reminder_scheduler = ReminderScheduler(
            sqlite_path=_reminders_db,
            on_fire=_on_reminder_fire,
        )
        await reminder_scheduler.start()
        logger.info("Reminder scheduler started (db=%s)", _reminders_db)
    except Exception as e:
        logger.warning("Reminder scheduler failed (non-critical): %s", e)

    tools = build_default_registry(
        allowed_roots=list(settings.allowed_tool_roots),
        skills_dir=settings.skills_dir,
        store=store,
        google_client=google_client,
        whatsapp_client=whatsapp_client,
        browser_client=browser_client,
        wise_client=wise_client,
        reminder_scheduler=reminder_scheduler,
        finance_service=finance_service,
        task_service=task_service,
        recurring_service=recurring_service,
        habit_service=habit_service,
        water_service=water_service,
        health_service=health_service,
        note_service=note_service,
        work_service=work_service,
        goal_service=goal_service,
        reading_service=reading_service,
        mood_service=mood_service,
        focus_service=focus_service,
        journal_service=journal_service,
        planning_service=planning_service,
        llm=llm,
    )
    # ------------------------------------------------------------------
    # Music / focus auto-play — SDD 017-A. Non-critical: reads memory
    # taste facts and delegates to the already-wired ``play_music`` tool.
    # ------------------------------------------------------------------
    music_service = None
    try:
        music_service = FocusMusicService(store=store, registry=tools)
        logger.info("Music service wired (focus auto-play)")
    except Exception as e:
        logger.warning("Music service failed (non-critical): %s", e)

    # ------------------------------------------------------------------
    # Deep Research (deepsearch) — always enabled (SQLite-backed). Reuses
    # the web tools from the registry built above and the cliproxy LLM.
    # ------------------------------------------------------------------
    deepsearch_service = None
    try:
        store.register_migrator("seraphine_deepsearch", deepsearch_schema.migrate)
        await store.ensure_schema()  # idempotent
        deepsearch_service = DeepSearchService(
            store, llm=llm, tools=tools, settings=settings,
        )
        logger.info("Deep Research service wired")
    except Exception as e:
        logger.warning("Deep Research service failed (non-critical): %s", e)
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

    engine = ConversationEngine(
        llm, store, memory=memory, tools=tools, insight_engine=insight_engine,
    )
    # Cost-aware routing: feed the engine the metered-spend signal source.
    engine._telemetry_service = telemetry_service

    # Learning loop (OpenJarvis #1): wire the LearningService. It needs a
    # one-shot LLM call (mirror memory/profile.py's accumulation pattern) and
    # the engine's base system prompt as the eval baseline instruction. The
    # engine reads the active policy + knobs each turn via _refresh_active_policy.
    from llm_adapters.types import ChatMessage as _LCM
    _learning_llm = engine.llm  # the AnthropicClient (engine.__init__: self.llm)

    async def _learning_llm_call(messages: list[dict]) -> str:
        chat_msgs = [_LCM(role=m["role"], content=m["content"]) for m in messages]
        acc: list[str] = []
        async for tok in _learning_llm.chat(chat_msgs, temperature=0.2):
            if tok.text:
                acc.append(tok.text)
        return "".join(acc)

    from seraphine.learning.service import LearningService
    learning_service = LearningService(
        store, _learning_llm_call,
        default_base_instruction=engine.system_prompt[:500],
    )
    engine._learning_service = learning_service

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
    # Late-register WhatsApp voice tool — needs both whatsapp_client and tts
    if whatsapp_client is not None:
        from seraphine.tools.whatsapp import WhatsAppSendVoiceTool

        tools.register(WhatsAppSendVoiceTool(whatsapp_client, tts))

    # STT backend: local MLX Whisper on Apple Silicon or remote HTTP
    # service on the RTX box (spec 007). Toggle via SERAPHINE_STT_BACKEND.
    # When remote is configured, local MLX is kept as fallback.
    stt: Any
    local_stt = WhisperSTT(
        model=settings.stt_model, language=settings.stt_language
    )
    if settings.stt_backend == "remote":
        from seraphine.stt.remote import RemoteWhisperSTT

        remote_stt = RemoteWhisperSTT(
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
            await remote_stt.warmup()
            stt = remote_stt
            logger.info("Remote STT online — using as primary")
        except Exception as e:
            logger.warning("RemoteWhisperSTT warmup failed, falling back to local: %s", e)
            stt = local_stt
        # Wrap with fallback: if remote fails at runtime, use local
        if stt is remote_stt:
            from seraphine.stt.fallback import FallbackSTT
            stt = FallbackSTT(primary=remote_stt, fallback=local_stt)
            logger.info("FallbackSTT wired (remote → local)")
    else:
        stt = local_stt
        logger.info(
            "WhisperSTT wired (model=%s language=%s)",
            settings.stt_model,
            settings.stt_language,
        )
    # Warmup local MLX: transcribe tiny silent PCM so model loads eagerly.
    try:
        await local_stt.transcribe(b"\x00" * 3200, sample_rate=16000)
        logger.info("Local WhisperSTT warmup complete")
    except Exception as e:
        logger.warning("Local WhisperSTT warmup failed (continuing anyway): %s", e)
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

    app.state.settings = settings
    app.state.store = store
    app.state.stt = stt
    app.state.llm = llm
    app.state.engine_info = engine_info
    # 033 — proxy broker for tool_proxy_request/response round-trips.
    from seraphine.ws.proxy_broker import ProxyBroker
    app.state.proxy_broker = ProxyBroker()
    # 073 — background task manager.
    from seraphine.background_tasks import BackgroundTaskManager
    app.state.background_manager = BackgroundTaskManager(store, llm, tools)
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
    app.state.whatsapp_bridge_url = settings.whatsapp_bridge_url
    app.state.browser_client = browser_client
    app.state.wise_client = wise_client
    app.state.finance_service = finance_service
    app.state.task_service = task_service
    app.state.email_scanner = email_scanner
    app.state.email_urgency_service = email_urgency_service
    app.state.reminder_scheduler = reminder_scheduler
    app.state.recurring_service = recurring_service
    app.state.routine_service = routine_service
    app.state.habit_service = habit_service
    app.state.water_service = water_service
    app.state.health_service = health_service
    app.state.note_service = note_service
    app.state.work_service = work_service
    app.state.music_service = music_service
    app.state.mood_service = mood_service
    app.state.journal_service = journal_service
    app.state.focus_service = focus_service
    app.state.goal_service = goal_service
    app.state.reading_service = reading_service
    app.state.planning_service = planning_service
    app.state.contextual_service = contextual_service
    app.state.notification_service = notification_service
    app.state.deepsearch_service = deepsearch_service
    app.state.insight_engine = insight_engine
    app.state.push_service = push_service
    app.state.telemetry_service = telemetry_service
    app.state.learning_service = learning_service
    # Connected WS clients — the event listener pushes notifications here
    app.state.ws_clients: set = set()

    # 023-A: wire app_state into engine so ambient block can read
    # google_client / health_service / task_service lazily per turn.
    engine.attach_app_state(app.state)

    # Patch task detector with live app_state now that it's ready
    if whatsapp_task_detector is not None:
        whatsapp_task_detector._app_state = app.state
        app.state.whatsapp_task_detector = whatsapp_task_detector

    # ------------------------------------------------------------------
    # Background recurring materialization loop — every 10 minutes
    # ------------------------------------------------------------------
    materialize_task: asyncio.Task[None] | None = None
    if recurring_service is not None:
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

    # ------------------------------------------------------------------
    # Background water reminder loop — every 10 minutes
    # ------------------------------------------------------------------
    water_reminder_task: asyncio.Task[None] | None = None
    if water_service is not None:
        from zoneinfo import ZoneInfo as _ZoneInfo
        _SP = _ZoneInfo("America/Sao_Paulo")

        async def _water_reminder_loop() -> None:
            from seraphine.reminders.notify import notify_reminder

            interval = 600  # 10 min
            while True:
                try:
                    profile = await water_service.get_profile()
                    if profile is not None and profile.reminder_enabled:
                        now_sp = datetime.now(_SP)
                        now_hhmm = now_sp.strftime("%H:%M")
                        within_window = (
                            profile.reminder_start
                            <= now_hhmm
                            <= profile.reminder_end
                        )
                        if within_window:
                            last_intake = await water_service.last_intake_at()
                            last_fired = (
                                await water_service.get_last_reminder_fired_at()
                            )
                            now_utc = datetime.now(timezone.utc)
                            gap = timedelta(
                                hours=max(1, int(profile.reminder_interval_hours)),
                            )
                            intake_overdue = (
                                last_intake is None
                                or (now_utc - last_intake) >= gap
                            )
                            not_spammed = (
                                last_fired is None
                                or (now_utc - last_fired) >= gap
                            )
                            if intake_overdue and not_spammed:
                                # 094: check notification intelligence gate
                                _nsvc = getattr(app.state, "notification_service", None)
                                _deliver = True
                                if _nsvc is not None:
                                    try:
                                        _deliver = await _nsvc.should_deliver("water")
                                        if not _deliver:
                                            await _nsvc.queue_notification(
                                                type="water",
                                                title="Agua",
                                                body="Bora beber agua!",
                                            )
                                            logger.info("water reminder queued (DND/low priority)")
                                    except Exception:
                                        _deliver = True  # fail-open
                                if _deliver:
                                    await notify_reminder(
                                        app.state,
                                        f"water-{now_utc.isoformat()}",
                                        "Bora beber agua!",
                                    )
                                await water_service.mark_reminder_fired(now_utc)
                                logger.info(
                                    "water reminder fired (last_intake=%s, delivered=%s)",
                                    last_intake,
                                    _deliver,
                                )
                except Exception:
                    logger.exception("water reminder loop iteration failed")
                try:
                    await asyncio.sleep(interval)
                except asyncio.CancelledError:
                    raise

        water_reminder_task = asyncio.create_task(_water_reminder_loop())

    # ------------------------------------------------------------------
    # 094: Notification queue flush loop — every 30 min, deliver batched
    # notifications if DND is no longer active.
    # ------------------------------------------------------------------
    notif_flush_task: asyncio.Task[None] | None = None
    if notification_service is not None:
        async def _notif_flush_loop() -> None:
            from seraphine.reminders.notify import notify_reminder

            interval = 1800  # 30 min
            while True:
                try:
                    await asyncio.sleep(interval)
                except asyncio.CancelledError:
                    raise
                try:
                    is_dnd = await notification_service.is_dnd()
                    if is_dnd:
                        continue  # still DND, skip
                    pending = await notification_service.get_pending_queue()
                    if not pending:
                        continue
                    flushed = await notification_service.flush_queue()
                    if not flushed:
                        continue
                    # Build batch summary
                    summary_parts: list[str] = []
                    for item in flushed:
                        summary_parts.append(f"- {item['title']}: {item['body'][:80]}")
                    batch_msg = (
                        f"Enquanto voce estava ocupado ({len(flushed)} notificacao(es)):\n"
                        + "\n".join(summary_parts[:10])
                    )
                    await notify_reminder(
                        app.state,
                        f"batch-{datetime.now(timezone.utc).isoformat()}",
                        batch_msg,
                    )
                    logger.info(
                        "notification queue flushed: %d items delivered",
                        len(flushed),
                    )
                except Exception:
                    logger.exception("notification flush loop iteration failed")

        notif_flush_task = asyncio.create_task(_notif_flush_loop())

    # ------------------------------------------------------------------
    # Email urgency scan loop — every email_urgency_interval_s seconds.
    # Lists new unread mail, classifies urgency, pushes WhatsApp on high.
    # ------------------------------------------------------------------
    email_urgency_task: asyncio.Task[None] | None = None
    if settings.email_urgency_enabled and email_urgency_service is not None:
        async def _email_urgency_loop() -> None:
            interval = max(60, int(settings.email_urgency_interval_s))
            while True:
                try:
                    pushed = await email_urgency_service.scan()
                    if pushed:
                        logger.info("email urgency: %d push(es) sent", pushed)
                except Exception:
                    logger.exception("email urgency loop iteration failed")
                try:
                    await asyncio.sleep(interval)
                except asyncio.CancelledError:
                    raise

        email_urgency_task = asyncio.create_task(_email_urgency_loop())

    # ------------------------------------------------------------------
    # Scheduled memory consolidation/audit loop — every
    # memory_audit_interval_s seconds (default 24h). Whole-store pass that
    # merges paraphrased facts and drops junk; cheap via a fingerprint
    # short-circuit. Wrapped so a failure never crashes the scheduler.
    # ------------------------------------------------------------------
    memory_audit_task: asyncio.Task[None] | None = None
    if memory is not None:
        async def _memory_audit_loop() -> None:
            interval = max(60, int(settings.memory_audit_interval_s))
            while True:
                try:
                    await asyncio.sleep(interval)
                except asyncio.CancelledError:
                    raise
                try:
                    result = await memory.audit()
                    if result.get("merged") or result.get("dropped"):
                        logger.info(
                            "memory audit: merged %s, dropped %s",
                            result.get("merged", 0), result.get("dropped", 0),
                        )
                except Exception:
                    logger.exception("memory audit loop iteration failed")

        memory_audit_task = asyncio.create_task(_memory_audit_loop())

    # ------------------------------------------------------------------
    # Background insights refresh loop — every 6 hours.
    # Runs once at startup so /insights is warm on first request.
    # ------------------------------------------------------------------
    insights_refresh_task: asyncio.Task[None] | None = None
    if insight_engine is not None:
        async def _insights_refresh_loop() -> None:
            interval = 6 * 60 * 60  # 6 hours
            while True:
                try:
                    await insight_engine.refresh_all()
                except Exception:
                    logger.exception("insights refresh loop iteration failed")
                try:
                    await asyncio.sleep(interval)
                except asyncio.CancelledError:
                    raise

        try:
            await insight_engine.refresh_all()
        except Exception:
            logger.exception("initial insights refresh failed")

        insights_refresh_task = asyncio.create_task(_insights_refresh_loop())

    # 024 — proactive scheduler (day review, stalled tasks, weekly)
    proactive_scheduler = None
    try:
        from seraphine.proactive import ProactiveScheduler
        proactive_scheduler = ProactiveScheduler(
            app.state,
            enabled=settings.proactive_enabled,
            goal_service=goal_service,
        )
        proactive_scheduler.start()
        app.state.proactive_scheduler = proactive_scheduler
    except Exception:
        logger.exception("proactive scheduler failed to start")

    # 075 Task 14 — daily TTL cleanup of cv_triage staging dirs.
    # Piggybacks on the proactive AsyncIOScheduler so we don't spin up a
    # second scheduler just for one cron tick.
    try:
        if proactive_scheduler is not None and proactive_scheduler.enabled:
            import sqlite3 as _sqlite3
            from pathlib import Path as _Path
            from seraphine.cv_triage.housekeeping import cleanup as _cv_triage_cleanup

            _cv_base_dir = _Path(settings.sqlite_path).parent / "cv_triage"

            def _cv_triage_housekeeping_tick() -> int:
                _conn = store._connect()
                _conn.row_factory = _sqlite3.Row
                return _cv_triage_cleanup(
                    _conn,
                    base_dir=_cv_base_dir,
                    done_ttl_h=24,
                    failed_ttl_h=24 * 7,
                )

            proactive_scheduler._sched.add_job(
                _cv_triage_housekeeping_tick,
                "cron", hour=4, minute=15,
                id="cv_triage_housekeeping",
                name="cv_triage_housekeeping",
            )
            logger.info("cv_triage housekeeping cron registered (04:15 daily)")
    except Exception:
        logger.exception("cv_triage housekeeping registration failed")

    # Freshness — daily archive of stale facts/tasks/open_loops.
    # Piggybacks on the proactive AsyncIOScheduler (same pattern as
    # cv_triage_housekeeping above).
    try:
        if proactive_scheduler is not None and proactive_scheduler.enabled:
            import sqlite3 as _sqlite3
            from seraphine.freshness import archive_stale, DEFAULT_POLICY

            def _freshness_archive_tick():
                _conn = store._connect()
                _conn.row_factory = _sqlite3.Row
                return archive_stale(_conn, DEFAULT_POLICY)

            proactive_scheduler._sched.add_job(
                _freshness_archive_tick,
                "cron", hour=4, minute=30,
                id="freshness_archive",
                name="freshness_archive",
            )
            logger.info("freshness archive cron registered (04:30 daily)")
    except Exception:
        logger.exception("freshness archive registration failed")

    # Anexos: TTL cleanup diário do staging store.
    try:
        if proactive_scheduler is not None and proactive_scheduler.enabled:
            from seraphine.attachments.store import cleanup as _attachments_cleanup

            def _attachments_housekeeping_tick() -> int:
                return _attachments_cleanup(ttl_hours=24)

            proactive_scheduler._sched.add_job(
                _attachments_housekeeping_tick,
                "cron", hour=4, minute=45,
                id="attachments_housekeeping",
                name="attachments_housekeeping",
            )
            logger.info("attachments housekeeping cron registered (04:45 daily)")
    except Exception:
        logger.exception("attachments housekeeping registration failed")

    logger.info("Seraphine lifespan started (model=%s)", settings.llm_model)
    try:
        yield
    finally:
        if proactive_scheduler is not None:
            try:
                proactive_scheduler.stop()
            except Exception:
                pass
        if materialize_task is not None:
            materialize_task.cancel()
            try:
                await materialize_task
            except (asyncio.CancelledError, Exception):
                pass
        if water_reminder_task is not None:
            water_reminder_task.cancel()
            try:
                await water_reminder_task
            except (asyncio.CancelledError, Exception):
                pass
        if notif_flush_task is not None:
            notif_flush_task.cancel()
            try:
                await notif_flush_task
            except (asyncio.CancelledError, Exception):
                pass
        if email_urgency_task is not None:
            email_urgency_task.cancel()
            try:
                await email_urgency_task
            except (asyncio.CancelledError, Exception):
                pass
        if memory_audit_task is not None:
            memory_audit_task.cancel()
            try:
                await memory_audit_task
            except (asyncio.CancelledError, Exception):
                pass
        if insights_refresh_task is not None:
            insights_refresh_task.cancel()
            try:
                await insights_refresh_task
            except (asyncio.CancelledError, Exception):
                pass
        if mcp_tools_watcher is not None:
            mcp_tools_watcher.cancel()
            try:
                await mcp_tools_watcher
            except BaseException:
                pass
        if mcp_event_listener is not None:
            await mcp_event_listener.stop()
        if reminder_scheduler is not None:
            await reminder_scheduler.stop()
        await llm.aclose()
        await embeddings.aclose()
        await tts.aclose()
        if whatsapp_client is not None:
            await whatsapp_client.aclose()
        if browser_client is not None:
            await browser_client.aclose()
        if finance_service is not None:
            await finance_service.aclose()
        if task_service is not None:
            await task_service.aclose()
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

    from seraphine.conversation.briefing import router as briefing_router

    app.include_router(conversation_router)
    app.include_router(memory_router)
    app.include_router(ws_router)
    app.include_router(google_router)
    app.include_router(briefing_router)

    from seraphine.voice_memo_routes import router as voice_memo_router
    app.include_router(voice_memo_router)

    from seraphine.proactive.routes import router as proactive_router
    app.include_router(proactive_router)

    from seraphine.notes_routes import router as desktop_notes_router
    app.include_router(desktop_notes_router)

    from seraphine.flashcards.routes import router as flashcards_router
    app.include_router(flashcards_router)

    from seraphine.images.routes import router as images_router
    app.include_router(images_router)

    from seraphine.attachments.routes import router as attachments_router
    app.include_router(attachments_router)

    from seraphine.background_tasks.routes import router as bg_tasks_router
    app.include_router(bg_tasks_router)

    from seraphine.lab.routes import router as lab_router
    app.include_router(lab_router)

    from mod_finance.routes import router as finance_router
    from seraphine.push.routes import router as push_router
    from mod_tasks.routes import router as tasks_router

    app.include_router(finance_router)
    app.include_router(push_router)
    app.include_router(tasks_router)
    app.include_router(recurring_router)
    app.include_router(habits_router)
    app.include_router(water_router)
    app.include_router(health_router)
    app.include_router(insights_router)
    app.include_router(notes_router)
    app.include_router(work_router)
    app.include_router(music_router)
    app.include_router(mood_router)
    app.include_router(journal_router)
    app.include_router(focus_router)
    app.include_router(goals_router)
    app.include_router(cv_triage_router)
    app.include_router(reading_router)
    app.include_router(planning_router)
    app.include_router(contextual_router)
    app.include_router(notifications_router)
    app.include_router(deepsearch_router)

    from seraphine.calendar_agg.routes import router as calendar_agg_router
    app.include_router(calendar_agg_router)

    from seraphine.telemetry.routes import router as telemetry_router
    app.include_router(telemetry_router)

    from seraphine.llm.routes import router as llm_router
    app.include_router(llm_router)

    from seraphine.learning.routes import router as learning_router
    app.include_router(learning_router)

    from seraphine.reminders.routes import router as reminders_router

    app.include_router(reminders_router)
    # NOTE: frontend vite proxy needs /tasks, /recurring, /reminders added

    if settings.whatsapp_bridge_url:
        from seraphine.whatsapp.routes import router as whatsapp_router

        app.include_router(whatsapp_router)

    # Unified WhatsApp Manager (covers Aura's bridge too via seraphine-net).
    if settings.whatsapp_bridge_url or settings.whatsapp_aura_bridge_url:
        from seraphine.wa_manager.routes import router as wa_manager_router
        from seraphine.wa_manager.page import router as wa_manager_page_router

        app.include_router(wa_manager_router)
        # Standalone HTML page at /wa (browser-accessible, no SPA needed).
        app.include_router(wa_manager_page_router)

    logger.info("Seraphine app initialized (model=%s)", settings.llm_model)
    return app


app = create_app()
