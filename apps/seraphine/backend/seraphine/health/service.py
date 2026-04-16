"""HealthService -- persist Apple Health snapshots and expose queries.

Single-tenant (no user_id). Snapshots are pushed by the Tauri frontend,
which owns the HealthKit bridge; the backend's job is bookkeeping plus
derived queries (today summary, metric trend, weekly report) and any
integrations that should fire when a new snapshot lands (habits
auto-complete).
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import date, datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Iterable
from zoneinfo import ZoneInfo

from core_db import Store

from seraphine.health.models import (
    HealthSnapshot,
    HealthTrendPoint,
    WorkoutEntry,
)

logger = logging.getLogger(__name__)

_SP_TZ = ZoneInfo("America/Sao_Paulo")

_VALID_METRICS = ("steps", "active_calories", "sleep", "weight", "heart_rate")

_SNAPSHOT_COLS = (
    "date, steps, active_calories, resting_heart_rate,"
    " sleep_minutes, sleep_quality, weight_kg, workouts_json, synced_at"
)

# ---------------------------------------------------------------------------
# Habit auto-complete matching
# ---------------------------------------------------------------------------
#
# When a snapshot arrives we try to auto-mark the user's habits. Keys are
# lowercase PT-BR keywords found in habit titles; values are predicates
# applied to the snapshot. The first matching habit per keyword gets
# toggled (noop if already marked).

_STEPS_DEFAULT_GOAL = 10_000
_SLEEP_DEFAULT_MIN = 7 * 60  # 7h


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _today_sp() -> date:
    return datetime.now(_SP_TZ).date()


def _parse_iso_date(s: str) -> date:
    try:
        return date.fromisoformat(s[:10])
    except (ValueError, TypeError) as exc:
        raise ValueError(f"invalid date: {s!r}") from exc


def _derive_sleep_quality(sleep_minutes: float | None) -> str | None:
    """Rough quality label based on sleep duration alone.

    We can't see REM/deep breakdown here (the frontend hides HealthKit
    detail), so we use duration buckets: >= 7h => 'boa', 5..7h =>
    'regular', < 5h => 'ruim'. None returned when no sleep data.
    """
    if sleep_minutes is None:
        return None
    m = float(sleep_minutes)
    if m <= 0:
        return None
    if m >= 7 * 60:
        return "boa"
    if m >= 5 * 60:
        return "regular"
    return "ruim"


def _parse_workouts(raw: str | None) -> list[WorkoutEntry]:
    if not raw:
        return []
    try:
        arr = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return []
    if not isinstance(arr, list):
        return []
    out: list[WorkoutEntry] = []
    for item in arr:
        if not isinstance(item, dict):
            continue
        try:
            out.append(
                WorkoutEntry(
                    type=str(item.get("type") or "workout"),
                    start=str(item.get("start") or ""),
                    end=str(item.get("end") or ""),
                    duration_min=float(item.get("duration_min") or 0),
                    calories=(
                        float(item["calories"])
                        if item.get("calories") is not None
                        else None
                    ),
                    distance_km=(
                        float(item["distance_km"])
                        if item.get("distance_km") is not None
                        else None
                    ),
                )
            )
        except (TypeError, ValueError):
            continue
    return out


def _serialize_workouts(workouts: Iterable[WorkoutEntry]) -> str:
    return json.dumps(
        [w.to_dict() for w in workouts], ensure_ascii=False,
    )


def _row_to_snapshot(row: tuple[Any, ...]) -> HealthSnapshot:
    return HealthSnapshot(
        date=str(row[0]),
        steps=int(row[1] or 0),
        active_calories=float(row[2] or 0.0),
        resting_heart_rate=(
            float(row[3]) if row[3] is not None else None
        ),
        sleep_minutes=(float(row[4]) if row[4] is not None else None),
        sleep_quality=(str(row[5]) if row[5] is not None else None),
        weight_kg=(float(row[6]) if row[6] is not None else None),
        workouts=_parse_workouts(row[7]),
        synced_at=str(row[8] or ""),
    )


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------

HabitAutoCompleteCallback = Callable[
    [HealthSnapshot], Awaitable[list[dict[str, Any]]],
]


class HealthService:
    """Store + query Apple Health daily snapshots.

    The service is intentionally thin: no HealthKit logic lives here. The
    frontend owns HealthKit access and sends us normalized daily
    snapshots over HTTP. Consumers of this service (LLM tools, dashboard
    widget, insights engine, habits auto-complete) read back whatever was
    pushed.
    """

    def __init__(
        self,
        store: Store,
        *,
        habit_service: Any = None,
    ) -> None:
        self._store = store
        self._habit_service = habit_service

    # ------------------------------------------------------------------
    # Ingest
    # ------------------------------------------------------------------

    async def store_snapshot(
        self,
        *,
        date: str,
        steps: int | float = 0,
        active_calories: float = 0.0,
        resting_heart_rate: float | None = None,
        sleep_minutes: float | None = None,
        sleep_quality: str | None = None,
        weight_kg: float | None = None,
        workouts: list[dict[str, Any]] | None = None,
    ) -> HealthSnapshot:
        """Upsert a daily snapshot. Returns the stored row."""
        d_iso = _parse_iso_date(date).isoformat()

        steps_int = int(float(steps or 0))
        if steps_int < 0:
            raise ValueError(f"steps must be >= 0, got {steps!r}")
        cals = float(active_calories or 0.0)
        if cals < 0:
            raise ValueError(f"active_calories must be >= 0, got {active_calories!r}")

        workout_entries: list[WorkoutEntry] = []
        for w in workouts or []:
            try:
                workout_entries.append(
                    WorkoutEntry(
                        type=str(w.get("type") or "workout"),
                        start=str(w.get("start") or ""),
                        end=str(w.get("end") or ""),
                        duration_min=float(w.get("duration_min") or 0),
                        calories=(
                            float(w["calories"])
                            if w.get("calories") is not None
                            else None
                        ),
                        distance_km=(
                            float(w["distance_km"])
                            if w.get("distance_km") is not None
                            else None
                        ),
                    )
                )
            except (TypeError, ValueError):
                continue

        quality = sleep_quality or _derive_sleep_quality(sleep_minutes)
        now_iso = _now_iso()
        workouts_json = _serialize_workouts(workout_entries)

        def _work() -> HealthSnapshot:
            with self._store._connect() as conn:
                conn.execute(
                    "INSERT INTO health_snapshots"
                    f" ({_SNAPSHOT_COLS})"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
                    " ON CONFLICT(date) DO UPDATE SET"
                    "   steps = excluded.steps,"
                    "   active_calories = excluded.active_calories,"
                    "   resting_heart_rate = excluded.resting_heart_rate,"
                    "   sleep_minutes = excluded.sleep_minutes,"
                    "   sleep_quality = excluded.sleep_quality,"
                    "   weight_kg = excluded.weight_kg,"
                    "   workouts_json = excluded.workouts_json,"
                    "   synced_at = excluded.synced_at",
                    (
                        d_iso,
                        steps_int,
                        cals,
                        resting_heart_rate,
                        sleep_minutes,
                        quality,
                        weight_kg,
                        workouts_json,
                        now_iso,
                    ),
                )
                row = conn.execute(
                    f"SELECT {_SNAPSHOT_COLS} FROM health_snapshots"
                    " WHERE date = ?",
                    (d_iso,),
                ).fetchone()
            return _row_to_snapshot(row)

        snapshot = await asyncio.to_thread(_work)

        # Best-effort habit auto-complete. Swallow errors so a broken
        # habit service never blocks an ingest.
        try:
            await self._auto_complete_habits(snapshot)
        except Exception:
            logger.exception("auto_complete_habits failed for %s", d_iso)

        return snapshot

    # ------------------------------------------------------------------
    # Queries
    # ------------------------------------------------------------------

    async def get_snapshot(self, iso_date: str) -> HealthSnapshot | None:
        d = _parse_iso_date(iso_date).isoformat()

        def _work() -> HealthSnapshot | None:
            with self._store._connect() as conn:
                row = conn.execute(
                    f"SELECT {_SNAPSHOT_COLS} FROM health_snapshots"
                    " WHERE date = ?",
                    (d,),
                ).fetchone()
            return _row_to_snapshot(row) if row else None

        return await asyncio.to_thread(_work)

    async def get_today(self) -> HealthSnapshot | None:
        return await self.get_snapshot(_today_sp().isoformat())

    async def get_range(
        self, start: str | date, end: str | date,
    ) -> list[HealthSnapshot]:
        start_d = _parse_iso_date(str(start)) if not isinstance(start, date) else start
        end_d = _parse_iso_date(str(end)) if not isinstance(end, date) else end
        if end_d < start_d:
            raise ValueError("end must be >= start")

        def _work() -> list[HealthSnapshot]:
            with self._store._connect() as conn:
                rows = conn.execute(
                    f"SELECT {_SNAPSHOT_COLS} FROM health_snapshots"
                    " WHERE date BETWEEN ? AND ?"
                    " ORDER BY date ASC",
                    (start_d.isoformat(), end_d.isoformat()),
                ).fetchall()
            return [_row_to_snapshot(r) for r in rows]

        return await asyncio.to_thread(_work)

    async def get_recent(self, days: int = 7) -> list[HealthSnapshot]:
        n = int(days)
        if n <= 0 or n > 365:
            raise ValueError("days must be 1..365")
        today = _today_sp()
        start = today - timedelta(days=n - 1)
        return await self.get_range(start, today)

    async def get_trend(
        self, metric: str, days: int = 14,
    ) -> list[HealthTrendPoint]:
        """Return one trend point per day for the requested metric.

        Days with no snapshot are simply omitted (the analyser upstream
        can decide how to handle gaps).
        """
        if metric not in _VALID_METRICS:
            raise ValueError(
                f"invalid metric: {metric!r} (must be one of "
                f"{', '.join(_VALID_METRICS)})"
            )
        snapshots = await self.get_recent(days=int(days))
        out: list[HealthTrendPoint] = []
        for s in snapshots:
            v = self._extract_metric(s, metric)
            if v is None:
                continue
            out.append(HealthTrendPoint(date=s.date, value=float(v)))
        return out

    async def get_weekly_report(self) -> dict[str, Any]:
        """Aggregate last 7 days into averages + totals for UI/insights."""
        snapshots = await self.get_recent(days=7)
        if not snapshots:
            return {
                "days": 0,
                "steps_avg": 0,
                "steps_total": 0,
                "active_calories_avg": 0.0,
                "workouts_total": 0,
                "workout_minutes_total": 0.0,
                "sleep_avg_minutes": None,
                "resting_heart_rate_avg": None,
                "weight_latest": None,
                "snapshots": [],
            }

        steps_total = sum(s.steps for s in snapshots)
        cals_total = sum(s.active_calories for s in snapshots)
        workouts_total = sum(len(s.workouts) for s in snapshots)
        workout_minutes = sum(s.workout_minutes for s in snapshots)

        sleep_vals = [s.sleep_minutes for s in snapshots if s.sleep_minutes]
        rhr_vals = [
            s.resting_heart_rate for s in snapshots if s.resting_heart_rate
        ]
        weight_vals = [
            (s.date, s.weight_kg) for s in snapshots if s.weight_kg is not None
        ]

        latest_weight = weight_vals[-1][1] if weight_vals else None

        return {
            "days": len(snapshots),
            "steps_avg": int(round(steps_total / len(snapshots))),
            "steps_total": int(steps_total),
            "active_calories_avg": round(cals_total / len(snapshots), 1),
            "workouts_total": int(workouts_total),
            "workout_minutes_total": round(workout_minutes, 1),
            "sleep_avg_minutes": (
                round(sum(sleep_vals) / len(sleep_vals), 1)
                if sleep_vals
                else None
            ),
            "resting_heart_rate_avg": (
                round(sum(rhr_vals) / len(rhr_vals), 1) if rhr_vals else None
            ),
            "weight_latest": latest_weight,
            "snapshots": [s.to_dict() for s in snapshots],
        }

    # ------------------------------------------------------------------
    # Admin
    # ------------------------------------------------------------------

    async def delete_snapshot(self, iso_date: str) -> bool:
        d = _parse_iso_date(iso_date).isoformat()

        def _work() -> int:
            with self._store._connect() as conn:
                cur = conn.execute(
                    "DELETE FROM health_snapshots WHERE date = ?",
                    (d,),
                )
                return cur.rowcount or 0

        affected = await asyncio.to_thread(_work)
        return affected > 0

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _extract_metric(snapshot: HealthSnapshot, metric: str) -> float | None:
        if metric == "steps":
            return float(snapshot.steps)
        if metric == "active_calories":
            return float(snapshot.active_calories)
        if metric == "sleep":
            return (
                float(snapshot.sleep_minutes)
                if snapshot.sleep_minutes is not None
                else None
            )
        if metric == "weight":
            return (
                float(snapshot.weight_kg)
                if snapshot.weight_kg is not None
                else None
            )
        if metric == "heart_rate":
            return (
                float(snapshot.resting_heart_rate)
                if snapshot.resting_heart_rate is not None
                else None
            )
        return None

    # ------------------------------------------------------------------
    # Habit auto-complete
    # ------------------------------------------------------------------

    async def _auto_complete_habits(
        self, snapshot: HealthSnapshot,
    ) -> list[dict[str, Any]]:
        """Auto-mark habits whose title matches a health signal for today.

        Matching is a case-insensitive substring test against the habit
        title. Each matcher only fires when its metric actually crosses
        the threshold for ``snapshot.date``. Returns a list describing
        which habits were toggled, for logging/telemetry purposes.
        """
        svc = self._habit_service
        if svc is None or snapshot.date != _today_sp().isoformat():
            # Only auto-complete for the current day — snapshots for
            # past days are usually backfills and we don't want them to
            # silently rewrite streaks.
            return []

        try:
            habits = await svc.list_with_today_status()
        except Exception:
            logger.exception("auto_complete_habits: list_with_today_status failed")
            return []

        # Build the trigger list for this snapshot.
        triggers: list[tuple[tuple[str, ...], bool]] = [
            # (keywords, fired_for_today)
            (("passos", "steps"), snapshot.steps >= _STEPS_DEFAULT_GOAL),
            (
                ("exercicio", "exercício", "treino", "corrida", "corrid", "academia"),
                bool(snapshot.workouts),
            ),
            (
                ("sono", "dormir", "cama"),
                snapshot.sleep_minutes is not None
                and snapshot.sleep_minutes >= _SLEEP_DEFAULT_MIN,
            ),
        ]

        toggled: list[dict[str, Any]] = []
        for keywords, fired in triggers:
            if not fired:
                continue
            for kw in keywords:
                match = self._find_habit_by_keyword(habits, kw)
                if match is None:
                    continue
                habit_id = str(match.get("id") or "")
                if not habit_id:
                    continue
                if bool(match.get("today_completed")):
                    # Already marked; skip to avoid flip-flopping.
                    break
                try:
                    result = await svc.toggle(habit_id)
                except Exception:
                    logger.exception(
                        "auto_complete_habits: toggle failed for %s", habit_id,
                    )
                    break
                if result is not None:
                    toggled.append(
                        {
                            "habit_id": habit_id,
                            "title": match.get("title"),
                            "keyword": kw,
                            "current_streak": result.get("current_streak"),
                        }
                    )
                # Stop after the first matching habit per trigger.
                break
        if toggled:
            logger.info(
                "health: auto-completed %d habit(s) from snapshot %s",
                len(toggled), snapshot.date,
            )
        return toggled

    @staticmethod
    def _find_habit_by_keyword(
        habits: list[dict[str, Any]], keyword: str,
    ) -> dict[str, Any] | None:
        kw = (keyword or "").strip().lower()
        if not kw:
            return None
        for h in habits:
            if not h.get("is_target_today", True):
                continue
            title = str(h.get("title") or "").lower()
            if kw in title:
                return h
        return None
