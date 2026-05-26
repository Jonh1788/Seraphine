"""024 — Proactive Scheduler.

Background jobs that make Seraphine reach out without waiting for user
input. Each job decides whether to stay quiet or push a notification
(and optionally open a conversation opener).

Three ticks:
- **stalled_tasks** (daily, 20:00): tasks untouched > 7 days get at
  most one nudge/week.
- **weekly_reflection** (Sundays, 21:00): LLM-generated week recap,
  delivered as `daily_reflection` record + push.
- **day_review** (daily, 21:00): smaller "day recap" if ≥ 3 turns
  happened today.

All jobs run only when `settings.proactive_enabled` is True (default).
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from apscheduler.events import EVENT_JOB_ERROR, EVENT_JOB_EXECUTED
from apscheduler.schedulers.asyncio import AsyncIOScheduler

from llm_adapters.types import ChatMessage

logger = logging.getLogger("seraphine.proactive")

TZ = ZoneInfo("America/Sao_Paulo")

_WEEKLY_PROMPT = """Você é Seraphine escrevendo uma reflexão semanal pro
Jonathan. Use o contexto fornecido e gere:

- 3-5 bullets curtos com observações concretas
- 1 frase final de encerramento curta e carinhosa (com expression tag)

Formato:
[warm] Semana de DD/MM - DD/MM:
- <bullet 1>
- <bullet 2>
...

<frase de encerramento>

Só PT-BR. Sem prefácio.
"""

_DAY_REVIEW_PROMPT = """Você é Seraphine fazendo um check-in rápido do
dia pro Jonathan. Gere 2-3 frases naturais, PT-BR, com pelo menos 1
expression tag. Foque APENAS no que estiver concretamente no excerto de
conversa fornecido (o que ele fez hoje, como pareceu estar) + 1
pergunta aberta no fim pra convidar reflexão. Nada de lista.

