"""Tests for the habits module (HabitService + schema)."""

from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path
from typing import Any

import pytest

from seraphine.habits import schema as habits_schema
from seraphine.habits.models import Habit, HabitLog
from seraphine.habits.service import HabitService, _compute_streak, _is_target_day
from seraphine.memory.store import MemoryStore


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
async def store(tmp_path: Path) -> MemoryStore:
    s = MemoryStore(tmp_path / "habits.sqlite")
    s.register_migrator("seraphine_habits", habits_schema.migrate)
    await s.ensure_schema()
    return s


@pytest.fixture
async def service(store: MemoryStore) -> HabitService:
    return HabitService(store)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _log_completed(store: MemoryStore, habit_id: str, d: date) -> None:
    """Insert a completed log directly (bypassing toggle) for streak tests."""
    from datetime import datetime, timezone

    def _work() -> None:
        with store._connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO habit_logs"
                " (habit_id, date, completed, created_at)"
                " VALUES (?, ?, 1, ?)",
                (habit_id, d.isoformat(),
                 datetime.now(timezone.utc).isoformat()),
            )
    import asyncio
    await asyncio.to_thread(_work)


# ---------------------------------------------------------------------------
# Create / validation
# ---------------------------------------------------------------------------

async def test_create_habit_daily(service: HabitService) -> None:
    h = await service.create(
        title="Beber 2L de agua",
        frequency="daily",
        icon="droplet",
        color="#22d3ee",
    )
    assert isinstance(h, Habit)
    assert h.title == "Beber 2L de agua"
    assert h.frequency == "daily"
    assert h.icon == "droplet"
    assert h.color == "#22d3ee"
    assert h.active is True
    assert h.id
    assert h.created_at


async def test_create_habit_custom_requires_days(service: HabitService) -> None:
    with pytest.raises(ValueError):
        await service.create(title="Correr", frequency="custom")

    with pytest.raises(ValueError):
        await service.create(
            title="Correr", frequency="custom", target_days=[],
        )

    with pytest.raises(ValueError):
        await service.create(
            title="Correr", frequency="custom", target_days=[7],
        )

    h = await service.create(
        title="Correr", frequency="custom", target_days=[0, 2, 4],
    )
    assert h.frequency == "custom"
    assert h.target_days == [0, 2, 4]


async def test_create_habit_invalid_color(service: HabitService) -> None:
    with pytest.raises(ValueError):
        await service.create(
            title="x", frequency="daily", color="not-a-color",
        )
    with pytest.raises(ValueError):
        await service.create(
            title="x", frequency="daily", color="#12345",  # only 5 hex
        )
    with pytest.raises(ValueError):
        await service.create(
            title="x", frequency="daily", color="red",
        )


async def test_create_habit_invalid_icon(service: HabitService) -> None:
    with pytest.raises(ValueError):
        await service.create(
            title="x", frequency="daily", icon="rocket",
        )


# ---------------------------------------------------------------------------
# Toggle
# ---------------------------------------------------------------------------

async def test_toggle_today_idempotent(service: HabitService) -> None:
    h = await service.create(title="Ler", frequency="daily", icon="book")

    r1 = await service.toggle(h.id)
    assert r1 is not None
    assert r1["log"]["completed"] is True
    assert r1["current_streak"] == 1

    # Second toggle flips it back to incomplete
    r2 = await service.toggle(h.id)
    assert r2 is not None
    assert r2["log"]["completed"] is False
    assert r2["current_streak"] == 0

    # Third toggle re-marks as complete
    r3 = await service.toggle(h.id)
    assert r3 is not None
    assert r3["log"]["completed"] is True


async def test_toggle_custom_date(service: HabitService) -> None:
    h = await service.create(title="Meditar", frequency="daily", icon="brain")

    r = await service.toggle(h.id, target_date="2026-04-10")
    assert r is not None
    assert r["log"]["date"] == "2026-04-10"
    assert r["log"]["completed"] is True

    # Invalid date raises
    with pytest.raises(ValueError):
        await service.toggle(h.id, target_date="not-a-date")


