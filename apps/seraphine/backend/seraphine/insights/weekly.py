"""Weekly report generation (idempotent per ISO week).

``generate_weekly_report`` is the raw generator: given a Monday, it
builds a fresh report by aggregating from finance/tasks/habits
services. ``get_or_generate_current_week`` is the idempotent wrapper
that chat/UI should call -- if a row already exists for the current
week's Monday, it is returned; otherwise a fresh one is built, stored,
and returned.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import date, datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from core_db import Store

from seraphine.insights.models import WeeklyReport
from seraphine.insights.service import InsightEngine, _parse_iso_datetime

logger = logging.getLogger(__name__)

_SP_TZ = ZoneInfo("America/Sao_Paulo")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _today_sp() -> date:
    return datetime.now(_SP_TZ).date()


def _week_bounds(d: date) -> tuple[date, date]:
    """Return (Monday, Sunday) for the ISO week containing ``d``."""
    monday = d - timedelta(days=d.weekday())
    sunday = monday + timedelta(days=6)
    return monday, sunday


def _row_to_report(row: tuple[Any, ...]) -> WeeklyReport:
    def _j(v: Any, default: Any) -> Any:
        if not v:
            return default
        try:
            return json.loads(v)
        except (json.JSONDecodeError, TypeError):
            return default

    return WeeklyReport(
        id=int(row[0]),
        week_start=str(row[1]),
        week_end=str(row[2]),
        tasks=_j(row[3], {}),
        finance=_j(row[4], {}),
        habits=_j(row[5], {}),
        insights=_j(row[6], []),
        suggestion=str(row[7] or ""),
        created_at=str(row[8] or ""),
    )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

async def get_report_for_week(
    store: Store, week_start: date,
) -> WeeklyReport | None:
    start_iso = week_start.isoformat()

    def _work() -> WeeklyReport | None:
        with store._connect() as conn:
            row = conn.execute(
                "SELECT id, week_start, week_end, tasks, finance, habits,"
                " insights, suggestion, created_at"
                " FROM weekly_reports WHERE week_start = ?",
                (start_iso,),
            ).fetchone()
        return _row_to_report(row) if row else None

    return await asyncio.to_thread(_work)


async def generate_weekly_report(
    store: Store,
    engine: InsightEngine,
    *,
    week_start: date | None = None,
) -> WeeklyReport:
    """Build AND store a fresh report. Safe to call repeatedly -- the
    row is UPSERT'd by ``week_start``."""
    today = _today_sp()
    start = week_start or (today - timedelta(days=today.weekday()))
    monday, sunday = _week_bounds(start)
    start_dt = datetime.combine(monday, datetime.min.time(), tzinfo=_SP_TZ)
    end_dt = datetime.combine(
        sunday, datetime.max.time().replace(microsecond=0), tzinfo=_SP_TZ,
    )

    tasks_block = await _build_tasks_block(engine, start_dt, end_dt)
    finance_block = await _build_finance_block(engine, monday, sunday)
    habits_block = await _build_habits_block(engine)

    # Refresh insights tied to this report. refresh_all is idempotent
    # (stable ids). Swallow errors -- the report should still render.
    try:
        await engine.refresh_all()
    except Exception:
        logger.exception("insight refresh during weekly report failed")

    try:
        active = await engine.list_active(limit=20)
        insights_block = [i.to_dict() for i in active]
    except Exception:
        logger.exception("list_active failed for weekly report")
        insights_block = []

    suggestion = _suggest_focus(
        tasks_block, finance_block, habits_block, insights_block,
    )

    ts = _now_iso()
    report = WeeklyReport(
        id=None,
        week_start=monday.isoformat(),
        week_end=sunday.isoformat(),
        tasks=tasks_block,
        finance=finance_block,
        habits=habits_block,
        insights=insights_block,
        suggestion=suggestion,
        created_at=ts,
    )

    def _persist() -> int:
        # UPSERT by week_start so two concurrent generators don't both
        # try INSERT and tip the UNIQUE(week_start) constraint into an
        # IntegrityError. The RETURNING clause yields the row id for
        # both the insert and the conflict-update branches.
        with store._connect() as conn:
            payload = (
                json.dumps(report.tasks, ensure_ascii=False),
                json.dumps(report.finance, ensure_ascii=False),
                json.dumps(report.habits, ensure_ascii=False),
                json.dumps(report.insights, ensure_ascii=False),
                report.suggestion,
                report.created_at,
            )
            row = conn.execute(
                "INSERT INTO weekly_reports"
                " (week_start, week_end, tasks, finance, habits, insights,"
                "  suggestion, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
                " ON CONFLICT(week_start) DO UPDATE SET"
                "   week_end = excluded.week_end,"
                "   tasks = excluded.tasks,"
                "   finance = excluded.finance,"
                "   habits = excluded.habits,"
                "   insights = excluded.insights,"
                "   suggestion = excluded.suggestion,"
                "   created_at = excluded.created_at"
                " RETURNING id",
                (report.week_start, report.week_end, *payload),
            ).fetchone()
            return int(row[0]) if row else 0

    report.id = await asyncio.to_thread(_persist)
    return report


