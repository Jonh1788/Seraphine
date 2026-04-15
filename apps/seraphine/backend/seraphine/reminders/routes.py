"""Reminders HTTP API -- list and cancel scheduled reminders."""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request

from seraphine.reminders.scheduler import ReminderScheduler

router = APIRouter(prefix="/reminders", tags=["reminders"])
logger = logging.getLogger(__name__)


def _scheduler_or_503(request: Request) -> ReminderScheduler:
    svc: Optional[ReminderScheduler] = getattr(
        request.app.state, "reminder_scheduler", None,
    )
    if svc is None:
        raise HTTPException(status_code=503, detail="reminder scheduler not configured")
    return svc


@router.get("")
async def list_reminders(request: Request) -> dict[str, Any]:
    scheduler = _scheduler_or_503(request)
    reminders = scheduler.list_reminders()
    return {"reminders": reminders}


@router.delete("/{reminder_id}")
async def cancel_reminder(request: Request, reminder_id: str) -> dict[str, Any]:
    scheduler = _scheduler_or_503(request)
    ok = scheduler.cancel_reminder(reminder_id)
    if not ok:
        raise HTTPException(status_code=404, detail=f"Reminder {reminder_id} not found")
    return {"ok": True, "id": reminder_id}
