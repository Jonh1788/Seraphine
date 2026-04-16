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
from llm_adapters.client import OllamaClient, OpenAICompatClient
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
from seraphine.recurring.service import RecurringService
from seraphine.habits import schema as habits_schema
from seraphine.habits.routes import router as habits_router
from seraphine.habits.service import HabitService
from seraphine.water import schema as water_schema
from seraphine.water.routes import router as water_router
from seraphine.water.service import WaterService

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
    await store.ensure_schema()

    if settings.llm_backend in ("anthropic", "claude_max"):
        from llm_adapters.anthropic import AnthropicClient

        if settings.llm_backend == "claude_max":
            from llm_adapters.keychain import get_access_token, KeychainError

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
    # Recurring tasks — always enabled (SQLite-backed)
    # ------------------------------------------------------------------
    recurring_service = None
    try:
        store.register_migrator("seraphine_recurring", recurring_schema.migrate)
        await store.ensure_schema()  # idempotent
        if task_service is not None:
            recurring_service = RecurringService(store, task_service)
            logger.info("Recurring service wired")
    except Exception as e:
        logger.warning("Recurring service failed (non-critical): %s", e)

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
        llm=llm,
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
    app.state.finance_service = finance_service
    app.state.task_service = task_service
    app.state.email_scanner = email_scanner
    app.state.reminder_scheduler = reminder_scheduler
    app.state.recurring_service = recurring_service
    app.state.habit_service = habit_service
    app.state.water_service = water_service
    app.state.push_service = push_service
    # Connected WS clients — the event listener pushes notifications here
    app.state.ws_clients: set = set()

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
                                await notify_reminder(
                                    app.state,
                                    f"water-{now_utc.isoformat()}",
                                    "Bora beber agua!",
                                )
                                await water_service.mark_reminder_fired(now_utc)
                                logger.info(
                                    "water reminder fired (last_intake=%s)",
                                    last_intake,
                                )
                except Exception:
                    logger.exception("water reminder loop iteration failed")
                try:
                    await asyncio.sleep(interval)
                except asyncio.CancelledError:
                    raise

        water_reminder_task = asyncio.create_task(_water_reminder_loop())

    logger.info("Seraphine lifespan started (model=%s)", settings.llm_model)
    try:
        yield
    finally:
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

    from mod_finance.routes import router as finance_router
    from seraphine.push.routes import router as push_router
    from mod_tasks.routes import router as tasks_router

    app.include_router(finance_router)
    app.include_router(push_router)
    app.include_router(tasks_router)
    app.include_router(recurring_router)
    app.include_router(habits_router)
    app.include_router(water_router)

    from seraphine.reminders.routes import router as reminders_router

    app.include_router(reminders_router)
    # NOTE: frontend vite proxy needs /tasks, /recurring, /reminders added

    if settings.whatsapp_bridge_url:
        from seraphine.whatsapp.routes import router as whatsapp_router

        app.include_router(whatsapp_router)

    logger.info("Seraphine app initialized (model=%s)", settings.llm_model)
    return app


app = create_app()