async def get_or_generate_current_week(
    store: Store, engine: InsightEngine,
) -> WeeklyReport:
    """Idempotent entry point. Returns the cached row if present."""
    today = _today_sp()
    monday = today - timedelta(days=today.weekday())
    existing = await get_report_for_week(store, monday)
    if existing is not None:
        return existing
    return await generate_weekly_report(store, engine, week_start=monday)


# ---------------------------------------------------------------------------
# Block builders
# ---------------------------------------------------------------------------

async def _build_tasks_block(
    engine: InsightEngine,
    start_dt: datetime,
    end_dt: datetime,
) -> dict[str, Any]:
    task_svc = getattr(engine, "_tasks", None)
    if task_svc is None:
        return {"created": 0, "completed": 0, "overdue": 0}

    try:
        pending = await task_svc.list_tasks(status="pending", limit=500)
        completed = await task_svc.list_tasks(status="completed", limit=500)
    except Exception:
        logger.exception("weekly: list_tasks failed")
        return {"created": 0, "completed": 0, "overdue": 0}

    created_count = 0
    for t in pending + completed:
        c = _parse_iso_datetime(getattr(t, "created_at", None))
        if c is not None and start_dt <= c <= end_dt:
            created_count += 1
    completed_count = 0
    for t in completed:
        u = _parse_iso_datetime(getattr(t, "updated_at", None))
        if u is not None and start_dt <= u <= end_dt:
            completed_count += 1

    today = _today_sp()
    overdue_cutoff = today - timedelta(days=7)
    overdue_count = 0
    for t in pending:
        c = _parse_iso_datetime(getattr(t, "created_at", None))
        if c is not None and c.date() <= overdue_cutoff:
            overdue_count += 1
    return {
        "created": created_count,
        "completed": completed_count,
        "overdue": overdue_count,
    }


async def _build_finance_block(
    engine: InsightEngine,
    monday: date,
    sunday: date,
) -> dict[str, Any]:
    finance_svc = getattr(engine, "_finance", None)
    if finance_svc is None:
        return {"income": 0, "expenses": 0, "balance": 0}

    try:
        # list_entries filters by month/year only; pull the covering
        # months and filter in-memory.
        months: set[tuple[int, int]] = {
            (monday.year, monday.month),
            (sunday.year, sunday.month),
        }
        entries: list[Any] = []
        for y, m in months:
            batch = await finance_svc.list_entries(
                month=m, year=y, limit=1000,
            )
            entries.extend(batch)
    except Exception:
        logger.exception("weekly: list_entries failed")
        return {"income": 0, "expenses": 0, "balance": 0}

    income = 0.0
    expenses = 0.0
    for e in entries:
        if getattr(e, "status", "confirmed") != "confirmed":
            continue
        try:
            d = date.fromisoformat(str(getattr(e, "date", ""))[:10])
        except ValueError:
            continue
        if not (monday <= d <= sunday):
            continue
        amt = float(getattr(e, "amount", 0) or 0)
        if getattr(e, "type", None) == "income":
            income += amt
        elif getattr(e, "type", None) == "expense":
            expenses += amt
    return {
        "income": round(income, 2),
        "expenses": round(expenses, 2),
        "balance": round(income - expenses, 2),
    }


async def _build_habits_block(engine: InsightEngine) -> dict[str, Any]:
    habit_svc = getattr(engine, "_habits", None)
    if habit_svc is None:
        return {"maintained": [], "broken": []}
    try:
        items = await habit_svc.list_with_today_status()
    except Exception:
        logger.exception("weekly: habits failed")
        return {"maintained": [], "broken": []}

    maintained: list[dict[str, Any]] = []
    broken: list[dict[str, Any]] = []
    for it in items:
        current = int(it.get("current_streak") or 0)
        best = int(it.get("best_streak") or 0)
        title = str(it.get("title") or "").strip() or "Habito"
        if current >= 3:
            maintained.append({"title": title, "streak": current})
        elif best >= 3 and current == 0 and it.get("active", True):
            broken.append({"title": title, "best_streak": best})
    return {"maintained": maintained, "broken": broken}


def _suggest_focus(
    tasks: dict[str, Any],
    finance: dict[str, Any],
    habits: dict[str, Any],
    insights: list[dict[str, Any]],
) -> str:
    # Priority: warnings > overdue tasks > negative balance > broken habits.
    warnings = [i for i in insights if i.get("severity") == "warning"]
    if warnings:
        return (
            "Foco da semana: " + warnings[0].get("title", "revisar alertas")
        )
    if int(tasks.get("overdue", 0) or 0) > 0:
        return (
            "Foco da semana: destravar "
            f"{tasks.get('overdue')} tarefa(s) atrasada(s)."
        )
    if float(finance.get("balance", 0) or 0) < 0:
        return (
            "Foco da semana: equilibrar o orcamento -- despesas acima da receita."
        )
    broken = habits.get("broken") or []
    if broken:
        return (
            "Foco da semana: retomar o habito de "
            f"{broken[0].get('title', 'que foi interrompido')}."
        )
    return "Foco da semana: manter o ritmo. Voce esta indo bem."