REGRA IMPORTANTE: se o excerto tiver pouca substância (ex: só
small-talk, comandos curtos, sem temas concretos), NÃO invente atividades
ou detalhes a partir de memória antiga / contexto estagnado. Nesse caso,
faça check-in leve e direto ("como foi o dia?" / "fim de dia tranquilo?")
sem confabular sobre tarefas, projetos ou eventos que não aparecem no
excerto de hoje. Sem inventar.
"""


class ProactiveScheduler:
    def __init__(
        self,
        app_state: Any,
        *,
        enabled: bool = True,
        day_review_hour: int = 21,
        stalled_hour: int = 20,
        weekly_hour: int = 21,
        goal_service: Any | None = None,
        mood_service: Any | None = None,
    ) -> None:
        self.app_state = app_state
        self.enabled = enabled
        self._sched = AsyncIOScheduler(timezone=str(TZ))
        self._day_review_hour = day_review_hour
        self._stalled_hour = stalled_hour
        self._weekly_hour = weekly_hour
        self._last_day_review_date: str | None = None
        self._goal_service = goal_service
        self._mood_service = mood_service
        self._last_mood_checkin_date: str | None = None

    def start(self) -> None:
        if not self.enabled:
            logger.info("proactive scheduler disabled via config")
            return
        self._sched.add_job(
            self._tick_stalled_tasks,
            "cron", hour=self._stalled_hour, minute=0,
            name="stalled_tasks",
        )
        self._sched.add_job(
            self._tick_weekly_reflection,
            "cron", day_of_week="sun", hour=self._weekly_hour, minute=0,
            name="weekly_reflection",
        )
        self._sched.add_job(
            self._tick_day_review,
            "cron", hour=self._day_review_hour, minute=0,
            name="day_review",
        )
        # 030-A: daily curiosity cycle. Run mid-morning so discoveries
        # are fresh when the user starts the day.
        self._sched.add_job(
            self._tick_curiosity,
            "cron", hour=9, minute=0,
            name="curiosity",
        )
        # 030-B: finance anomaly scan.
        self._sched.add_job(
            self._tick_finance_ambient,
            "cron", hour=10, minute=0,
            name="finance_ambient",
        )
        # 028-B: detect anticipation patterns weekly.
        self._sched.add_job(
            self._tick_anticipation,
            "cron", day_of_week="mon", hour=6, minute=0,
            name="anticipation",
        )
        # Goals auto-update: refresh key results from data sources daily.
        self._sched.add_job(
            self._tick_goals_auto_update,
            "cron", hour=5, minute=0,
            name="goals_auto_update",
        )
        # Mood check-in: ask user how they feel if no mood logged today.
        self._sched.add_job(
            self._tick_mood_checkin,
            "cron", hour=14, minute=0,
            name="mood_checkin",
        )
        # 028-C: aggregate meta-learning style prefs weekly.
        self._sched.add_job(
            self._tick_metalearning,
            "cron", day_of_week="mon", hour=6, minute=30,
            name="metalearning",
        )
        # 040 — track runs so the inspector UI can show last status.
        self._sched.add_listener(
            self._on_job_event, EVENT_JOB_EXECUTED | EVENT_JOB_ERROR,
        )
        self._sched.start()
        self._apply_persisted_pauses()
        logger.info("proactive scheduler started")

    def _on_job_event(self, event: Any) -> None:
        name = getattr(event, "job_id", "?")
        ok = event.exception is None if hasattr(event, "exception") else True
        err = str(event.exception) if getattr(event, "exception", None) else None
        entry = {
            "name": name,
            "finished_at": datetime.now(TZ).isoformat(),
            "ok": ok,
            "error": err,
        }
        store = getattr(self.app_state, "store", None)
        if store is None:
            return
        import asyncio as _aio
        try:
            loop = _aio.get_event_loop()
            loop.create_task(store.add_event(
                event_type="scheduler_run",
                summary=f"{name} {'OK' if ok else 'ERROR'}",
                source="proactive",
                metadata=entry,
            ))
        except Exception:
            pass

    def list_jobs(self) -> list[dict[str, Any]]:
        """040 inspector: snapshot of current jobs with next run time."""
        out: list[dict[str, Any]] = []
        for job in self._sched.get_jobs():
            next_run = getattr(job, "next_run_time", None)
            out.append({
                "id": job.id,
                "name": job.name,
                "next_run_time": next_run.isoformat() if next_run else None,
                "trigger": str(job.trigger),
                "paused": next_run is None,
            })
        return out

    def set_job_paused(self, name: str, paused: bool) -> bool:
        """Pause/resume a job by name or id and persist that preference."""
        for job in self._sched.get_jobs():
            if job.id == name or job.name == name:
                if paused:
                    self._sched.pause_job(job.id)
                else:
                    self._sched.resume_job(job.id)
                self._persist_job_pause(job.id, paused)
                return True
        return False

    def _apply_persisted_pauses(self) -> None:
        store = getattr(self.app_state, "store", None)
        if store is None:
            return
        try:
            with store._connect() as conn:
                rows = conn.execute(
                    "SELECT job_id FROM seraphine_proactive_job_prefs "
                    "WHERE paused = 1"
                ).fetchall()
            paused = {str(row[0]) for row in rows}
        except Exception as e:
            logger.warning("load proactive job prefs failed: %s", e)
            return
        for job_id in paused:
            try:
                self._sched.pause_job(job_id)
            except Exception:
                logger.debug("could not pause missing proactive job %s", job_id)

    def _persist_job_pause(self, job_id: str, paused: bool) -> None:
        store = getattr(self.app_state, "store", None)
        if store is None:
            return
        try:
            with store._connect() as conn:
                if paused:
                    conn.execute(
                        "INSERT INTO seraphine_proactive_job_prefs(job_id, paused, updated_at) "
                        "VALUES (?, 1, ?) "
                        "ON CONFLICT(job_id) DO UPDATE SET paused = 1, updated_at = excluded.updated_at",
                        (job_id, datetime.now(timezone.utc).isoformat()),
                    )
                else:
                    conn.execute(
                        "DELETE FROM seraphine_proactive_job_prefs WHERE job_id = ?",
                        (job_id,),
                    )
        except Exception as e:
            logger.warning("persist proactive job pref failed: %s", e)

    async def run_job_now(self, name: str) -> bool:
        """040 inspector: dispatch a job immediately (by name or id)."""
        for job in self._sched.get_jobs():
            if job.id == name or job.name == name:
                func = job.func
                if callable(func):
                    maybe = func()
                    import inspect as _i
                    if _i.iscoroutine(maybe):
                        await maybe
                return True
        return False

    def stop(self) -> None:
        if self._sched.running:
            self._sched.shutdown(wait=False)

    # -- tasks ------------------------------------------------------

    async def _tick_stalled_tasks(self) -> None:
        try:
            task_service = getattr(self.app_state, "task_service", None)
            if task_service is None:
                return
            # Heuristic: list open tasks, filter those whose last update
            # (or created_at fallback) is > 7 days ago.
            if hasattr(task_service, "list_stalled"):
                stalled = await task_service.list_stalled(min_days=7, limit=2)
            else:
                return
            for task in stalled:
                await self._push_nudge(
                    title="Uma tarefa parada por aí",
                    body=f"'{task.get('title', '')}' tá parada há 7+ dias.",
                    key=f"stalled:{task.get('id')}",
                )
        except Exception as e:
            logger.warning("tick_stalled_tasks: %s", e)

    async def _tick_day_review(self) -> None:
        today = datetime.now(TZ).date().isoformat()
        if self._last_day_review_date == today:
            return
        try:
            store = getattr(self.app_state, "store", None)
            llm = getattr(self.app_state, "llm", None)
            if store is None or llm is None:
                return
            turns = await store.get_recent_turns(limit=50)
            today_turns = [t for t in turns if t.created_at.startswith(today)]
            if len(today_turns) < 3:
                return  # not enough to reflect on

            excerpt = "\n".join(
                f"[{t.role}] {t.content[:200]}" for t in today_turns[-20:]
            )
            text = await self._llm_quick(
                llm, system_prompt=_DAY_REVIEW_PROMPT, user_content=excerpt,
                temperature=0.8, cap=180,
            )
            if not text:
                return
            await self._save_daily_reflection(today, text)
            await self._broadcast_opener(text)
            await self._save_journal_entry(
                today, text, entry_type="day_review",
            )
            self._last_day_review_date = today
        except Exception as e:
            logger.warning("tick_day_review: %s", e)

    async def _tick_curiosity(self) -> None:
        try:
            llm = getattr(self.app_state, "llm", None)
            store = getattr(self.app_state, "store", None)
            tools = getattr(self.app_state, "tools", None)
            if llm is None or store is None:
                return
            from seraphine.curiosity import CuriosityService
            n = await CuriosityService(store, llm, tools).tick()
            if n:
                logger.info("curiosity tick: %d new", n)
        except Exception as e:
            logger.warning("tick_curiosity: %s", e)

    async def _tick_metalearning(self) -> None:
        try:
            store = getattr(self.app_state, "store", None)
            if store is None:
                return
            from seraphine.metalearning import aggregate_style_prefs
            data = await aggregate_style_prefs(store)
            if data:
                logger.info("metalearning tick: prefs updated")
        except Exception as e:
            logger.warning("tick_metalearning: %s", e)

    async def _tick_anticipation(self) -> None:
        try:
            store = getattr(self.app_state, "store", None)
            if store is None:
                return
            from seraphine.anticipation import AnticipationService
            n = await AnticipationService(store).detect_patterns()
            if n:
                logger.info("anticipation tick: %d rules", n)
        except Exception as e:
            logger.warning("tick_anticipation: %s", e)

    async def _tick_finance_ambient(self) -> None:
        try:
            finance = getattr(self.app_state, "finance_service", None)
            store = getattr(self.app_state, "store", None)
            if finance is None or store is None:
                return
            from seraphine.finance.ambient import FinanceAmbientService
            n = await FinanceAmbientService(finance, store).detect_and_store()
            if n:
                logger.info("finance ambient tick: %d new", n)
        except Exception as e:
            logger.warning("tick_finance_ambient: %s", e)

    async def _tick_goals_auto_update(self) -> None:
        try:
            goal_service = self._goal_service or getattr(
                self.app_state, "goal_service", None,
            )
            store = getattr(self.app_state, "store", None)
            if goal_service is None or store is None:
                return
            n = await goal_service.auto_update_key_results(store)
            if n:
                logger.info("goals auto-update tick: %d KRs updated", n)
        except Exception as e:
            logger.warning("tick_goals_auto_update: %s", e)

    async def _tick_mood_checkin(self) -> None:
        """Daily 14:00 — nudge user if no mood log exists today."""
        today = datetime.now(TZ).date().isoformat()
        if self._last_mood_checkin_date == today:
            return  # already asked today
        try:
            mood_service = self._mood_service or getattr(
                self.app_state, "mood_service", None,
            )
            if mood_service is None:
                return
            today_mood = await mood_service.get_today()
            current = today_mood.get("current") if today_mood else None
            if current:
                return  # already logged — skip

            text = "Como voce esta se sentindo hoje?"
            await self._broadcast_opener(text)
            await self._push_nudge(
                title="Check-in de humor",
                body=text,
                key=f"mood_checkin:{today}",
            )
            self._last_mood_checkin_date = today
        except Exception as e:
            logger.warning("tick_mood_checkin: %s", e)

    async def _tick_weekly_reflection(self) -> None:
        try:
            store = getattr(self.app_state, "store", None)
            llm = getattr(self.app_state, "llm", None)
            if store is None or llm is None:
                return
            ctx = await self._gather_weekly_context()
            if not ctx:
                return
            text = await self._llm_quick(
                llm, system_prompt=_WEEKLY_PROMPT, user_content=ctx,
                temperature=0.7, cap=400,
            )
            if not text:
                return
            today = datetime.now(TZ).date().isoformat()
            await self._push_nudge(
                title="Resumo da semana",
                body=text[:120] + ("…" if len(text) > 120 else ""),
                key=f"weekly:{today}",
            )
            await self._save_daily_reflection(today, text, tag="weekly")
            await self._save_journal_entry(
                today, text, entry_type="weekly_reflection",
            )
        except Exception as e:
            logger.warning("tick_weekly_reflection: %s", e)

    # -- helpers ----------------------------------------------------

    async def _gather_weekly_context(self) -> str | None:
        store = self.app_state.store
        now = datetime.now(TZ)
        week_ago = (now - timedelta(days=7)).isoformat()
        events = await store.get_events_since(week_ago)
        tasks_summary = ""
        task_service = getattr(self.app_state, "task_service", None)
        if task_service and hasattr(task_service, "weekly_summary"):
            try:
                ts_summary = await task_service.weekly_summary()
                tasks_summary = str(ts_summary) if ts_summary else ""
            except Exception:
                pass
        health_service = getattr(self.app_state, "health_service", None)
        health_summary = ""
        if health_service and hasattr(health_service, "get_weekly_report"):
            try:
                hs = await health_service.get_weekly_report()
                health_summary = str(hs)[:400] if hs else ""
            except Exception:
                pass
        if not events and not tasks_summary and not health_summary:
            return None
        parts: list[str] = []
        if tasks_summary:
            parts.append(f"TAREFAS DA SEMANA:\n{tasks_summary}")
        if health_summary:
            parts.append(f"SAÚDE DA SEMANA:\n{health_summary}")
        if events:
            event_lines = [
                f"- {e.get('event_type')}: {e.get('summary', '')[:80]}"
                for e in events[:15]
            ]
            parts.append("TIMELINE:\n" + "\n".join(event_lines))
        return "\n\n".join(parts)

    async def _llm_quick(
        self, llm: Any, *, system_prompt: str, user_content: str,
        temperature: float = 0.7, cap: int = 400,
    ) -> str | None:
        acc: list[str] = []
        try:
            async for tok in llm.chat(
                [
                    ChatMessage(role="system", content=system_prompt),
                    ChatMessage(role="user", content=user_content),
                ],
                temperature=temperature,
            ):
                if tok.text:
                    acc.append(tok.text)
                if sum(len(s) for s in acc) > cap:
                    break
        except Exception as e:
            logger.warning("_llm_quick failed: %s", e)
            return None
        text = "".join(acc).strip()
        return text or None

    async def _save_daily_reflection(
        self, date: str, text: str, tag: str = "daily",
    ) -> None:
        store = getattr(self.app_state, "store", None)
        if store is None:
            return
        try:
            await store.add_event(
                event_type="daily_reflection",
                summary=text[:2000],
                source="proactive",
                metadata={"date": date, "tag": tag},
            )
        except Exception as e:
            logger.debug("save_daily_reflection failed: %s", e)

    async def _push_nudge(self, *, title: str, body: str, key: str) -> None:
        # 094: check notification intelligence gate for non-urgent proactive nudges
        nsvc = getattr(self.app_state, "notification_service", None)
        if nsvc is not None:
            ntype = "stalled_task" if "stalled" in key else "day_review"
            try:
                if not await nsvc.should_deliver(ntype):
                    await nsvc.queue_notification(type=ntype, title=title, body=body)
                    logger.info("proactive nudge queued by notification intelligence (%s)", key)
                    return
            except Exception:
                pass  # fail-open

        push = getattr(self.app_state, "push_service", None)
        if push is None:
            return
        try:
            if hasattr(push, "send_to_all"):
                await push.send_to_all(title=title, body=body, tag=key)
            elif hasattr(push, "broadcast"):
                await push.broadcast(title=title, body=body)
        except Exception as e:
            logger.debug("push_nudge failed: %s", e)

    async def _save_journal_entry(
        self, date: str, text: str, *, entry_type: str,
    ) -> None:
        """Persist an auto-generated journal entry (idempotent)."""
        journal_service = getattr(self.app_state, "journal_service", None)
        if journal_service is None:
            return
        try:
            if await journal_service.exists(date=date, type=entry_type):
                return  # already created for this date+type

            # Attach today's mood if available
            mood_label: str | None = None
            mood_valence: float | None = None
            mood_service = getattr(self.app_state, "mood_service", None)
            if mood_service is not None:
                try:
                    today_mood = await mood_service.get_today()
                    current = today_mood.get("current")
                    if current:
                        mood_label = current.get("label")
                        mood_valence = current.get("valence")
                except Exception:
                    pass

            title_map = {
                "day_review": f"Revisao do dia — {date}",
                "weekly_reflection": f"Reflexao semanal — {date}",
            }
            await journal_service.create_entry(
                date=date,
                type=entry_type,
                title=title_map.get(entry_type, entry_type),
                content=text,
                mood_label=mood_label,
                mood_valence=mood_valence,
                source="proactive",
                source_id=f"{entry_type}:{date}",
            )
        except Exception as e:
            logger.debug("save_journal_entry failed: %s", e)

    async def _broadcast_opener(self, text: str) -> None:
        """Send an `assistant_opener`-style frame to any connected WS."""
        # 094: check notification intelligence gate
        nsvc = getattr(self.app_state, "notification_service", None)
        if nsvc is not None:
            try:
                if not await nsvc.should_deliver("day_review"):
                    await nsvc.queue_notification(
                        type="day_review", title="Day review", body=text[:200],
                    )
                    logger.info("day_review opener queued by notification intelligence")
                    return
            except Exception:
                pass  # fail-open

        ws_clients = getattr(self.app_state, "ws_clients", None) or set()
        for ws in list(ws_clients):
            try:
                await ws.send_json({
                    "type": "assistant_opener",
                    "text": text,
                    "source": "day_review",
                })
            except Exception:
                try:
                    ws_clients.discard(ws)
                except Exception:
                    pass
