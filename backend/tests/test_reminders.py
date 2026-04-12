"""Tests for the reminders system — scheduler, tools, time parsing."""

from __future__ import annotations

import asyncio
import os
import tempfile
from datetime import datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, patch
from zoneinfo import ZoneInfo

import pytest

SP_TZ = ZoneInfo("America/Sao_Paulo")


# ---------------------------------------------------------------------------
# Time parsing
# ---------------------------------------------------------------------------
from seraphine.tools.reminders import _parse_time


class TestParseTime:
    def test_iso8601_with_tz(self) -> None:
        dt = _parse_time("2026-04-12T14:00:00-03:00")
        assert dt is not None
        assert dt.hour == 14
        assert dt.minute == 0

    def test_iso8601_no_tz(self) -> None:
        dt = _parse_time("2026-12-25T09:30:00")
        assert dt is not None
        assert dt.tzinfo == SP_TZ
        assert dt.hour == 9
        assert dt.minute == 30

    def test_time_hhmm(self) -> None:
        dt = _parse_time("14:00")
        assert dt is not None
        assert dt.hour == 14
        assert dt.minute == 0
        assert dt.tzinfo == SP_TZ

    def test_time_hh_h(self) -> None:
        dt = _parse_time("14h")
        assert dt is not None
        assert dt.hour == 14

    def test_time_hh_hmm(self) -> None:
        dt = _parse_time("14h30")
        assert dt is not None
        assert dt.hour == 14
        assert dt.minute == 30

    def test_relative_minutes(self) -> None:
        before = datetime.now(SP_TZ)
        dt = _parse_time("em 30 minutos")
        assert dt is not None
        # Should be ~30 minutes from now
        diff = (dt - before).total_seconds()
        assert 29 * 60 <= diff <= 31 * 60

    def test_relative_hours(self) -> None:
        before = datetime.now(SP_TZ)
        dt = _parse_time("em 2 horas")
        assert dt is not None
        diff = (dt - before).total_seconds()
        assert 119 * 60 <= diff <= 121 * 60

    def test_relative_shorthand_m(self) -> None:
        before = datetime.now(SP_TZ)
        dt = _parse_time("+15m")
        assert dt is not None
        diff = (dt - before).total_seconds()
        assert 14 * 60 <= diff <= 16 * 60

    def test_relative_shorthand_h(self) -> None:
        before = datetime.now(SP_TZ)
        dt = _parse_time("+1h")
        assert dt is not None
        diff = (dt - before).total_seconds()
        assert 59 * 60 <= diff <= 61 * 60

    def test_invalid(self) -> None:
        assert _parse_time("blahblah") is None
        assert _parse_time("") is None

    def test_past_time_schedules_tomorrow(self) -> None:
        """If user says '01:00' and it's already past 1am, schedule tomorrow."""
        dt = _parse_time("01:00")
        now = datetime.now(SP_TZ)
        if dt is not None:
            assert dt > now


# ---------------------------------------------------------------------------
# Scheduler
# ---------------------------------------------------------------------------
from seraphine.reminders.scheduler import ReminderScheduler


def _make_test_scheduler():
    """Create a scheduler with in-memory jobstore (avoids pickle issues with local funcs)."""
    from apscheduler.executors.asyncio import AsyncIOExecutor
    from apscheduler.schedulers.asyncio import AsyncIOScheduler

    fired: list[tuple[str, str]] = []

    def on_fire(rid, msg):
        fired.append((rid, msg))

    sched = ReminderScheduler.__new__(ReminderScheduler)
    sched._on_fire = on_fire
    # Use default memory jobstore instead of SQLAlchemy to avoid pickle
    sched._scheduler = AsyncIOScheduler(
        executors={"default": AsyncIOExecutor()},
        job_defaults={"coalesce": True, "max_instances": 1, "misfire_grace_time": 300},
        timezone=SP_TZ,
    )
    sched._fired = fired
    return sched


