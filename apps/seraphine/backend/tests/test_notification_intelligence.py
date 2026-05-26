"""Tests for 094 -- Notification Intelligence."""

from __future__ import annotations

import asyncio
import json
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest

from seraphine.notifications.schema import migrate
from seraphine.notifications.service import NotificationService
from seraphine.notifications.types import (
    BASE_PRIORITY,
    IMMEDIATE_THRESHOLD,
    NotificationSettings,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class FakeStore:
    """Minimal in-memory SQLite store that looks like core_db.Store.

    ``check_same_thread=False`` so ``asyncio.to_thread`` works in tests.
    """

    def __init__(self) -> None:
        self._db = sqlite3.connect(":memory:", check_same_thread=False)
        self._db.execute("PRAGMA journal_mode=WAL")
        migrate(self._db)

    def _connect(self) -> sqlite3.Connection:
        return self._db


# ---------------------------------------------------------------------------
# Types tests
# ---------------------------------------------------------------------------


class TestNotificationSettings:
    def test_round_trip(self) -> None:
        s = NotificationSettings()
        d = s.to_dict()
        s2 = NotificationSettings.from_dict(d)
        assert s2.quiet_hours_start == "23:00"
        assert s2.quiet_hours_end == "07:00"
        assert s2.batching_enabled is True
        assert s2.per_type_enabled["water"] is True

    def test_from_partial_dict(self) -> None:
        s = NotificationSettings.from_dict({"quiet_hours_start": "22:00"})
        assert s.quiet_hours_start == "22:00"
        assert s.quiet_hours_end == "07:00"  # default


class TestBasePriority:
    def test_reminder_timed_high(self) -> None:
        assert BASE_PRIORITY["reminder_timed"] >= IMMEDIATE_THRESHOLD

    def test_water_low(self) -> None:
        assert BASE_PRIORITY["water"] < IMMEDIATE_THRESHOLD

    def test_opener_low(self) -> None:
        assert BASE_PRIORITY["opener"] < IMMEDIATE_THRESHOLD


# ---------------------------------------------------------------------------
# Schema tests
# ---------------------------------------------------------------------------


class TestSchema:
    def test_migrate_idempotent(self) -> None:
        conn = sqlite3.connect(":memory:")
        migrate(conn)
        migrate(conn)  # should not raise
        tables = {
            r[0]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        assert "notification_settings" in tables
        assert "notification_feedback" in tables
        assert "notification_queue" in tables


# ---------------------------------------------------------------------------
# Service tests
# ---------------------------------------------------------------------------


class TestNotificationService:
    @pytest.fixture
    def store(self) -> FakeStore:
        return FakeStore()

    @pytest.fixture
    def svc(self, store: FakeStore) -> NotificationService:
        return NotificationService(store)

    @pytest.mark.asyncio
    async def test_get_default_settings(self, svc: NotificationService) -> None:
        s = await svc.get_settings()
        assert s.quiet_hours_start == "23:00"
        assert s.batching_enabled is True

    @pytest.mark.asyncio
    async def test_update_settings(self, svc: NotificationService) -> None:
        updated = await svc.update_settings({"quiet_hours_start": "22:30"})
        assert updated.quiet_hours_start == "22:30"
        # Reload
        svc._settings = None  # clear cache
        reloaded = await svc.get_settings()
        assert reloaded.quiet_hours_start == "22:30"

    @pytest.mark.asyncio
    async def test_compute_priority_base(self, svc: NotificationService) -> None:
        p = await svc.compute_priority("reminder_timed")
        assert p == 90  # base, no feedback
        p2 = await svc.compute_priority("water")
        assert p2 == 30

    @pytest.mark.asyncio
    async def test_priority_with_interaction_boost(
        self, svc: NotificationService,
    ) -> None:
        # Record a positive interaction
        await svc.record_feedback("n1", "water", "opened")
        p = await svc.compute_priority("water")
        assert p == 40  # 30 base + 10 boost

    @pytest.mark.asyncio
    async def test_priority_with_dismiss_decay(
        self, svc: NotificationService,
    ) -> None:
        # Dismiss 3 in a row
        for i in range(3):
            await svc.record_feedback(f"d{i}", "opener", "dismissed")
        p = await svc.compute_priority("opener")
        assert p == 0  # 10 base - 20 decay, clamped to 0

    @pytest.mark.asyncio
    async def test_should_deliver_high_priority(
        self, svc: NotificationService,
    ) -> None:
        # High priority always delivers
        result = await svc.should_deliver("reminder_timed")
        assert result is True

    @pytest.mark.asyncio
    async def test_should_deliver_type_disabled(
        self, svc: NotificationService,
    ) -> None:
        await svc.update_settings(
            {"per_type_enabled": {"water": False, "reminder_timed": True}}
        )
        result = await svc.should_deliver("water")
        assert result is False

    @pytest.mark.asyncio
    async def test_queue_and_flush(self, svc: NotificationService) -> None:
        item = await svc.queue_notification(
            type="water", title="Agua", body="Bora beber agua!",
        )
        assert item["id"]
        assert item["type"] == "water"

        pending = await svc.get_pending_queue()
        assert len(pending) == 1
        assert pending[0]["body"] == "Bora beber agua!"

        flushed = await svc.flush_queue()
        assert len(flushed) == 1

        # After flush, pending should be empty
        pending2 = await svc.get_pending_queue()
        assert len(pending2) == 0

    @pytest.mark.asyncio
    async def test_record_feedback_invalid_action(
        self, svc: NotificationService,
    ) -> None:
        with pytest.raises(ValueError, match="invalid action"):
            await svc.record_feedback("n1", "water", "clicked")

    @pytest.mark.asyncio
    async def test_get_priority_weights(
        self, svc: NotificationService,
    ) -> None:
        weights = await svc.get_priority_weights()
        assert "reminder_timed" in weights
        assert "water" in weights
        assert weights["reminder_timed"] >= weights["water"]

    @pytest.mark.asyncio
    async def test_dnd_status(self, svc: NotificationService) -> None:
        status = await svc.get_dnd_status()
        assert "dnd" in status
        assert "reasons" in status

    @pytest.mark.asyncio
    async def test_is_in_meeting_no_google(
        self, svc: NotificationService,
    ) -> None:
        result = await svc._is_in_meeting()
        assert result is False

    @pytest.mark.asyncio
    async def test_is_focus_active_returns_false(
        self, svc: NotificationService,
    ) -> None:
        result = await svc._is_focus_active()
        assert result is False
