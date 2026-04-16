"""Tests for the water tracking module (WaterService + schema + tools)."""

from __future__ import annotations

import asyncio
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest

from seraphine.memory.store import MemoryStore
from seraphine.tools.water import (
    PRESET_SIZES,
    LogWaterTool,
    SetupWaterTool,
    _resolve_amount,
)
from seraphine.water import schema as water_schema
from seraphine.water.models import WaterLog, WaterProfile
from seraphine.water.service import WaterService


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
async def store(tmp_path: Path) -> MemoryStore:
    s = MemoryStore(tmp_path / "water.sqlite")
    s.register_migrator("seraphine_water", water_schema.migrate)
    await s.ensure_schema()
    return s


@pytest.fixture
async def service(store: MemoryStore) -> WaterService:
    return WaterService(store)


async def _log_with_date(
    store: MemoryStore,
    amount_ml: int,
    d: date,
    ts: datetime | None = None,
) -> None:
    """Insert a water log directly with a specific date (bypass today_sp)."""
    ts = ts or datetime.now(timezone.utc)

    def _work() -> None:
        with store._connect() as conn:
            conn.execute(
                "INSERT INTO water_logs (amount_ml, date, logged_at)"
                " VALUES (?, ?, ?)",
                (amount_ml, d.isoformat(), ts.isoformat()),
            )
    await asyncio.to_thread(_work)


# ---------------------------------------------------------------------------
# Goal math
# ---------------------------------------------------------------------------

def test_compute_goal_sedentary() -> None:
    # 70kg * 30 = 2100 (within clamp)
    assert WaterService.compute_goal(70, "sedentary") == 2100


def test_compute_goal_moderate() -> None:
    # 70kg * 35 = 2450
    assert WaterService.compute_goal(70, "moderate") == 2450


def test_compute_goal_active() -> None:
    # 70kg * 40 = 2800
    assert WaterService.compute_goal(70, "active") == 2800


def test_compute_goal_clamp_low() -> None:
    # Very light weight → clamps to 1500 min
    assert WaterService.compute_goal(40, "sedentary") == 1500  # 40*30=1200 → 1500
    assert WaterService.compute_goal(30, "moderate") == 1500  # 30*35=1050 → 1500


def test_compute_goal_clamp_high() -> None:
    # Very heavy weight → clamps to 5000 max
    assert WaterService.compute_goal(200, "active") == 5000  # 200*40=8000 → 5000
    assert WaterService.compute_goal(150, "active") == 5000  # 150*40=6000 → 5000


def test_compute_goal_invalid() -> None:
    with pytest.raises(ValueError):
        WaterService.compute_goal(70, "elite")
    with pytest.raises(ValueError):
        WaterService.compute_goal(0, "moderate")
    with pytest.raises(ValueError):
        WaterService.compute_goal(-5, "active")


# ---------------------------------------------------------------------------
# Profile upsert
# ---------------------------------------------------------------------------

async def test_set_profile_upsert(service: WaterService) -> None:
    p1 = await service.set_profile(weight_kg=70, activity_level="moderate")
    assert isinstance(p1, WaterProfile)
    assert p1.daily_goal_ml == 2450
    assert p1.activity_level == "moderate"
    assert p1.reminder_enabled is True
    assert p1.reminder_start == "08:00"
    assert p1.reminder_end == "22:00"
    assert p1.reminder_interval_hours == 2

    # Upsert: updates values; singleton row (id=1) — still only one profile.
    p2 = await service.set_profile(
        weight_kg=80,
        activity_level="active",
        height_cm=175.5,
        reminder_enabled=False,
        reminder_start="07:30",
        reminder_end="23:00",
        reminder_interval_hours=3,
    )
    assert p2.weight_kg == 80
    assert p2.activity_level == "active"
    assert p2.height_cm == 175.5
    assert p2.daily_goal_ml == 3200
    assert p2.reminder_enabled is False
    assert p2.reminder_start == "07:30"
    assert p2.reminder_end == "23:00"
    assert p2.reminder_interval_hours == 3

    got = await service.get_profile()
    assert got is not None
    assert got.weight_kg == 80


async def test_set_profile_rejects_bad_time(service: WaterService) -> None:
    with pytest.raises(ValueError):
        await service.set_profile(
            weight_kg=70,
            activity_level="moderate",
            reminder_start="25:00",
        )
    with pytest.raises(ValueError):
        await service.set_profile(
            weight_kg=70,
            activity_level="moderate",
            reminder_end="notatime",
        )