class TestScheduler:
    @pytest.fixture()
    def scheduler(self):
        return _make_test_scheduler()

    @pytest.mark.asyncio
    async def test_add_and_list(self, scheduler) -> None:
        await scheduler.start()
        try:
            fire_at = datetime.now(SP_TZ) + timedelta(hours=1)
            rid = scheduler.add_reminder(fire_at, "Test reminder")
            assert rid
            reminders = scheduler.list_reminders()
            assert len(reminders) == 1
            assert reminders[0]["id"] == rid
            assert reminders[0]["message"] == "Test reminder"
        finally:
            await scheduler.stop()

    @pytest.mark.asyncio
    async def test_cancel(self, scheduler) -> None:
        await scheduler.start()
        try:
            fire_at = datetime.now(SP_TZ) + timedelta(hours=1)
            rid = scheduler.add_reminder(fire_at, "To be cancelled")
            assert scheduler.cancel_reminder(rid) is True
            assert len(scheduler.list_reminders()) == 0
            # Cancelling again should return False
            assert scheduler.cancel_reminder(rid) is False
        finally:
            await scheduler.stop()

    @pytest.mark.asyncio
    async def test_recurring(self, scheduler) -> None:
        await scheduler.start()
        try:
            fire_at = datetime.now(SP_TZ) + timedelta(hours=1)
            rid = scheduler.add_reminder(fire_at, "Daily check", recurring="daily")
            reminders = scheduler.list_reminders()
            assert len(reminders) == 1
            assert reminders[0]["recurring"] == "daily"
        finally:
            await scheduler.stop()

    @pytest.mark.asyncio
    async def test_custom_id(self, scheduler) -> None:
        await scheduler.start()
        try:
            fire_at = datetime.now(SP_TZ) + timedelta(hours=1)
            rid = scheduler.add_reminder(fire_at, "Custom", reminder_id="my-id-123")
            assert rid == "my-id-123"
            reminders = scheduler.list_reminders()
            assert reminders[0]["id"] == "my-id-123"
        finally:
            await scheduler.stop()


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------
from seraphine.tools.reminders import (
    CancelReminderTool,
    CreateReminderTool,
    ListRemindersTool,
)


class TestCreateReminderTool:
    @pytest.mark.asyncio
    async def test_create_ok(self, tmp_path) -> None:
        mock_sched = MagicMock()
        mock_sched.add_reminder.return_value = "abc-123"
        tool = CreateReminderTool(mock_sched)
        result = await tool.execute({
            "message": "Ligar pro Rodrigo",
            "time": "2026-04-12T14:00:00-03:00",
        })
        assert result.ok is True
        assert "abc-123" in result.output
        mock_sched.add_reminder.assert_called_once()

    @pytest.mark.asyncio
    async def test_create_missing_message(self) -> None:
        tool = CreateReminderTool(MagicMock())
        result = await tool.execute({"message": "", "time": "14:00"})
        assert result.ok is False

    @pytest.mark.asyncio
    async def test_create_bad_time(self) -> None:
        tool = CreateReminderTool(MagicMock())
        result = await tool.execute({"message": "test", "time": "not-a-time"})
        assert result.ok is False

    @pytest.mark.asyncio
    async def test_create_recurring(self) -> None:
        mock_sched = MagicMock()
        mock_sched.add_reminder.return_value = "rec-1"
        tool = CreateReminderTool(mock_sched)
        result = await tool.execute({
            "message": "Daily standup",
            "time": "09:00",
            "recurring": "daily",
        })
        assert result.ok is True
        assert "daily" in result.output
        _, kwargs = mock_sched.add_reminder.call_args
        assert kwargs["recurring"] == "daily"


class TestListRemindersTool:
    @pytest.mark.asyncio
    async def test_empty(self) -> None:
        mock_sched = MagicMock()
        mock_sched.list_reminders.return_value = []
        tool = ListRemindersTool(mock_sched)
        result = await tool.execute({})
        assert result.ok is True
        assert "Nenhum" in result.output

    @pytest.mark.asyncio
    async def test_with_items(self) -> None:
        mock_sched = MagicMock()
        mock_sched.list_reminders.return_value = [
            {"id": "x", "message": "Test", "next_run": "2026-04-12 14:00", "recurring": None},
        ]
        tool = ListRemindersTool(mock_sched)
        result = await tool.execute({})
        assert result.ok is True
        assert "Test" in result.output


class TestCancelReminderTool:
    @pytest.mark.asyncio
    async def test_cancel_ok(self) -> None:
        mock_sched = MagicMock()
        mock_sched.cancel_reminder.return_value = True
        tool = CancelReminderTool(mock_sched)
        result = await tool.execute({"reminder_id": "abc"})
        assert result.ok is True

    @pytest.mark.asyncio
    async def test_cancel_not_found(self) -> None:
        mock_sched = MagicMock()
        mock_sched.cancel_reminder.return_value = False
        tool = CancelReminderTool(mock_sched)
        result = await tool.execute({"reminder_id": "nope"})
        assert result.ok is False

    @pytest.mark.asyncio
    async def test_cancel_missing_id(self) -> None:
        tool = CancelReminderTool(MagicMock())
        result = await tool.execute({"reminder_id": ""})
        assert result.ok is False
