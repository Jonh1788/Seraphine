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
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

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
expression tag. Foque em: o que ele fez hoje, como pareceu estar,
1 pergunta aberta no fim pra convidar reflexão. Nada de lista.
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
    ) -> None:
        self.app_state = app_state
        self.enabled = enabled
        self._sched = AsyncIOScheduler(timezone=str(TZ))
        self._day_review_hour = day_review_hour
        self._stalled_hour = stalled_hour
        self._weekly_hour = weekly_hour
        self._last_day_review_date: str | None = None

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
        self._sched.start()
        logger.info("proactive scheduler started")

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
            await self._push_nudge(
                title="Resumo da semana",
                body=text[:120] + ("…" if len(text) > 120 else ""),
                key=f"weekly:{datetime.now(TZ).date().isoformat()}",
            )
            await self._save_daily_reflection(
                datetime.now(TZ).date().isoformat(),
                text,
                tag="weekly",
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

    async def _broadcast_opener(self, text: str) -> None:
        """Send an `assistant_opener`-style frame to any connected WS."""
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
