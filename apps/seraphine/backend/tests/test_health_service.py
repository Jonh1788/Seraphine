"""Tests for the Apple Health backend module.

Covers: snapshot upsert, today lookup, trend extraction, weekly
aggregation, habit auto-complete triggers, and LLM tool payloads.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import pytest

from seraphine.habits import schema as habits_schema
from seraphine.habits.service import HabitService
from seraphine.health import schema as health_schema
from seraphine.health.models import HealthSnapshot
from seraphine.health.service import HealthService
from seraphine.memory.store import MemoryStore
from seraphine.tools.health import HealthSummaryTool, HealthTrendTool
from seraphine.water import schema as water_schema
from seraphine.water.service import WaterService


_SP_TZ = ZoneInfo("America/Sao_Paulo")


def _today_sp() -> date:
    return datetime.now(_SP_TZ).date()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
async def store(tmp_path: Path) -> MemoryStore:
    s = MemoryStore(tmp_path / "health.sqlite")
    s.register_migrator("seraphine_health", health_schema.migrate)
    s.register_migrator("seraphine_habits", habits_schema.migrate)
    s.register_migrator("seraphine_water", water_schema.migrate)
    await s.ensure_schema()
    return s


@pytest.fixture
async def habit_service(store: MemoryStore) -> HabitService:
    return HabitService(store)


@pytest.fixture
async def water_service(store: MemoryStore) -> WaterService:
    return WaterService(store)


@pytest.fixture
async def service(
    store: MemoryStore,
    habit_service: HabitService,
    water_service: WaterService,
) -> HealthService:
    return HealthService(
        store, habit_service=habit_service, water_service=water_service,
    )


# ---------------------------------------------------------------------------
# Store / query
# ---------------------------------------------------------------------------


async def test_store_snapshot_round_trip(service: HealthService) -> None:
    today = _today_sp().isoformat()
    snap = await service.store_snapshot(
        date=today,
        steps=8432,
        active_calories=423.5,
        resting_heart_rate=62.0,
        sleep_minutes=432.0,
        weight_kg=72.4,
        workouts=[
            {
                "type": "running",
                "start": f"{today}T06:00:00+00:00",
                "end": f"{today}T06:32:00+00:00",
                "duration_min": 32.0,
                "calories": 310.0,
                "distance_km": 5.1,
            }
        ],
    )
    assert snap.date == today
    assert snap.steps == 8432
    assert snap.active_calories == pytest.approx(423.5)
    assert snap.resting_heart_rate == pytest.approx(62.0)
    assert snap.sleep_minutes == pytest.approx(432.0)
    assert snap.sleep_quality == "boa"  # 7h12 ≥ 7h → boa
    assert snap.weight_kg == pytest.approx(72.4)
    assert len(snap.workouts) == 1
    assert snap.workouts[0].type == "running"
    assert snap.workouts[0].duration_min == pytest.approx(32.0)

    again = await service.get_today()
    assert again is not None
    assert again.steps == 8432


async def test_store_snapshot_upsert_overrides(service: HealthService) -> None:
    today = _today_sp().isoformat()
    await service.store_snapshot(date=today, steps=1_000)
    await service.store_snapshot(date=today, steps=2_500, active_calories=200.0)
    snap = await service.get_today()
    assert snap is not None
    assert snap.steps == 2_500
    assert snap.active_calories == pytest.approx(200.0)


async def test_sleep_quality_derivation(service: HealthService) -> None:
    tomorrow = _today_sp() + timedelta(days=1)
    # 8h → boa
    s1 = await service.store_snapshot(date=tomorrow.isoformat(), sleep_minutes=480)
    assert s1.sleep_quality == "boa"
    # 6h → regular
    s2 = await service.store_snapshot(
        date=(tomorrow + timedelta(days=1)).isoformat(), sleep_minutes=360,
    )
    assert s2.sleep_quality == "regular"
    # 4h → ruim
    s3 = await service.store_snapshot(
        date=(tomorrow + timedelta(days=2)).isoformat(), sleep_minutes=240,
    )
    assert s3.sleep_quality == "ruim"
    # Explicit quality takes precedence
    s4 = await service.store_snapshot(
        date=(tomorrow + timedelta(days=3)).isoformat(),
        sleep_minutes=120,
        sleep_quality="custom",
    )
    assert s4.sleep_quality == "custom"


async def test_store_snapshot_rejects_invalid(service: HealthService) -> None:
    today = _today_sp().isoformat()
    with pytest.raises(ValueError):
        await service.store_snapshot(date=today, steps=-1)
    with pytest.raises(ValueError):
        await service.store_snapshot(date=today, active_calories=-5.0)
    with pytest.raises(ValueError):
        await service.store_snapshot(date="not-a-date")


# ---------------------------------------------------------------------------
# Trend + recent
# ---------------------------------------------------------------------------


async def test_get_recent_orders_ascending(service: HealthService) -> None:
    today = _today_sp()
    for i in range(5):
        d = today - timedelta(days=i)
        await service.store_snapshot(date=d.isoformat(), steps=1000 + i * 100)
    recent = await service.get_recent(days=5)
    assert len(recent) == 5
    assert [s.date for s in recent] == [
        (today - timedelta(days=i)).isoformat() for i in (4, 3, 2, 1, 0)
    ]


async def test_get_trend_skips_missing(service: HealthService) -> None:
    today = _today_sp()
    # 3 days with sleep data, 2 days without
    for i, sleep in enumerate([420, None, 360, None, 480]):
        d = today - timedelta(days=i)
        kwargs: dict[str, Any] = {"date": d.isoformat(), "steps": 1000}
        if sleep is not None:
            kwargs["sleep_minutes"] = float(sleep)
        await service.store_snapshot(**kwargs)
    points = await service.get_trend(metric="sleep", days=5)
    assert len(points) == 3
    assert all(p.value > 0 for p in points)


async def test_get_trend_rejects_bad_metric(service: HealthService) -> None:
    with pytest.raises(ValueError):
        await service.get_trend(metric="not-a-metric", days=7)


# ---------------------------------------------------------------------------
# Weekly report
# ---------------------------------------------------------------------------


async def test_weekly_report_empty(service: HealthService) -> None:
    report = await service.get_weekly_report()
    assert report["days"] == 0
    assert report["steps_total"] == 0
    assert report["snapshots"] == []


async def test_weekly_report_aggregates(service: HealthService) -> None:
    today = _today_sp()
    for i in range(7):
        d = today - timedelta(days=i)
        await service.store_snapshot(
            date=d.isoformat(),
            steps=5_000 + i * 500,
            active_calories=200.0 + i * 20,
            resting_heart_rate=60.0 + i * 0.5,
            sleep_minutes=420.0 - i * 10,
            weight_kg=70.0 + i * 0.1,
            workouts=[
                {
                    "type": "walk",
                    "start": f"{d.isoformat()}T10:00:00+00:00",
                    "end": f"{d.isoformat()}T10:30:00+00:00",
                    "duration_min": 30.0,
                }
            ] if i % 2 == 0 else [],
        )
    report = await service.get_weekly_report()
    assert report["days"] == 7
    assert report["steps_total"] > 0
    assert report["steps_avg"] > 0
    assert report["workouts_total"] == 4  # every other day
    assert report["resting_heart_rate_avg"] is not None
    assert report["weight_latest"] is not None


# ---------------------------------------------------------------------------
# Delete
# ---------------------------------------------------------------------------


async def test_delete_snapshot(service: HealthService) -> None:
    today = _today_sp().isoformat()
    await service.store_snapshot(date=today, steps=100)
    ok = await service.delete_snapshot(today)
    assert ok
    assert await service.get_today() is None
    # deleting again → False
    assert not await service.delete_snapshot(today)


# ---------------------------------------------------------------------------
# Habit auto-complete
# ---------------------------------------------------------------------------


async def test_auto_complete_steps_habit(
    service: HealthService, habit_service: HabitService,
) -> None:
    habit = await habit_service.create(
        title="10k passos", frequency="daily",
    )
    today = _today_sp().isoformat()
    await service.store_snapshot(date=today, steps=10_500)

    items = await habit_service.list_with_today_status()
    row = next((h for h in items if h["id"] == habit.id), None)
    assert row is not None
    assert row["today_completed"] is True


async def test_auto_complete_sleep_habit(
    service: HealthService, habit_service: HabitService,
) -> None:
    habit = await habit_service.create(
        title="Sono 8h", frequency="daily",
    )
    today = _today_sp().isoformat()
    await service.store_snapshot(
        date=today,
        sleep_minutes=480,  # 8h
    )
    items = await habit_service.list_with_today_status()
    row = next((h for h in items if h["id"] == habit.id), None)
    assert row is not None
    assert row["today_completed"] is True


async def test_auto_complete_workout_habit(
    service: HealthService, habit_service: HabitService,
) -> None:
    habit = await habit_service.create(
        title="Exercicio diario", frequency="daily",
    )
    today = _today_sp().isoformat()
    await service.store_snapshot(
        date=today,
        workouts=[
            {
                "type": "run",
                "start": f"{today}T06:00:00+00:00",
                "end": f"{today}T06:30:00+00:00",
                "duration_min": 30.0,
            }
        ],
    )
    items = await habit_service.list_with_today_status()
    row = next((h for h in items if h["id"] == habit.id), None)
    assert row is not None
    assert row["today_completed"] is True


async def test_auto_complete_skips_below_threshold(
    service: HealthService, habit_service: HabitService,
) -> None:
    habit = await habit_service.create(
        title="10k passos", frequency="daily",
    )
    today = _today_sp().isoformat()
    await service.store_snapshot(date=today, steps=5_000)  # below 10k
    items = await habit_service.list_with_today_status()
    row = next((h for h in items if h["id"] == habit.id), None)
    assert row is not None
    assert row["today_completed"] is False


async def test_auto_complete_only_for_today(
    service: HealthService, habit_service: HabitService,
) -> None:
    await habit_service.create(title="10k passos", frequency="daily")
    yesterday = (_today_sp() - timedelta(days=1)).isoformat()
    await service.store_snapshot(date=yesterday, steps=20_000)
    items = await habit_service.list_with_today_status()
    # Today's entry shouldn't be toggled by a backfilled past-day snapshot.
    assert all(h["today_completed"] is False for h in items)


# ---------------------------------------------------------------------------
# LLM tools
# ---------------------------------------------------------------------------


async def test_health_summary_tool_no_data(service: HealthService) -> None:
    tool = HealthSummaryTool(service)
    result = await tool.execute({})
    assert result.ok
    assert result.metadata["health_snapshot"] is None


async def test_health_summary_tool_today(service: HealthService) -> None:
    today = _today_sp().isoformat()
    await service.store_snapshot(
        date=today,
        steps=8432,
        active_calories=423.0,
        resting_heart_rate=62.0,
        sleep_minutes=432.0,
        workouts=[
            {
                "type": "running",
                "start": f"{today}T06:00:00+00:00",
                "end": f"{today}T06:32:00+00:00",
                "duration_min": 32.0,
            }
        ],
    )
    tool = HealthSummaryTool(service)
    result = await tool.execute({})
    assert result.ok
    assert "html_card" in result.metadata
    assert "rich-card--health" in result.metadata["html_card"]
    snap = result.metadata["health_snapshot"]
    assert snap["steps"] == 8432


async def test_health_trend_tool(service: HealthService) -> None:
    today = _today_sp()
    for i in range(5):
        d = today - timedelta(days=i)
        await service.store_snapshot(date=d.isoformat(), steps=6_000 + i * 500)
    tool = HealthTrendTool(service)
    result = await tool.execute({"metric": "steps", "days": 7})
    assert result.ok
    assert result.metadata["metric"] == "steps"
    assert len(result.metadata["points"]) == 5
    assert "html_card" in result.metadata


async def test_health_trend_tool_validates_metric(service: HealthService) -> None:
    tool = HealthTrendTool(service)
    result = await tool.execute({"metric": "", "days": 7})
    assert not result.ok
    result2 = await tool.execute({"metric": "bogus", "days": 7})
    assert not result2.ok


# ---------------------------------------------------------------------------
# Water profile auto-sync
# ---------------------------------------------------------------------------


async def test_water_sync_updates_weight_when_profile_exists(
    service: HealthService, water_service: WaterService,
) -> None:
    await water_service.set_profile(weight_kg=70.0, activity_level="moderate")
    today = _today_sp().isoformat()
    await service.store_snapshot(date=today, weight_kg=72.5)
    profile = await water_service.get_profile()
    assert profile is not None
    assert profile.weight_kg == pytest.approx(72.5)
    # Goal recomputed from new weight (72.5 × 35ml/kg = 2537 → clamped).
    assert profile.daily_goal_ml == WaterService.compute_goal(72.5, "moderate")


async def test_water_sync_skips_when_no_profile(
    service: HealthService, water_service: WaterService,
) -> None:
    today = _today_sp().isoformat()
    await service.store_snapshot(date=today, weight_kg=75.0)
    profile = await water_service.get_profile()
    assert profile is None  # service won't bootstrap on its own


async def test_water_sync_skips_tiny_delta(
    service: HealthService, water_service: WaterService,
) -> None:
    await water_service.set_profile(weight_kg=70.0, activity_level="moderate")
    today = _today_sp().isoformat()
    await service.store_snapshot(date=today, weight_kg=70.1)  # < 0.3 kg
    profile = await water_service.get_profile()
    assert profile is not None
    assert profile.weight_kg == pytest.approx(70.0)  # unchanged


async def test_water_sync_preserves_other_settings(
    service: HealthService, water_service: WaterService,
) -> None:
    await water_service.set_profile(
        weight_kg=70.0,
        activity_level="active",
        height_cm=175.0,
        reminder_start="07:00",
        reminder_end="23:00",
        reminder_interval_hours=3,
    )
    today = _today_sp().isoformat()
    await service.store_snapshot(date=today, weight_kg=74.5)
    profile = await water_service.get_profile()
    assert profile is not None
    assert profile.activity_level == "active"
    assert profile.height_cm == pytest.approx(175.0)
    assert profile.reminder_start == "07:00"
    assert profile.reminder_end == "23:00"
    assert profile.reminder_interval_hours == 3
