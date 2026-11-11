"""Calendar aggregation API -- unified per-day view (SDD 083).

Combines Google Calendar events, tasks, habits, health snapshots, and
water logs into a single endpoint. The score heatmap is computed
server-side so the frontend can colour days with zero extra logic.
"""

from __future__ import annotations

import asyncio
import logging
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request

router = APIRouter(prefix="/calendar", tags=["calendar"])
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _parse_date(s: str) -> date:
    try:
        return date.fromisoformat(s[:10])
    except (ValueError, TypeError) as exc:
        raise HTTPException(
            status_code=422, detail=f"invalid date: {s!r}"
        ) from exc


def _score(day: dict[str, Any]) -> int:
    """Compute activity score 0-7 for a single day aggregate.

    Original 5 dimensions (task, habit, water, steps, sleep) plus:
      +1 if focus >= 60 min
      +1 if mood avg_valence > 0.5

    Score cap is 7. We chose to expand from 5 to 7 rather than
    compressing into 5 because the new signals are independent axes
    and capping at 5 would hide legitimate effort.
    """
    s = 0
    # +1 if any task is done
    for t in day.get("tasks", []):
        if t.get("status") == "done":
            s += 1
            break
    # +1 if any habit is completed
    for h in day.get("habits", []):
        if h.get("completed"):
            s += 1
            break
    # +1 if water goal met
    water = day.get("water")
    if water and water.get("goal_ml") and water["goal_ml"] > 0:
        if water.get("intake_ml", 0) >= water["goal_ml"]:
            s += 1
    # +1 if steps > 8000
    health = day.get("health")
    if health and health.get("steps", 0) > 8000:
        s += 1
    # +1 if sleep > 7h (420 minutes)
    if health and health.get("sleep_minutes") and health["sleep_minutes"] > 420:
        s += 1
    # +1 if focus >= 60 min
    focus = day.get("focus")
    if focus and focus.get("total_min", 0) >= 60:
        s += 1
    # +1 if mood avg_valence > 0.5
    mood = day.get("mood")
    if mood and mood.get("avg_valence", 0) > 0.5:
        s += 1
    return min(s, 7)


def _event_row(ev: dict[str, Any]) -> dict[str, Any]:
    """Projeção de um evento do Google para o agregado.

    Pura de propósito: é o que o widget e a lista do dia leem, e testar
    pela rota exigiria Google, tarefas, hábitos, saúde e água de pé.
    """
    start = ev.get("start", {}) or {}
    end = ev.get("end", {}) or {}
    return {
        # O id do Google vai junto porque é o que torna a linha ACIONÁVEL:
        # a lista do dia do celular sai daqui, e sem ele apagar viraria
        # adivinhação por título e horário — dois "Dentista" às 14h são
        # dois eventos diferentes. Sempre presente, ainda que vazio, para
        # o consumidor não ter que distinguir ausência de vazio.
        "id": str(ev.get("id") or ""),
        "title": ev.get("summary", "(sem titulo)"),
        "start": start.get("dateTime") or start.get("date") or "",
        "end": end.get("dateTime") or end.get("date") or "",
        # O Google devolve `location` e o agregado descartava. O widget
        # grande mostra "Dentista · Av. Paulista" na linha da agenda.
        "location": str(ev.get("location") or ""),
    }


def _task_row(task: Any) -> dict[str, Any]:
    """Projeção de uma tarefa para o agregado. Ver `_event_row`."""
    return {
        "id": task.id,
        "title": task.title,
        "status": task.status,
        # due_time existe no TaskService e o agregado descartava; o widget
        # mostra o prazo à direita da linha.
        "due_time": getattr(task, "due_time", None) or "",
    }


# ---------------------------------------------------------------------------
# Route
# ---------------------------------------------------------------------------

