"""WaterService -- singleton profile + intake log CRUD.

Single-tenant: no user_id scoping. Daily goal is computed from the user's
weight and activity level. Intakes are bucketed per day in
America/Sao_Paulo time.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import date, datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from core_db import Store

from seraphine.water.models import WaterLog, WaterProfile

logger = logging.getLogger(__name__)


_SP_TZ = ZoneInfo("America/Sao_Paulo")

_VALID_ACTIVITY = ("sedentary", "moderate", "active")

# Rough ml-per-kg multipliers by activity level. Clamped to sane bounds so
# extreme weights don't produce silly goals.
_ACTIVITY_ML_PER_KG: dict[str, int] = {
    "sedentary": 30,
    "moderate": 35,
    "active": 40,
}

_GOAL_MIN_ML = 1500
_GOAL_MAX_ML = 5000

_PROFILE_COLS = (
    "weight_kg, height_cm, activity_level, daily_goal_ml,"
    " reminder_enabled, reminder_start, reminder_end,"
    " reminder_interval_hours, updated_at, last_reminder_fired_at"
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _today_sp() -> date:
    return datetime.now(_SP_TZ).date()


_HHMM_LEN = 5


def _validate_hhmm(value: str, field: str) -> str:
    s = str(value or "").strip()
    if len(s) != _HHMM_LEN or s[2] != ":":
        raise ValueError(f"{field} must be HH:MM, got {value!r}")
    try:
        hh = int(s[:2])
        mm = int(s[3:])
    except ValueError as exc:
        raise ValueError(f"{field} must be HH:MM, got {value!r}") from exc
    if not (0 <= hh <= 23 and 0 <= mm <= 59):
        raise ValueError(f"{field} out of range: {value!r}")
    return f"{hh:02d}:{mm:02d}"


def _row_to_profile(row: tuple[Any, ...]) -> WaterProfile:
    return WaterProfile(
        weight_kg=float(row[0]),
        height_cm=float(row[1]) if row[1] is not None else None,
        activity_level=str(row[2]),
        daily_goal_ml=int(row[3]),
        reminder_enabled=bool(row[4]),
        reminder_start=str(row[5]),
        reminder_end=str(row[6]),
        reminder_interval_hours=int(row[7]),
        updated_at=str(row[8]),
    )


def _row_to_log(row: tuple[Any, ...]) -> WaterLog:
    return WaterLog(
        id=int(row[0]),
        amount_ml=int(row[1]),
        date=str(row[2]),
        logged_at=str(row[3]),
    )


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------

class WaterService:
    def __init__(self, store: Store) -> None:
        self._store = store

    # ------------------------------------------------------------------
    # Goal math
    # ------------------------------------------------------------------

    @staticmethod
    def compute_goal(weight_kg: float, activity_level: str) -> int:
        """Return the daily water goal (ml), clamped to [1500, 5000]."""
        if activity_level not in _VALID_ACTIVITY:
            raise ValueError(
                f"invalid activity_level: {activity_level!r} (must be one of "
                f"{', '.join(_VALID_ACTIVITY)})"
            )
        if weight_kg <= 0:
            raise ValueError(f"weight_kg must be > 0, got {weight_kg!r}")
        ml_per_kg = _ACTIVITY_ML_PER_KG[activity_level]
        raw = float(weight_kg) * ml_per_kg
        goal = int(round(raw))
        if goal < _GOAL_MIN_ML:
            return _GOAL_MIN_ML
        if goal > _GOAL_MAX_ML:
            return _GOAL_MAX_ML
        return goal

    # ------------------------------------------------------------------
    # Profile CRUD
    # ------------------------------------------------------------------

    async def set_profile(
        self,
        *,
        weight_kg: float,
        activity_level: str,
        height_cm: float | None = None,
        reminder_enabled: bool | None = None,
        reminder_start: str | None = None,
        reminder_end: str | None = None,
        reminder_interval_hours: int | None = None,
    ) -> WaterProfile:
        goal = self.compute_goal(weight_kg, activity_level)

        if height_cm is not None and float(height_cm) <= 0:
            raise ValueError("height_cm must be > 0 when provided")

        # Load current (if any) to preserve defaults for unset fields
        current = await self.get_profile()
        cur_enabled = current.reminder_enabled if current else True
        cur_start = current.reminder_start if current else "08:00"
        cur_end = current.reminder_end if current else "22:00"
        cur_interval = current.reminder_interval_hours if current else 2

        enabled = bool(reminder_enabled) if reminder_enabled is not None else cur_enabled
        start_s = (
            _validate_hhmm(reminder_start, "reminder_start")
            if reminder_start is not None
            else cur_start
        )
        end_s = (
            _validate_hhmm(reminder_end, "reminder_end")
            if reminder_end is not None
            else cur_end
        )
        if reminder_interval_hours is not None:
            iv = int(reminder_interval_hours)
            if iv < 1 or iv > 12:
                raise ValueError(
                    f"reminder_interval_hours must be 1..12, got {iv}"
                )
            interval = iv
        else:
            interval = cur_interval

        ts = _now_iso()

        def _work() -> WaterProfile:
            with self._store._connect() as conn:
                conn.execute(
                    "INSERT OR REPLACE INTO water_profile"
                    " (id, weight_kg, height_cm, activity_level,"
                    "  daily_goal_ml, reminder_enabled, reminder_start,"
                    "  reminder_end, reminder_interval_hours, updated_at,"
                    "  last_reminder_fired_at)"
                    " VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?,"
                    "   (SELECT last_reminder_fired_at FROM water_profile"
                    "    WHERE id = 1))",
                    (
                        float(weight_kg),
                        float(height_cm) if height_cm is not None else None,
                        activity_level,
                        goal,
                        1 if enabled else 0,
                        start_s,
                        end_s,
                        interval,
                        ts,
                    ),
                )
                row = conn.execute(
                    f"SELECT {_PROFILE_COLS} FROM water_profile WHERE id = 1"
                ).fetchone()
            return _row_to_profile(row)

        return await asyncio.to_thread(_work)

    async def get_profile(self) -> WaterProfile | None:
        def _work() -> WaterProfile | None:
            with self._store._connect() as conn:
                row = conn.execute(
                    f"SELECT {_PROFILE_COLS} FROM water_profile WHERE id = 1"
                ).fetchone()
            return _row_to_profile(row) if row else None

        return await asyncio.to_thread(_work)

    # ------------------------------------------------------------------
    # Intake logs
    # ------------------------------------------------------------------

    async def add_intake(self, amount_ml: int) -> dict[str, Any]:
        amt = int(amount_ml)
        if amt <= 0:
            raise ValueError(f"amount_ml must be > 0, got {amount_ml!r}")
        if amt > 5000:
            raise ValueError(
                f"amount_ml too large (> 5000 per entry): {amount_ml!r}"
            )

        profile = await self.get_profile()
        if profile is None:
            raise LookupError("water profile not configured")

        today_iso = _today_sp().isoformat()
        ts = _now_iso()

        def _work() -> tuple[WaterLog, int]:
            with self._store._connect() as conn:
                cur = conn.execute(
                    "INSERT INTO water_logs (amount_ml, date, logged_at)"
                    " VALUES (?, ?, ?)",
                    (amt, today_iso, ts),
                )
                log_id = int(cur.lastrowid or 0)
                row = conn.execute(
                    "SELECT id, amount_ml, date, logged_at FROM water_logs"
                    " WHERE id = ?",
                    (log_id,),
                ).fetchone()
                total_row = conn.execute(
                    "SELECT COALESCE(SUM(amount_ml), 0) FROM water_logs"
                    " WHERE date = ?",
                    (today_iso,),
                ).fetchone()
            return _row_to_log(row), int(total_row[0] or 0)

        log, total_today = await asyncio.to_thread(_work)
        goal = int(profile.daily_goal_ml)
        percent = int(round((total_today / goal) * 100)) if goal > 0 else 0
        return {
            "total_today": total_today,
            "goal": goal,
            "percent": percent,
            "log": log.to_dict(),
        }

    async def get_today(self) -> dict[str, Any]:
        profile = await self.get_profile()
        today_iso = _today_sp().isoformat()

        def _work() -> tuple[int, list[WaterLog]]:
            with self._store._connect() as conn:
                total_row = conn.execute(
                    "SELECT COALESCE(SUM(amount_ml), 0) FROM water_logs"
                    " WHERE date = ?",
                    (today_iso,),
                ).fetchone()
                rows = conn.execute(
                    "SELECT id, amount_ml, date, logged_at FROM water_logs"
                    " WHERE date = ?"
                    " ORDER BY logged_at DESC",
                    (today_iso,),
                ).fetchall()
            return int(total_row[0] or 0), [_row_to_log(r) for r in rows]

        total, logs = await asyncio.to_thread(_work)
        goal = int(profile.daily_goal_ml) if profile else 0
        percent = int(round((total / goal) * 100)) if goal > 0 else 0
        return {
            "total": total,
            "goal": goal,
            "percent": percent,
            "logs": [log.to_dict() for log in logs],
        }

    async def get_history(self, days: int = 7) -> list[dict[str, Any]]:
        try:
            n = int(days)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"days must be an integer, got {days!r}") from exc
        if n <= 0 or n > 365:
            raise ValueError("days must be 1..365")

        today = _today_sp()
        start = today - timedelta(days=n - 1)
        profile = await self.get_profile()
        goal = int(profile.daily_goal_ml) if profile else 0

        def _work() -> dict[str, int]:
            with self._store._connect() as conn:
                rows = conn.execute(
                    "SELECT date, COALESCE(SUM(amount_ml), 0)"
                    " FROM water_logs"
                    " WHERE date BETWEEN ? AND ?"
                    " GROUP BY date",
                    (start.isoformat(), today.isoformat()),
                ).fetchall()
            return {str(r[0]): int(r[1] or 0) for r in rows}

        totals = await asyncio.to_thread(_work)
        out: list[dict[str, Any]] = []
        d = start
        while d <= today:
            iso = d.isoformat()
            out.append({"date": iso, "total": totals.get(iso, 0), "goal": goal})
            d = d + timedelta(days=1)
        return out

    async def delete_log(self, log_id: int) -> bool:
        def _work() -> int:
            with self._store._connect() as conn:
                cur = conn.execute(
                    "DELETE FROM water_logs WHERE id = ?",
                    (int(log_id),),
                )
                return cur.rowcount or 0

        affected = await asyncio.to_thread(_work)
        return affected > 0

    # ------------------------------------------------------------------
    # Reminder bookkeeping
    # ------------------------------------------------------------------

    async def last_intake_at(self) -> datetime | None:
        """Return the most recent intake timestamp (UTC), or None."""

        def _work() -> str | None:
            with self._store._connect() as conn:
                row = conn.execute(
                    "SELECT logged_at FROM water_logs"
                    " ORDER BY logged_at DESC LIMIT 1"
                ).fetchone()
            return str(row[0]) if row else None

        ts = await asyncio.to_thread(_work)
        if not ts:
            return None
        try:
            return datetime.fromisoformat(ts)
        except ValueError:
            return None

    async def get_last_reminder_fired_at(self) -> datetime | None:
        def _work() -> str | None:
            with self._store._connect() as conn:
                row = conn.execute(
                    "SELECT last_reminder_fired_at FROM water_profile"
                    " WHERE id = 1"
                ).fetchone()
            return str(row[0]) if (row and row[0]) else None

        ts = await asyncio.to_thread(_work)
        if not ts:
            return None
        try:
            return datetime.fromisoformat(ts)
        except ValueError:
            return None

    async def mark_reminder_fired(self, when: datetime) -> None:
        iso = when.isoformat()

        def _work() -> None:
            with self._store._connect() as conn:
                conn.execute(
                    "UPDATE water_profile SET last_reminder_fired_at = ?"
                    " WHERE id = 1",
                    (iso,),
                )

        await asyncio.to_thread(_work)