async def test_get_profile_none_when_unset(service: WaterService) -> None:
    assert await service.get_profile() is None


# ---------------------------------------------------------------------------
# Intake
# ---------------------------------------------------------------------------

async def test_add_intake_requires_profile(service: WaterService) -> None:
    with pytest.raises(LookupError):
        await service.add_intake(250)


async def test_add_intake_accumulates(service: WaterService) -> None:
    await service.set_profile(weight_kg=70, activity_level="moderate")

    r1 = await service.add_intake(250)
    assert r1["total_today"] == 250
    assert r1["goal"] == 2450
    assert r1["percent"] == round(250 / 2450 * 100)
    assert isinstance(r1["log"], dict)
    assert r1["log"]["amount_ml"] == 250

    r2 = await service.add_intake(500)
    assert r2["total_today"] == 750
    assert r2["percent"] == round(750 / 2450 * 100)

    r3 = await service.add_intake(1000)
    assert r3["total_today"] == 1750


async def test_add_intake_rejects_bad_amount(service: WaterService) -> None:
    await service.set_profile(weight_kg=70, activity_level="moderate")
    with pytest.raises(ValueError):
        await service.add_intake(0)
    with pytest.raises(ValueError):
        await service.add_intake(-50)
    with pytest.raises(ValueError):
        await service.add_intake(10_000)


# ---------------------------------------------------------------------------
# Today progress
# ---------------------------------------------------------------------------

async def test_get_today_progress(service: WaterService) -> None:
    await service.set_profile(weight_kg=70, activity_level="sedentary")
    # goal = 2100
    await service.add_intake(300)
    await service.add_intake(500)

    snap = await service.get_today()
    assert snap["total"] == 800
    assert snap["goal"] == 2100
    assert snap["percent"] == round(800 / 2100 * 100)
    assert len(snap["logs"]) == 2
    # Logs sorted newest first → last insert (500) comes first
    assert snap["logs"][0]["amount_ml"] == 500
    assert snap["logs"][1]["amount_ml"] == 300


async def test_get_today_no_profile(service: WaterService) -> None:
    snap = await service.get_today()
    assert snap["total"] == 0
    assert snap["goal"] == 0
    assert snap["percent"] == 0
    assert snap["logs"] == []


# ---------------------------------------------------------------------------
# History window
# ---------------------------------------------------------------------------

async def test_get_history_window(
    service: WaterService, store: MemoryStore,
) -> None:
    from seraphine.water.service import _today_sp

    await service.set_profile(weight_kg=70, activity_level="moderate")
    today = _today_sp()

    # Seed 3 days of intake in the last week
    await _log_with_date(store, 500, today)
    await _log_with_date(store, 250, today)  # same day → sums to 750
    await _log_with_date(store, 1000, today - timedelta(days=2))
    await _log_with_date(store, 800, today - timedelta(days=5))

    history = await service.get_history(7)
    assert len(history) == 7
    # First entry is 6 days ago; last is today
    assert history[0]["date"] == (today - timedelta(days=6)).isoformat()
    assert history[-1]["date"] == today.isoformat()

    by_date = {h["date"]: h for h in history}
    assert by_date[today.isoformat()]["total"] == 750
    assert by_date[(today - timedelta(days=2)).isoformat()]["total"] == 1000
    assert by_date[(today - timedelta(days=5)).isoformat()]["total"] == 800
    # All entries carry the goal
    for h in history:
        assert h["goal"] == 2450


async def test_get_history_validates_days(service: WaterService) -> None:
    with pytest.raises(ValueError):
        await service.get_history(0)
    with pytest.raises(ValueError):
        await service.get_history(-1)
    with pytest.raises(ValueError):
        await service.get_history(10_000)


# ---------------------------------------------------------------------------
# Delete log
# ---------------------------------------------------------------------------

async def test_delete_log(service: WaterService) -> None:
    await service.set_profile(weight_kg=70, activity_level="moderate")
    r = await service.add_intake(500)
    log_id = r["log"]["id"]
    assert isinstance(log_id, int) and log_id > 0

    ok = await service.delete_log(log_id)
    assert ok is True

    # Deleting again returns False
    ok2 = await service.delete_log(log_id)
    assert ok2 is False

    snap = await service.get_today()
    assert snap["total"] == 0
    assert snap["logs"] == []


# ---------------------------------------------------------------------------
# Tool: LogWaterTool — preset handling + integration
# ---------------------------------------------------------------------------