@router.get("/aggregate")
async def aggregate(
    request: Request,
    start: str = Query(..., description="YYYY-MM-DD"),
    end: str = Query(..., description="YYYY-MM-DD"),
) -> dict[str, Any]:
    start_d = _parse_date(start)
    end_d = _parse_date(end)
    if end_d < start_d:
        raise HTTPException(status_code=422, detail="end must be >= start")
    # Cap range to ~3 months to avoid abuse
    if (end_d - start_d).days > 100:
        raise HTTPException(status_code=422, detail="range too large (max 100 days)")

    # Build empty day map
    day_map: dict[str, dict[str, Any]] = {}
    d = start_d
    while d <= end_d:
        iso = d.isoformat()
        day_map[iso] = {
            "date": iso,
            "tasks": [],
            "habits": [],
            "health": None,
            "water": None,
            "mood": None,
            "focus": None,
            "journal": None,
            "events": [],
            "score": 0,
        }
        d += timedelta(days=1)

    # Gather data concurrently from all available services
    google_client = getattr(request.app.state, "google_client", None)
    task_service = getattr(request.app.state, "task_service", None)
    habit_service = getattr(request.app.state, "habit_service", None)
    health_service = getattr(request.app.state, "health_service", None)
    water_service = getattr(request.app.state, "water_service", None)
    mood_service = getattr(request.app.state, "mood_service", None)
    focus_service = getattr(request.app.state, "focus_service", None)
    journal_service = getattr(request.app.state, "journal_service", None)

    async def _fetch_events() -> list[dict[str, Any]]:
        if google_client is None:
            return []
        try:
            # Google API expects datetime, not date
            time_min = datetime(
                start_d.year, start_d.month, start_d.day,
                tzinfo=timezone.utc,
            )
            time_max = datetime(
                end_d.year, end_d.month, end_d.day, 23, 59, 59,
                tzinfo=timezone.utc,
            )
            raw = await google_client.list_events(
                time_min=time_min,
                time_max=time_max,
                max_results=200,
            )
            return raw
        except Exception:
            logger.exception("calendar aggregate: google events fetch failed")
            return []

    async def _fetch_tasks() -> list[Any]:
        if task_service is None:
            return []
        try:
            return await task_service.list_tasks(
                due_from=start_d.isoformat(),
                due_to=end_d.isoformat(),
                limit=500,
            )
        except Exception:
            logger.exception("calendar aggregate: tasks fetch failed")
            return []

    async def _fetch_habits() -> tuple[list[dict[str, Any]], dict[str, list[dict[str, Any]]]]:
        """Return (active_habits, logs_by_date).

        logs_by_date maps YYYY-MM-DD -> list of {habit_id, name, completed}.
        """
        if habit_service is None:
            return [], {}
        try:
            habits = await habit_service.list_active()
            # Fetch logs for each habit across the range. The service
            # only has get_calendar(habit_id, month, year), so we query
            # each month that overlaps [start, end] for each habit.
            months: set[tuple[int, int]] = set()
            cursor = date(start_d.year, start_d.month, 1)
            while cursor <= end_d:
                months.add((cursor.year, cursor.month))
                if cursor.month == 12:
                    cursor = date(cursor.year + 1, 1, 1)
                else:
                    cursor = date(cursor.year, cursor.month + 1, 1)

            logs_by_date: dict[str, list[dict[str, Any]]] = defaultdict(list)

            for habit in habits:
                for year, month in months:
                    try:
                        logs = await habit_service.get_calendar(habit.id, month, year)
                        for log in logs:
                            if log.date in day_map:
                                logs_by_date[log.date].append({
                                    "habit_id": habit.id,
                                    "name": habit.title,
                                    "completed": log.completed,
                                })
                    except Exception:
                        logger.exception(
                            "calendar aggregate: habit calendar fetch failed "
                            "habit=%s month=%d/%d", habit.id, month, year,
                        )
            return [h.to_dict() for h in habits], dict(logs_by_date)
        except Exception:
            logger.exception("calendar aggregate: habits fetch failed")
            return [], {}

    async def _fetch_health() -> list[Any]:
        if health_service is None:
            return []
        try:
            return await health_service.get_range(start_d, end_d)
        except Exception:
            logger.exception("calendar aggregate: health fetch failed")
            return []

    async def _fetch_water() -> tuple[dict[str, int], int]:
        """Return (totals_by_date, goal_ml)."""
        if water_service is None:
            return {}, 0
        try:
            profile = await water_service.get_profile()
            goal_ml = profile.daily_goal_ml if profile else 0

            def _query_totals() -> dict[str, int]:
                with water_service._store._connect() as conn:
                    rows = conn.execute(
                        "SELECT date, COALESCE(SUM(amount_ml), 0)"
                        " FROM water_logs"
                        " WHERE date BETWEEN ? AND ?"
                        " GROUP BY date",
                        (start_d.isoformat(), end_d.isoformat()),
                    ).fetchall()
                return {str(r[0]): int(r[1] or 0) for r in rows}

            totals = await asyncio.to_thread(_query_totals)
            return totals, goal_ml
        except Exception:
            logger.exception("calendar aggregate: water fetch failed")
            return {}, 0

    async def _fetch_mood() -> dict[str, dict[str, Any]]:
        """Return mood aggregate per day: {date: {avg_valence, predominant_label}}."""
        if mood_service is None:
            return {}
        try:
            def _query() -> dict[str, dict[str, Any]]:
                with mood_service._store._connect() as conn:
                    # Guard: table might not exist yet
                    tbl = conn.execute(
                        "SELECT name FROM sqlite_master"
                        " WHERE type='table' AND name='mood_logs'",
                    ).fetchone()
                    if not tbl:
                        return {}
                    rows = conn.execute(
                        "SELECT date(timestamp) AS d,"
                        "   AVG(valence) AS avg_v,"
                        "   COUNT(*) AS cnt,"
                        "   label"
                        " FROM mood_logs"
                        " WHERE date(timestamp) BETWEEN ? AND ?"
                        " GROUP BY d, label"
                        " ORDER BY d, cnt DESC",
                        (start_d.isoformat(), end_d.isoformat()),
                    ).fetchall()
                # Aggregate: per day, compute avg_valence and predominant label
                from collections import defaultdict as _dd

                day_agg: dict[str, dict[str, Any]] = {}
                label_counts: dict[str, dict[str, int]] = _dd(lambda: _dd(int))
                valence_sums: dict[str, list[float]] = _dd(list)

                for r in rows:
                    d_str = str(r[0])
                    valence_sums[d_str].append(float(r[1]) * int(r[2]))
                    label_counts[d_str][str(r[3])] += int(r[2])

                for d_str, vals in valence_sums.items():
                    total_count = sum(label_counts[d_str].values())
                    avg_v = sum(vals) / total_count if total_count else 0.0
                    predominant = max(
                        label_counts[d_str],
                        key=lambda k: label_counts[d_str][k],
                    )
                    day_agg[d_str] = {
                        "avg_valence": round(avg_v, 3),
                        "predominant_label": predominant,
                    }
                return day_agg

            return await asyncio.to_thread(_query)
        except Exception:
            logger.exception("calendar aggregate: mood fetch failed")
            return {}

    async def _fetch_focus() -> dict[str, dict[str, Any]]:
        """Return focus aggregate per day: {date: {total_min, sessions_count}}."""
        if focus_service is None:
            return {}
        try:
            def _query() -> dict[str, dict[str, Any]]:
                with focus_service._store._connect() as conn:
                    tbl = conn.execute(
                        "SELECT name FROM sqlite_master"
                        " WHERE type='table' AND name='focus_sessions'",
                    ).fetchone()
                    if not tbl:
                        return {}
                    rows = conn.execute(
                        "SELECT date(started_at) AS d,"
                        "   COALESCE(SUM(duration_sec), 0) AS total_sec,"
                        "   COUNT(*) AS cnt"
                        " FROM focus_sessions"
                        " WHERE date(started_at) BETWEEN ? AND ?"
                        "   AND type = 'work'"
                        " GROUP BY d",
                        (start_d.isoformat(), end_d.isoformat()),
                    ).fetchall()
                return {
                    str(r[0]): {
                        "total_min": int(r[1]) // 60,
                        "sessions_count": int(r[2]),
                    }
                    for r in rows
                }

            return await asyncio.to_thread(_query)
        except Exception:
            logger.exception("calendar aggregate: focus fetch failed")
            return {}

    async def _fetch_journal() -> dict[str, dict[str, Any]]:
        """Return journal entry count per day: {date: {count}}."""
        if journal_service is None:
            return {}
        try:
            def _query() -> dict[str, dict[str, Any]]:
                with journal_service._store._connect() as conn:
                    tbl = conn.execute(
                        "SELECT name FROM sqlite_master"
                        " WHERE type='table' AND name='journal_entries'",
                    ).fetchone()
                    if not tbl:
                        return {}
                    rows = conn.execute(
                        "SELECT date, COUNT(*) AS cnt"
                        " FROM journal_entries"
                        " WHERE date BETWEEN ? AND ?"
                        " GROUP BY date",
                        (start_d.isoformat(), end_d.isoformat()),
                    ).fetchall()
                return {
                    str(r[0]): {"count": int(r[1])}
                    for r in rows
                }

            return await asyncio.to_thread(_query)
        except Exception:
            logger.exception("calendar aggregate: journal fetch failed")
            return {}

    # Run all fetches concurrently
    (
        events_raw,
        tasks_raw,
        (_, habits_by_date),
        health_snapshots,
        (water_totals, water_goal),
        mood_by_date,
        focus_by_date,
        journal_by_date,
    ) = await asyncio.gather(
        _fetch_events(),
        _fetch_tasks(),
        _fetch_habits(),
        _fetch_health(),
        _fetch_water(),
        _fetch_mood(),
        _fetch_focus(),
        _fetch_journal(),
    )

    # Populate events
    for ev in events_raw:
        # Parse start date from Google Calendar event
        ev_start = ev.get("start", {})
        raw_dt = ev_start.get("dateTime") or ev_start.get("date") or ""
        try:
            dt_str = raw_dt[:10]
            if dt_str in day_map:
                day_map[dt_str]["events"].append(_event_row(ev))
        except (ValueError, IndexError):
            continue

    # Populate tasks
    for task in tasks_raw:
        dd = task.due_date
        if dd and dd in day_map:
            day_map[dd]["tasks"].append(_task_row(task))

    # Populate habits
    for dt_iso, logs in habits_by_date.items():
        if dt_iso in day_map:
            day_map[dt_iso]["habits"] = logs

    # Populate health
    for snap in health_snapshots:
        if snap.date in day_map:
            day_map[snap.date]["health"] = {
                "steps": snap.steps,
                "sleep_minutes": snap.sleep_minutes,
                "sleep_hours": (
                    round(snap.sleep_minutes / 60, 1)
                    if snap.sleep_minutes
                    else None
                ),
                "calories": round(snap.active_calories, 1),
                "resting_hr": (
                    round(snap.resting_heart_rate, 1)
                    if snap.resting_heart_rate
                    else None
                ),
            }

    # Populate water
    for dt_iso, total in water_totals.items():
        if dt_iso in day_map:
            day_map[dt_iso]["water"] = {
                "intake_ml": total,
                "goal_ml": water_goal,
            }

    # Populate mood
    for dt_iso, data in mood_by_date.items():
        if dt_iso in day_map:
            day_map[dt_iso]["mood"] = data

    # Populate focus
    for dt_iso, data in focus_by_date.items():
        if dt_iso in day_map:
            day_map[dt_iso]["focus"] = data

    # Populate journal
    for dt_iso, data in journal_by_date.items():
        if dt_iso in day_map:
            day_map[dt_iso]["journal"] = data

    # Score each day
    for day in day_map.values():
        day["score"] = _score(day)

    # Sort by date
    days = sorted(day_map.values(), key=lambda d: d["date"])
    return {"days": days}
