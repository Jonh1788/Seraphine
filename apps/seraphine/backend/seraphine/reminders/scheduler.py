"""APScheduler-based reminder scheduler with SQLite persistence."""

from __future__ import annotations

import logging
import uuid
from datetime import datetime
from typing import Any, Callable
from zoneinfo import ZoneInfo

from apscheduler.executors.asyncio import AsyncIOExecutor
from apscheduler.jobstores.sqlalchemy import SQLAlchemyJobStore
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.date import DateTrigger
from apscheduler.triggers.interval import IntervalTrigger

logger = logging.getLogger(__name__)

SP_TZ = ZoneInfo("America/Sao_Paulo")

RECURRING_MAP: dict[str, dict[str, Any]] = {
    "hourly": {"hours": 1},
    "daily": {"days": 1},
    "weekly": {"weeks": 1},
}

# Global callback — set once by ReminderScheduler.__init__.
# Must be top-level so APScheduler can pickle the job function reference.
_fire_callback: Callable[[str, str], Any] | None = None


def _fire_job(reminder_id: str, message: str) -> None:
    """Top-level job function called by APScheduler. Delegates to the registered callback."""
    if _fire_callback is not None:
        _fire_callback(reminder_id, message)
    else:
        logger.warning("Reminder fired but no callback registered: %s", reminder_id)


class ReminderScheduler:
    """Manage scheduled reminders backed by APScheduler + SQLite."""

    def __init__(self, sqlite_path: str, on_fire: Callable[[str, str], Any]) -> None:
        global _fire_callback
        _fire_callback = on_fire
        jobstores = {"default": SQLAlchemyJobStore(url=f"sqlite:///{sqlite_path}")}
        executors = {"default": AsyncIOExecutor()}
        job_defaults = {"coalesce": True, "max_instances": 1, "misfire_grace_time": 300}
        self._scheduler = AsyncIOScheduler(
            jobstores=jobstores,
            executors=executors,
            job_defaults=job_defaults,
            timezone=SP_TZ,
        )

    async def start(self) -> None:
        self._scheduler.start()
        logger.info("ReminderScheduler started")

    async def stop(self) -> None:
        self._scheduler.shutdown(wait=False)
        logger.info("ReminderScheduler stopped")

    def add_reminder(
        self,
        fire_at: datetime,
        message: str,
        reminder_id: str | None = None,
        recurring: str | None = None,
    ) -> str:
        rid = reminder_id or str(uuid.uuid4())

        if recurring and recurring in RECURRING_MAP:
            trigger = IntervalTrigger(
                start_date=fire_at,
                timezone=SP_TZ,
                **RECURRING_MAP[recurring],
            )
        else:
            trigger = DateTrigger(run_date=fire_at, timezone=SP_TZ)

        self._scheduler.add_job(
            _fire_job,
            trigger=trigger,
            args=[rid, message],
            id=rid,
            replace_existing=True,
            name=message[:80],
        )
        logger.info("Reminder added: id=%s fire_at=%s recurring=%s", rid, fire_at, recurring)
        return rid

    def cancel_reminder(self, reminder_id: str) -> bool:
        try:
            self._scheduler.remove_job(reminder_id)
            logger.info("Reminder cancelled: %s", reminder_id)
            return True
        except Exception:
            logger.warning("Reminder not found for cancellation: %s", reminder_id)
            return False

    def list_reminders(self) -> list[dict[str, Any]]:
        jobs = self._scheduler.get_jobs()
        out: list[dict[str, Any]] = []
        for job in jobs:
            # Extract message from positional args
            message = job.args[1] if len(job.args) >= 2 else ""
            trigger = job.trigger
            recurring: str | None = None
            if isinstance(trigger, IntervalTrigger):
                total_secs = int(trigger.interval.total_seconds())
                for label, kwargs in RECURRING_MAP.items():
                    iv = IntervalTrigger(**kwargs)
                    if int(iv.interval.total_seconds()) == total_secs:
                        recurring = label
                        break
            fire_at: str | None = None
            if isinstance(trigger, DateTrigger):
                fire_at = str(trigger.run_date)
            elif hasattr(trigger, "start_date") and trigger.start_date:
                fire_at = str(trigger.start_date)
            out.append({
                "id": job.id,
                "message": message,
                "fire_at": fire_at,
                "recurring": recurring,
                "next_run": str(job.next_run_time) if job.next_run_time else None,
            })
        return out
