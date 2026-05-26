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
from collections import defaultdict
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


_REPORT_COLS = (
    "id, week_start, week_end, tasks, finance, habits,"
    " goals, mood, focus, journal,"
    " insights, suggestion, created_at"
)


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
        goals=_j(row[6], {}),
        mood=_j(row[7], {}),
        focus=_j(row[8], {}),
        journal=_j(row[9], {}),
        insights=_j(row[10], []),
        suggestion=str(row[11] or ""),
        created_at=str(row[12] or ""),
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
                f"SELECT {_REPORT_COLS}"
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
    goals_block = await _build_goals_block(store)
    mood_block = await _build_mood_block(store, monday, sunday)
    focus_block = await _build_focus_block(store, monday, sunday)
    journal_block = await _build_journal_block(store, monday, sunday)

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

    # Cross-domain correlations section ("Conexoes descobertas")
    correlations_block: list[dict[str, Any]] = []
    try:
        from seraphine.insights.correlations import get_weekly_correlations
        top_corrs = await get_weekly_correlations(store, top_n=3)
        correlations_block = [c.to_dict() for c in top_corrs]
    except Exception:
        logger.exception("weekly correlations failed")

    # Merge correlations into insights block so they appear in the report
    # with a marker so the UI can render the "Conexoes descobertas" section.
    for cd in correlations_block:
        insights_block.append({
            "type": "cross_domain",
            "severity": "info",
            "title": (
                f"Conexao: {cd.get('series_a', '')} x {cd.get('series_b', '')}"
            ),
            "description": cd.get("message", ""),
            "data": cd,
        })

    suggestion = _suggest_focus(
        tasks_block, finance_block, habits_block, insights_block,
        goals_block=goals_block,
        mood_block=mood_block,
        focus_block=focus_block,
    )

    ts = _now_iso()
    report = WeeklyReport(
        id=None,
        week_start=monday.isoformat(),
        week_end=sunday.isoformat(),
        tasks=tasks_block,
        finance=finance_block,
        habits=habits_block,
        goals=goals_block,
        mood=mood_block,
        focus=focus_block,
        journal=journal_block,
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
                json.dumps(report.goals, ensure_ascii=False),
                json.dumps(report.mood, ensure_ascii=False),
                json.dumps(report.focus, ensure_ascii=False),
                json.dumps(report.journal, ensure_ascii=False),
                json.dumps(report.insights, ensure_ascii=False),
                report.suggestion,
                report.created_at,
            )
            row = conn.execute(
                "INSERT INTO weekly_reports"
                " (week_start, week_end, tasks, finance, habits,"
                "  goals, mood, focus, journal,"
                "  insights, suggestion, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
                " ON CONFLICT(week_start) DO UPDATE SET"
                "   week_end = excluded.week_end,"
                "   tasks = excluded.tasks,"
                "   finance = excluded.finance,"
                "   habits = excluded.habits,"
                "   goals = excluded.goals,"
                "   mood = excluded.mood,"
                "   focus = excluded.focus,"
                "   journal = excluded.journal,"
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


async def _build_goals_block(store: Store) -> dict[str, Any]:
    """Active goals with progress; flag those at risk."""
    today = _today_sp()

    def _work() -> dict[str, Any]:
        with store._connect() as conn:
            # Check if table exists
            tbl = conn.execute(
                "SELECT name FROM sqlite_master"
                " WHERE type='table' AND name='goals'",
            ).fetchone()
            if tbl is None:
                return {}

            # Active goals with their key results averaged
            rows = conn.execute(
                "SELECT g.id, g.title, g.end_date,"
                "   COALESCE(AVG("
                "     CASE WHEN kr.metric_type = 'boolean'"
                "       THEN CASE WHEN kr.current_value >= 1 THEN 100.0"
                "            ELSE 0.0 END"
                "       ELSE MIN(100.0,"
                "            kr.current_value / NULLIF(kr.target_value, 0)"
                "            * 100.0)"
                "     END"
                "   ), 0) AS progress"
                " FROM goals g"
                " LEFT JOIN key_results kr ON kr.goal_id = g.id"
                " WHERE g.status = 'active'"
                " GROUP BY g.id"
                " ORDER BY progress ASC",
            ).fetchall()

            if not rows:
                return {}

            active_count = len(rows)
            at_risk: list[dict[str, Any]] = []
            on_track = 0
            for r in rows:
                gid, title, end_date_str, progress = (
                    str(r[0]), str(r[1]), r[2], float(r[3]),
                )
                days_left = None
                if end_date_str:
                    try:
                        days_left = (
                            date.fromisoformat(str(end_date_str)) - today
                        ).days
                    except ValueError:
                        pass

                if progress < 30.0 and days_left is not None and days_left < 30:
                    at_risk.append({
                        "id": gid,
                        "title": title,
                        "progress": round(progress, 1),
                        "days_left": days_left,
                    })
                else:
                    on_track += 1

            summary = (
                f"Progresso nos objetivos: {active_count} ativos, "
                f"{len(at_risk)} em risco, {on_track} no caminho"
            )
            return {
                "summary": summary,
                "active_count": active_count,
                "at_risk_count": len(at_risk),
                "on_track_count": on_track,
                "at_risk": at_risk,
            }

    try:
        return await asyncio.to_thread(_work)
    except Exception:
        logger.exception("weekly: goals block failed")
        return {}


async def _build_mood_block(
    store: Store, monday: date, sunday: date,
) -> dict[str, Any]:
    """Mood trend for the week: daily avg valence, best/worst day."""
    start_utc = datetime(
        monday.year, monday.month, monday.day,
        tzinfo=_SP_TZ,
    ).astimezone(timezone.utc).isoformat()
    end_utc = datetime(
        sunday.year, sunday.month, sunday.day,
        hour=23, minute=59, second=59,
        tzinfo=_SP_TZ,
    ).astimezone(timezone.utc).isoformat()

    def _work() -> dict[str, Any]:
        with store._connect() as conn:
            tbl = conn.execute(
                "SELECT name FROM sqlite_master"
                " WHERE type='table' AND name='mood_logs'",
            ).fetchone()
            if tbl is None:
                return {}

            rows = conn.execute(
                "SELECT timestamp, valence FROM mood_logs"
                " WHERE timestamp BETWEEN ? AND ?"
                " ORDER BY timestamp ASC",
                (start_utc, end_utc),
            ).fetchall()

        if not rows:
            return {}

        # Group by SP date
        by_day: dict[str, list[float]] = defaultdict(list)
        for ts_str, valence in rows:
            try:
                ts = datetime.fromisoformat(str(ts_str))
                sp_date = ts.astimezone(_SP_TZ).date().isoformat()
            except (ValueError, TypeError):
                continue
            by_day[sp_date].append(float(valence))

        if not by_day:
            return {}

        daily_avgs: list[dict[str, Any]] = []
        best_day: tuple[str, float] | None = None
        worst_day: tuple[str, float] | None = None
        for day_iso in sorted(by_day):
            vals = by_day[day_iso]
            avg = sum(vals) / len(vals)
            daily_avgs.append({"date": day_iso, "avg_valence": round(avg, 3)})
            if best_day is None or avg > best_day[1]:
                best_day = (day_iso, avg)
            if worst_day is None or avg < worst_day[1]:
                worst_day = (day_iso, avg)

        # Trend: compare first half vs second half average
        n = len(daily_avgs)
        if n >= 2:
            mid = n // 2
            first_half = sum(
                d["avg_valence"] for d in daily_avgs[:mid]
            ) / mid
            second_half = sum(
                d["avg_valence"] for d in daily_avgs[mid:]
            ) / (n - mid)
            diff = second_half - first_half
            if diff > 0.05:
                trend = "subindo"
            elif diff < -0.05:
                trend = "caindo"
            else:
                trend = "estavel"
        else:
            trend = "estavel"

        summary = f"Humor da semana: tendencia {trend}"
        return {
            "summary": summary,
            "trend": trend,
            "daily_avgs": daily_avgs,
            "best_day": best_day[0] if best_day else None,
            "best_valence": round(best_day[1], 3) if best_day else None,
            "worst_day": worst_day[0] if worst_day else None,
            "worst_valence": round(worst_day[1], 3) if worst_day else None,
            "total_logs": sum(len(v) for v in by_day.values()),
        }

    try:
        return await asyncio.to_thread(_work)
    except Exception:
        logger.exception("weekly: mood block failed")
        return {}


async def _build_focus_block(
    store: Store, monday: date, sunday: date,
) -> dict[str, Any]:
    """Focus sessions for the week: total hours, session count, streak."""
    start_utc = datetime(
        monday.year, monday.month, monday.day,
        tzinfo=_SP_TZ,
    ).astimezone(timezone.utc).isoformat()
    end_utc = datetime(
        sunday.year, sunday.month, sunday.day,
        hour=23, minute=59, second=59,
        tzinfo=_SP_TZ,
    ).astimezone(timezone.utc).isoformat()

    def _work() -> dict[str, Any]:
        with store._connect() as conn:
            tbl = conn.execute(
                "SELECT name FROM sqlite_master"
                " WHERE type='table' AND name='focus_sessions'",
            ).fetchone()
            if tbl is None:
                return {}

            rows = conn.execute(
                "SELECT started_at, duration_sec, type, completed"
                " FROM focus_sessions"
                " WHERE started_at BETWEEN ? AND ?",
                (start_utc, end_utc),
            ).fetchall()

        if not rows:
            return {}

        total_sec = 0
        completed_count = 0
        total_work = 0
        days_with_focus: set[str] = set()

        for started_at, dur, stype, completed in rows:
            if str(stype) == "work":
                total_sec += int(dur)
                total_work += 1
                if int(completed):
                    completed_count += 1
                # Track unique days
                try:
                    ts = datetime.fromisoformat(str(started_at))
                    sp_date = ts.astimezone(_SP_TZ).date().isoformat()
                    days_with_focus.add(sp_date)
                except (ValueError, TypeError):
                    pass

        if total_work == 0:
            return {}

        total_hours = round(total_sec / 3600, 1)
        completion_rate = round(
            completed_count / total_work * 100, 1,
        ) if total_work > 0 else 0.0

        # Streak: consecutive days with >= 1 completed work session,
        # counting backwards from today (or yesterday).
        streak = _compute_focus_streak(store)

        summary = (
            f"Foco: {total_hours}h em {total_work} sessoes,"
            f" {len(days_with_focus)} dias de streak"
        )
        return {
            "summary": summary,
            "total_hours": total_hours,
            "total_sessions": total_work,
            "completed_sessions": completed_count,
            "completion_rate": completion_rate,
            "streak_days": streak,
            "days_with_focus": len(days_with_focus),
        }

    try:
        return await asyncio.to_thread(_work)
    except Exception:
        logger.exception("weekly: focus block failed")
        return {}


def _compute_focus_streak(store: Store) -> int:
    """Consecutive days ending at today with >= 1 completed work session."""
    today = _today_sp()
    with store._connect() as conn:
        rows = conn.execute(
            "SELECT started_at FROM focus_sessions"
            " WHERE completed = 1 AND type = 'work'"
            " ORDER BY started_at DESC",
        ).fetchall()
    dates: set[str] = set()
    for r in rows:
        try:
            ts = datetime.fromisoformat(str(r[0]))
            dates.add(ts.astimezone(_SP_TZ).date().isoformat())
        except (ValueError, TypeError):
            continue

    if not dates:
        return 0

    streak = 0
    d = today
    if d.isoformat() not in dates:
        d = d - timedelta(days=1)
    while d.isoformat() in dates:
        streak += 1
        d = d - timedelta(days=1)
    return streak


async def _build_journal_block(
    store: Store, monday: date, sunday: date,
) -> dict[str, Any]:
    """Count journal entries for the week."""
    start_iso = monday.isoformat()
    end_iso = sunday.isoformat()

    def _work() -> dict[str, Any]:
        with store._connect() as conn:
            tbl = conn.execute(
                "SELECT name FROM sqlite_master"
                " WHERE type='table' AND name='journal_entries'",
            ).fetchone()
            if tbl is None:
                return {}

            row = conn.execute(
                "SELECT COUNT(*) FROM journal_entries"
                " WHERE date BETWEEN ? AND ?",
                (start_iso, end_iso),
            ).fetchone()

        count = int(row[0]) if row else 0
        if count == 0:
            return {}

        summary = f"Diario: {count} entradas esta semana"
        return {"summary": summary, "entry_count": count}

    try:
        return await asyncio.to_thread(_work)
    except Exception:
        logger.exception("weekly: journal block failed")
        return {}


def _suggest_focus(
    tasks: dict[str, Any],
    finance: dict[str, Any],
    habits: dict[str, Any],
    insights: list[dict[str, Any]],
    *,
    goals_block: dict[str, Any] | None = None,
    mood_block: dict[str, Any] | None = None,
    focus_block: dict[str, Any] | None = None,
) -> str:
    # Priority: warnings > goals at risk > overdue tasks > negative balance
    #           > mood dropping > broken habits.
    warnings = [i for i in insights if i.get("severity") == "warning"]
    if warnings:
        return (
            "Foco da semana: " + warnings[0].get("title", "revisar alertas")
        )

    # Goals at risk
    if goals_block:
        at_risk = goals_block.get("at_risk_count", 0)
        if at_risk > 0:
            return (
                f"Foco da semana: {at_risk} objetivo(s) em risco"
                " -- revisar key results."
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

    # Mood dropping
    if mood_block and mood_block.get("trend") == "caindo":
        return (
            "Foco da semana: cuidar do bem-estar"
            " -- humor em tendencia de queda."
        )

    broken = habits.get("broken") or []
    if broken:
        return (
            "Foco da semana: retomar o habito de "
            f"{broken[0].get('title', 'que foi interrompido')}."
        )
    return "Foco da semana: manter o ritmo. Voce esta indo bem."