def test_preset_sizes_map() -> None:
    assert PRESET_SIZES["copo"] == 250
    assert PRESET_SIZES["copão"] == 400
    assert PRESET_SIZES["garrafa_pequena"] == 500
    assert PRESET_SIZES["garrafa"] == 600
    assert PRESET_SIZES["garrafão"] == 1000


def test_resolve_amount_explicit_wins() -> None:
    assert _resolve_amount({"amount_ml": 750, "preset": "copo"}) == 750


def test_resolve_amount_preset_fallback() -> None:
    assert _resolve_amount({"preset": "garrafa"}) == 600
    assert _resolve_amount({"preset": "copão"}) == 400


def test_resolve_amount_default_250() -> None:
    assert _resolve_amount({}) == 250


def test_resolve_amount_invalid_preset() -> None:
    with pytest.raises(ValueError):
        _resolve_amount({"preset": "balde"})


def test_resolve_amount_invalid_explicit() -> None:
    with pytest.raises(ValueError):
        _resolve_amount({"amount_ml": -10})
    with pytest.raises(ValueError):
        _resolve_amount({"amount_ml": "not-a-number"})


async def test_log_water_tool_preset(service: WaterService) -> None:
    await service.set_profile(weight_kg=70, activity_level="moderate")
    tool = LogWaterTool(service)

    result = await tool.execute({"preset": "garrafa"})
    assert result.ok is True
    assert result.metadata["amount_ml"] == 600
    assert result.metadata["total_today"] == 600
    assert result.metadata["goal"] == 2450
    assert "html_card" in result.metadata
    assert "rich-card--water" in result.metadata["html_card"]


async def test_log_water_tool_default(service: WaterService) -> None:
    await service.set_profile(weight_kg=70, activity_level="moderate")
    tool = LogWaterTool(service)

    result = await tool.execute({})
    assert result.ok is True
    assert result.metadata["amount_ml"] == 250


async def test_log_water_tool_without_profile(service: WaterService) -> None:
    tool = LogWaterTool(service)
    result = await tool.execute({"amount_ml": 250})
    assert result.ok is False
    assert "perfil" in (result.error or "").lower()


async def test_setup_water_tool(service: WaterService) -> None:
    tool = SetupWaterTool(service)
    result = await tool.execute(
        {"weight_kg": 72, "activity_level": "moderate"},
    )
    assert result.ok is True
    prof = result.metadata.get("water_profile")
    assert prof is not None
    assert prof["weight_kg"] == 72
    assert prof["activity_level"] == "moderate"
    assert prof["daily_goal_ml"] == WaterService.compute_goal(72, "moderate")
    assert "html_card" in result.metadata


async def test_setup_water_tool_invalid_activity(service: WaterService) -> None:
    tool = SetupWaterTool(service)
    result = await tool.execute(
        {"weight_kg": 72, "activity_level": "elite"},
    )
    assert result.ok is False


# ---------------------------------------------------------------------------
# Reminder bookkeeping
# ---------------------------------------------------------------------------

async def test_reminder_fired_roundtrip(service: WaterService) -> None:
    await service.set_profile(weight_kg=70, activity_level="moderate")
    assert await service.get_last_reminder_fired_at() is None

    now = datetime.now(timezone.utc)
    await service.mark_reminder_fired(now)
    got = await service.get_last_reminder_fired_at()
    assert got is not None
    # Precision preserved via ISO round-trip
    assert got.isoformat() == now.isoformat()


async def test_last_intake_at(service: WaterService) -> None:
    await service.set_profile(weight_kg=70, activity_level="moderate")
    assert await service.last_intake_at() is None
    await service.add_intake(250)
    ts = await service.last_intake_at()
    assert ts is not None
    assert isinstance(ts, datetime)


# ---------------------------------------------------------------------------
# WaterLog dataclass round-trip
# ---------------------------------------------------------------------------

def test_waterlog_to_dict() -> None:
    log = WaterLog(id=1, amount_ml=500, date="2026-04-15", logged_at="ts")
    assert log.to_dict() == {
        "id": 1,
        "amount_ml": 500,
        "date": "2026-04-15",
        "logged_at": "ts",
    }


def test_waterprofile_to_dict() -> None:
    p = WaterProfile(
        weight_kg=70,
        height_cm=180,
        activity_level="moderate",
        daily_goal_ml=2450,
        reminder_enabled=True,
        reminder_start="08:00",
        reminder_end="22:00",
        reminder_interval_hours=2,
        updated_at="ts",
    )
    d = p.to_dict()
    assert d["weight_kg"] == 70
    assert d["daily_goal_ml"] == 2450
    assert d["reminder_enabled"] is True