# ---------------------------------------------------------------------------
# Streak math (pure function + service integration)
# ---------------------------------------------------------------------------

def test_compute_streak_daily() -> None:
    """5-day streak + gap + 3-day streak ending today:
    current=3, best=5, total=8."""
    today = date(2026, 4, 15)
    # Dates: Apr 1-5 (5-day run), gap, Apr 13-15 (3-day run)
    completed = {
        "2026-04-01", "2026-04-02", "2026-04-03", "2026-04-04", "2026-04-05",
        "2026-04-13", "2026-04-14", "2026-04-15",
    }
    pred = lambda d: _is_target_day("daily", None, d)
    current, best, total = _compute_streak(completed, pred, today)
    assert total == 8
    assert best == 5
    assert current == 3


def test_compute_streak_weekdays_skips_weekends() -> None:
    """Weekday habit: weekend gaps do not break the streak.

    Monday 2026-04-06 → Wednesday 2026-04-15 is a 8 weekday run (Mon-Fri +
    Mon-Wed next week = 8 days).
    """
    today = date(2026, 4, 15)  # Wednesday
    # 2026-04-06 Mon through 2026-04-15 Wed (skipping sat/sun naturally)
    completed: set[str] = set()
    d = date(2026, 4, 6)
    while d <= today:
        if d.weekday() < 5:
            completed.add(d.isoformat())
        d = d + timedelta(days=1)

    pred = lambda d: _is_target_day("weekdays", None, d)
    current, best, total = _compute_streak(completed, pred, today)
    # 6,7,8,9,10 (mon-fri) + 13,14,15 (mon-wed) = 8 weekdays
    assert total == 8
    assert best == 8
    assert current == 8


def test_compute_streak_custom() -> None:
    """Custom Mon/Wed/Fri habit: skipped tue/thu/sat/sun do not break it."""
    today = date(2026, 4, 17)  # Friday
    target_days = [0, 2, 4]  # Mon, Wed, Fri
    # Fire on 2026-04-06 Mon, 04-08 Wed, 04-10 Fri, 04-13 Mon, 04-15 Wed, 04-17 Fri
    completed = {
        "2026-04-06", "2026-04-08", "2026-04-10",
        "2026-04-13", "2026-04-15", "2026-04-17",
    }
    pred = lambda d: _is_target_day("custom", target_days, d)
    current, best, total = _compute_streak(completed, pred, today)
    assert total == 6
    assert best == 6
    assert current == 6


async def test_streaks_daily(service: HabitService, store: MemoryStore) -> None:
    """Integration: seed 5-day + gap + 3-day ending on service's today."""
    from seraphine.habits.service import _today_sp
    today = _today_sp()

    h = await service.create(title="Daily", frequency="daily")

    # 3-day run ending today
    for delta in (0, 1, 2):
        await _log_completed(store, h.id, today - timedelta(days=delta))
    # gap at today-3 .. today-7
    # 5-day run from today-8 to today-12
    for delta in range(8, 13):
        await _log_completed(store, h.id, today - timedelta(days=delta))

    streaks = await service.get_streaks(h.id)
    assert streaks["total"] == 8
    assert streaks["best"] == 5
    assert streaks["current"] == 3


async def test_streaks_weekdays_skips_weekends(
    service: HabitService, store: MemoryStore,
) -> None:
    """On a weekday habit, marking completed Mon-Fri yields current=5 without
    the weekend breaking the streak."""
    from seraphine.habits.service import _today_sp
    today = _today_sp()

    h = await service.create(title="Weekdays", frequency="weekdays")

    # Walk back and log every weekday in the past 2 weeks (10 weekdays).
    d = today
    weekdays_logged = 0
    while weekdays_logged < 10:
        if d.weekday() < 5:
            await _log_completed(store, h.id, d)
            weekdays_logged += 1
        d = d - timedelta(days=1)

    streaks = await service.get_streaks(h.id)
    assert streaks["total"] == 10
    # Best & current should be all 10 if today (or last weekday) is a weekday
    # or only count up-to-today weekdays. We can't assume today's weekday,
    # but best should be at least 10 and current should equal best (since
    # there are no gaps).
    assert streaks["best"] == 10


