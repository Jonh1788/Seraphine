"""Tests for the insights module (InsightEngine + schema + weekly)."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from seraphine.insights import schema as insights_schema
from seraphine.insights.service import (
    InsightEngine,
    MONTH_DELTA_PCT,
    OVERDUE_DAYS,
    SUBSCRIPTION_ALERT_BRL,
    _hash_id,
)
from seraphine.insights.weekly import (
    generate_weekly_report,
    get_or_generate_current_week,
)
from seraphine.memory.store import MemoryStore


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------

class _FakeFinance:
    def __init__(
        self,
        *,
        summary_by_month: dict[tuple[int, int], dict[str, Any]] | None = None,
        entries: list[Any] | None = None,
        recurring: list[Any] | None = None,
    ) -> None:
        self._summary = summary_by_month or {}
        self._entries = entries or []
        self._recurring = recurring or []

    async def get_monthly_summary(self, month: int, year: int) -> dict[str, Any]:
        return self._summary.get((year, month), {
            "income": 0, "expenses": 0, "balance": 0, "by_category": [],
        })

    async def list_entries(self, **kwargs: Any) -> list[Any]:
        month = kwargs.get("month")
        year = kwargs.get("year")
        out = []
        for e in self._entries:
            if month and year:
                if not e.date.startswith(f"{year:04d}-{month:02d}"):
                    continue
            if kwargs.get("type") and e.type != kwargs["type"]:
                continue
            out.append(e)
        return out

    async def list_recurring(self, active_only: bool = True) -> list[Any]:
        return [r for r in self._recurring if (not active_only or r.active)]


class _FakeTasks:
    def __init__(
        self,
        *,
        pending: list[Any] | None = None,
        completed: list[Any] | None = None,
    ) -> None:
        self._pending = pending or []
        self._completed = completed or []

    async def list_tasks(self, **kwargs: Any) -> list[Any]:
        status = kwargs.get("status")
        if status == "pending":
            return list(self._pending)
        if status == "completed":
            return list(self._completed)
        return list(self._pending) + list(self._completed)


class _FakeHabits:
    def __init__(self, items: list[dict[str, Any]] | None = None) -> None:
        self._items = items or []

    async def list_with_today_status(self) -> list[dict[str, Any]]:
        return list(self._items)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
async def store(tmp_path: Path) -> MemoryStore:
    s = MemoryStore(tmp_path / "insights.sqlite")
    s.register_migrator("seraphine_insights", insights_schema.migrate)
    await s.ensure_schema()
    return s


# ---------------------------------------------------------------------------
# Hashing / stability
# ---------------------------------------------------------------------------

def test_hash_id_is_stable() -> None:
    a = _hash_id("finance", "month-delta", "alimentacao", "2026-04")
    b = _hash_id("finance", "month-delta", "alimentacao", "2026-04")
    c = _hash_id("finance", "month-delta", "alimentacao", "2026-03")
    assert a == b
    assert a != c
    assert len(a) == 24


# ---------------------------------------------------------------------------
# Empty behaviour
# ---------------------------------------------------------------------------

async def test_empty_engine_returns_no_insights(store: MemoryStore) -> None:
    eng = InsightEngine(store)
    assert await eng.list_active() == []
    assert await eng.pending_nudges() == []
    generated = await eng.refresh_all()
    assert generated == []


async def test_refresh_is_idempotent(store: MemoryStore) -> None:
    """Running refresh_all twice must not duplicate rows (stable IDs)."""
    # Build a finance fake with a clean month-over-month +50% delta on
    # one category -- enough to tip MONTH_DELTA_PCT.
    assert 0.5 > MONTH_DELTA_PCT
    today = date.today()
    cur = {
        "income": 0, "expenses": 0, "balance": 0,
        "by_category": [{"category": "alimentacao", "total": 1500.0, "count": 5}],
    }
    prev = {
        "income": 0, "expenses": 0, "balance": 0,
        "by_category": [{"category": "alimentacao", "total": 1000.0, "count": 4}],
    }
    prev_month = today.month - 1 or 12
    prev_year = today.year if today.month != 1 else today.year - 1
    finance = _FakeFinance(summary_by_month={
        (today.year, today.month): cur,
        (prev_year, prev_month): prev,
    })
    eng = InsightEngine(store, finance_service=finance)

    first = await eng.refresh_all()
    second = await eng.refresh_all()
    assert len(first) >= 1
    assert len(second) == len(first)
    active = await eng.list_active()
    # One row per unique stable id: no dupes.
    assert len({i.id for i in active}) == len(active)
    assert len(active) == len(first)


# ---------------------------------------------------------------------------
# Finance analyser
# ---------------------------------------------------------------------------

async def test_finance_subscription_alert_triggers(store: MemoryStore) -> None:
    rules = [
        SimpleNamespace(type="expense", amount=600.0, active=True),
        SimpleNamespace(type="expense", amount=500.0, active=True),
    ]
    finance = _FakeFinance(recurring=rules)
    eng = InsightEngine(store, finance_service=finance)
    today = date.today()
    out = await eng.analyze_finance(today.month, today.year)
    kinds = [i.data.get("rule_count") for i in out if i.type == "finance"]
    # Total 1100 >= 1000 alert threshold.
    assert any(k == 2 for k in kinds)
    assert SUBSCRIPTION_ALERT_BRL == 1000.0


async def test_finance_subscription_alert_suppressed_below_threshold(
    store: MemoryStore,
) -> None:
    rules = [
        SimpleNamespace(type="expense", amount=300.0, active=True),
    ]
    finance = _FakeFinance(recurring=rules)
    eng = InsightEngine(store, finance_service=finance)
    today = date.today()
    out = await eng.analyze_finance(today.month, today.year)
    # No subscription insight because 300 < 1000 threshold.
    assert not any("subscriptions" in i.title.lower() for i in out)


# ---------------------------------------------------------------------------
# Task analyser
# ---------------------------------------------------------------------------

async def test_tasks_overdue_detected(store: MemoryStore) -> None:
    old = (datetime.now(timezone.utc) - timedelta(days=OVERDUE_DAYS + 2)).isoformat()
    pending = [
        SimpleNamespace(id=1, title="Cobrar FP", created_at=old, updated_at=old),
        SimpleNamespace(id=2, title="Revisar contrato", created_at=old, updated_at=old),
    ]
    tasks = _FakeTasks(pending=pending, completed=[])
    eng = InsightEngine(store, task_service=tasks)
    out = await eng.analyze_tasks()
    warnings = [i for i in out if i.severity == "warning"]
    assert warnings
    assert warnings[0].data.get("count") == 2


async def test_tasks_fresh_pending_not_overdue(store: MemoryStore) -> None:
    fresh = datetime.now(timezone.utc).isoformat()
    pending = [SimpleNamespace(id=1, title="x", created_at=fresh, updated_at=fresh)]
    tasks = _FakeTasks(pending=pending, completed=[])
    eng = InsightEngine(store, task_service=tasks)
    out = await eng.analyze_tasks()
    # Nothing older than 7 days -> no overdue warning.
    assert not any(i.severity == "warning" for i in out)


# ---------------------------------------------------------------------------
# Habit analyser
# ---------------------------------------------------------------------------

async def test_habit_streak_broken_insight(store: MemoryStore) -> None:
    habits = _FakeHabits(items=[{
        "id": "abc", "title": "Exercicio", "current_streak": 0,
        "best_streak": 5, "active": True,
    }])
    eng = InsightEngine(store, habit_service=habits)
    out = await eng.analyze_habits()
    assert any(i.severity == "info" and "Exercicio" in i.title for i in out)


async def test_habit_best_streak_positive(store: MemoryStore) -> None:
    habits = _FakeHabits(items=[{
        "id": "xyz", "title": "Ler", "current_streak": 7,
        "best_streak": 7, "active": True,
    }])
    eng = InsightEngine(store, habit_service=habits)
    out = await eng.analyze_habits()
    assert any(i.severity == "positive" for i in out)


# ---------------------------------------------------------------------------
# Dismiss / persistence
# ---------------------------------------------------------------------------

async def test_dismiss_survives_refresh(store: MemoryStore) -> None:
    habits = _FakeHabits(items=[{
        "id": "abc", "title": "Exercicio", "current_streak": 0,
        "best_streak": 5, "active": True,
    }])
    eng = InsightEngine(store, habit_service=habits)
    await eng.refresh_all()
    items = await eng.list_active()
    assert items, "expected at least one insight"
    target = items[0]

    ok = await eng.dismiss(target.id)
    assert ok

    # Re-run: the same stable id reappears in analysis, but remains dismissed.
    await eng.refresh_all()
    active = await eng.list_active()
    assert target.id not in {i.id for i in active}


# ---------------------------------------------------------------------------
# Nudges
# ---------------------------------------------------------------------------

async def test_pending_nudges_sorts_by_severity(store: MemoryStore) -> None:
    # One habit positive + one overdue warning.
    old = (datetime.now(timezone.utc) - timedelta(days=OVERDUE_DAYS + 2)).isoformat()
    tasks = _FakeTasks(pending=[
        SimpleNamespace(id=1, title="Cobrar", created_at=old, updated_at=old),
    ], completed=[])
    habits = _FakeHabits(items=[{
        "id": "xyz", "title": "Ler", "current_streak": 7,
        "best_streak": 7, "active": True,
    }])
    eng = InsightEngine(store, task_service=tasks, habit_service=habits)
    await eng.refresh_all()
    nudges = await eng.pending_nudges(cap=5)
    assert nudges
    # warning should come before positive.
    assert nudges[0].severity == "warning"


# ---------------------------------------------------------------------------
# Weekly report
# ---------------------------------------------------------------------------

async def test_weekly_report_idempotent(store: MemoryStore) -> None:
    eng = InsightEngine(store)
    r1 = await get_or_generate_current_week(store, eng)
    r2 = await get_or_generate_current_week(store, eng)
    assert r1.id == r2.id
    assert r1.week_start == r2.week_start
    # Regenerate explicitly -- must upsert same week (id unchanged).
    r3 = await generate_weekly_report(store, eng)
    assert r3.id == r1.id


async def test_weekly_report_contains_expected_blocks(
    store: MemoryStore,
) -> None:
    eng = InsightEngine(store)
    r = await get_or_generate_current_week(store, eng)
    d = r.to_dict()
    for key in ("week_start", "week_end", "tasks", "finance", "habits",
                "insights", "suggestion"):
        assert key in d
    assert d["suggestion"]


# ---------------------------------------------------------------------------
# Finance analyser — coverage gaps
# ---------------------------------------------------------------------------

async def test_finance_month_delta_warning(store: MemoryStore) -> None:
    """+30% MoM on a category tips MONTH_DELTA_PCT and fires a warning."""
    today = date.today()
    prev_m = today.month - 1 or 12
    prev_y = today.year if today.month != 1 else today.year - 1
    finance = _FakeFinance(summary_by_month={
        (today.year, today.month): {
            "income": 0, "expenses": 0, "balance": 0,
            "by_category": [
                {"category": "alimentacao", "total": 1300.0, "count": 1},
            ],
        },
        (prev_y, prev_m): {
            "income": 0, "expenses": 0, "balance": 0,
            "by_category": [
                {"category": "alimentacao", "total": 1000.0, "count": 1},
            ],
        },
    })
    eng = InsightEngine(store, finance_service=finance)
    out = await eng.analyze_finance(today.month, today.year)
    warnings = [
        i for i in out
        if i.severity == "warning"
        and i.data.get("category") == "alimentacao"
    ]
    assert warnings, f"expected alimentacao warning, got {[i.title for i in out]}"
    w = warnings[0]
    # Delta is exactly 30% → ~0.30.
    assert w.data.get("delta_pct") == pytest.approx(0.30, abs=0.001)
    assert "alimentacao" in w.title.lower()
    assert "30%" in w.title


async def test_finance_weekday_outlier_detected(store: MemoryStore) -> None:
    """Friday alimentacao avg >> other weekdays → weekday-outlier insight."""
    today = date.today()
    year, month = today.year, today.month

    # Pick a month-local date for every weekday from the 1st onward. We
    # only care about the weekday of each entry; amounts drive the ratio.
    def _dates_for_weekday(wd: int, count: int) -> list[str]:
        out: list[str] = []
        d = date(year, month, 1)
        while len(out) < count:
            if d.weekday() == wd:
                out.append(d.isoformat())
            d += timedelta(days=1)
            if d.month != month:
                break
        return out

    entries: list[Any] = []
    # Friday (wd=4): 3 entries of 300 (avg 300).
    for ds in _dates_for_weekday(4, 3):
        entries.append(SimpleNamespace(
            type="expense", status="confirmed", category="alimentacao",
            amount=300.0, date=ds,
        ))
    # Other weekdays: 100 each, avg = 100 → Friday is 200% higher.
    for wd in (0, 1, 2, 3):  # mon..thu
        for ds in _dates_for_weekday(wd, 1):
            entries.append(SimpleNamespace(
                type="expense", status="confirmed", category="alimentacao",
                amount=100.0, date=ds,
            ))

    finance = _FakeFinance(entries=entries)
    eng = InsightEngine(store, finance_service=finance)
    out = await eng.analyze_finance(month, year)
    weekday_insights = [
        i for i in out
        if i.type == "finance" and i.data.get("weekday") == 4
    ]
    assert weekday_insights, (
        "expected Friday weekday-outlier insight for alimentacao, got "
        f"{[(i.title, i.data) for i in out]}"
    )
    ins = weekday_insights[0]
    # Friday avg 300 vs others avg 100 → delta_pct ~ 2.0.
    assert ins.data.get("delta_pct", 0) >= 1.0
    assert ins.data.get("avg_this_day") == 300.0


# ---------------------------------------------------------------------------
# Task analyser — coverage gaps
# ---------------------------------------------------------------------------

async def test_tasks_morning_pattern_detected(store: MemoryStore) -> None:
    """10 completed tasks, 7 before noon → productivity/morning insight."""
    from zoneinfo import ZoneInfo as _ZI

    sp = _ZI("America/Sao_Paulo")
    today = date.today()
    # Build updated_at timestamps: 7 at 09:00 SP, 3 at 15:00 SP.
    completed: list[Any] = []
    for i in range(7):
        day = today - timedelta(days=i)
        ts = datetime(day.year, day.month, day.day, 9, 0, tzinfo=sp)
        completed.append(SimpleNamespace(
            id=i + 1, title=f"morning {i}",
            created_at=ts.isoformat(), updated_at=ts.isoformat(),
        ))
    for i in range(3):
        day = today - timedelta(days=i + 7)
        ts = datetime(day.year, day.month, day.day, 15, 0, tzinfo=sp)
        completed.append(SimpleNamespace(
            id=100 + i, title=f"afternoon {i}",
            created_at=ts.isoformat(), updated_at=ts.isoformat(),
        ))

    tasks = _FakeTasks(pending=[], completed=completed)
    eng = InsightEngine(store, task_service=tasks)
    out = await eng.analyze_tasks()
    morning = [
        i for i in out
        if i.type == "productivity" and i.data.get("cutoff_hour") == 12
    ]
    assert morning, f"expected morning-pattern insight, got {[i.title for i in out]}"
    m = morning[0]
    assert m.data.get("total_completed") == 10
    assert m.data.get("morning_completed") == 7
    assert m.data.get("ratio", 0) >= 0.65


async def test_tasks_weekly_flow_detected(store: MemoryStore) -> None:
    """12 created + 4 completed this week → weekly-flow info insight."""
    from zoneinfo import ZoneInfo as _ZI

    sp = _ZI("America/Sao_Paulo")
    today = datetime.now(sp).date()
    week_start = today - timedelta(days=today.weekday())

    def _iso_in_week(offset: int) -> str:
        d = week_start + timedelta(days=min(offset, 6))
        return datetime(
            d.year, d.month, d.day, 10, 0, tzinfo=sp,
        ).isoformat()

    # 12 created this week, 4 of which are also completed this week; 8 still pending.
    completed: list[Any] = []
    for i in range(4):
        completed.append(SimpleNamespace(
            id=i + 1, title=f"done {i}",
            created_at=_iso_in_week(i), updated_at=_iso_in_week(i + 1),
        ))
    pending: list[Any] = []
    for i in range(8):
        pending.append(SimpleNamespace(
            id=100 + i, title=f"pend {i}",
            created_at=_iso_in_week(i % 6), updated_at=_iso_in_week(i % 6),
        ))

    tasks = _FakeTasks(pending=pending, completed=completed)
    eng = InsightEngine(store, task_service=tasks)
    out = await eng.analyze_tasks()
    flow = [
        i for i in out
        if i.type == "tasks" and "week_start" in i.data
    ]
    assert flow, f"expected weekly-flow insight, got {[i.title for i in out]}"
    f = flow[0]
    assert f.data.get("created") == 12
    assert f.data.get("completed") == 4
    assert f.data.get("ratio", 1.0) < 0.4