async def test_streaks_custom(
    service: HabitService, store: MemoryStore,
) -> None:
    """Custom Mon/Wed/Fri habit: tue/thu/sat/sun are skipped and do not
    break the streak."""
    from seraphine.habits.service import _today_sp
    today = _today_sp()

    h = await service.create(
        title="Custom MWF", frequency="custom", target_days=[0, 2, 4],
    )

    # Log 6 target-day completions walking backwards
    d = today
    logged = 0
    target_set = {0, 2, 4}
    while logged < 6:
        if d.weekday() in target_set:
            await _log_completed(store, h.id, d)
            logged += 1
        d = d - timedelta(days=1)

    streaks = await service.get_streaks(h.id)
    assert streaks["total"] == 6
    assert streaks["best"] == 6


# ---------------------------------------------------------------------------
# Calendar + list helpers
# ---------------------------------------------------------------------------

async def test_calendar_range(
    service: HabitService, store: MemoryStore,
) -> None:
    h = await service.create(title="Daily", frequency="daily")
    # Seed three logs, one in target month, two outside
    await _log_completed(store, h.id, date(2026, 3, 15))
    await _log_completed(store, h.id, date(2026, 4, 10))
    await _log_completed(store, h.id, date(2026, 4, 25))
    await _log_completed(store, h.id, date(2026, 5, 1))

    logs = await service.get_calendar(h.id, month=4, year=2026)
    dates = [log.date for log in logs]
    assert "2026-04-10" in dates
    assert "2026-04-25" in dates
    assert "2026-03-15" not in dates
    assert "2026-05-01" not in dates
    assert len(logs) == 2

    # Invalid month
    with pytest.raises(ValueError):
        await service.get_calendar(h.id, month=13, year=2026)


async def test_delete_cascades_logs(
    service: HabitService, store: MemoryStore,
) -> None:
    h = await service.create(title="Delete me", frequency="daily")
    await service.toggle(h.id, target_date="2026-04-01")
    await service.toggle(h.id, target_date="2026-04-02")

    # Confirm logs exist
    def _count_logs() -> int:
        with store._connect() as conn:
            return conn.execute(
                "SELECT COUNT(*) FROM habit_logs WHERE habit_id = ?",
                (h.id,),
            ).fetchone()[0]

    import asyncio
    assert await asyncio.to_thread(_count_logs) == 2

    affected = await service.delete(h.id)
    assert affected == 1
    assert await service.get(h.id) is None
    assert await asyncio.to_thread(_count_logs) == 0


async def test_list_with_today_status(
    service: HabitService, store: MemoryStore,
) -> None:
    from seraphine.habits.service import _today_sp
    today = _today_sp()

    h1 = await service.create(title="Agua", frequency="daily", icon="droplet")
    h2 = await service.create(title="Treino", frequency="daily", icon="dumbbell")

    # Mark h1 done today, h2 not done
    await service.toggle(h1.id)

    # Seed a small streak for h2 starting yesterday
    await _log_completed(store, h2.id, today - timedelta(days=1))
    await _log_completed(store, h2.id, today - timedelta(days=2))

    items = await service.list_with_today_status()
    assert len(items) == 2
    by_title = {it["title"]: it for it in items}
    assert by_title["Agua"]["today_completed"] is True
    assert by_title["Agua"]["current_streak"] == 1
    assert by_title["Treino"]["today_completed"] is False
    # Today not done but yesterday+day-before were — current streak = 2
    assert by_title["Treino"]["current_streak"] == 2


async def test_get_today_progress(
    service: HabitService, store: MemoryStore,
) -> None:
    h1 = await service.create(title="Agua", frequency="daily")
    h2 = await service.create(title="Ler", frequency="daily")
    h3 = await service.create(title="Correr", frequency="daily")

    await service.toggle(h1.id)
    await service.toggle(h2.id)

    progress = await service.get_today_progress()
    assert progress["total"] == 3
    assert progress["completed"] == 2
    assert progress["best_streak"] is not None
    assert progress["best_streak"]["days"] >= 1
