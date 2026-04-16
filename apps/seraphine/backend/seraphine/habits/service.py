"""HabitService -- CRUD + toggle + streak calculations for habits.

Single-tenant: no user_id scoping. Streak math treats weekdays/custom habits
correctly -- skipped non-target days do not break the streak.
"""

from __future__ import annotations

import asyncio
import calendar as _calendar
import json
import logging
import re
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable, Iterable
from zoneinfo import ZoneInfo

from core_db import Store

from seraphine.habits.models import Habit, HabitLog

logger = logging.getLogger(__name__)


_SP_TZ = ZoneInfo("America/Sao_Paulo")

_VALID_FREQUENCIES = ("daily", "weekdays", "custom")
_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
_ALLOWED_ICONS: tuple[str, ...] = (
    "check", "droplet", "run", "book", "brain", "heart",
    "dumbbell", "moon", "sun", "flame",
)

_HABIT_COLS = (
    "id, title, icon, color, frequency, target_days,"
    " description, active, created_at"
)

_HABIT_COLS_H = (
    "h.id, h.title, h.icon, h.color, h.frequency, h.target_days,"
    " h.description, h.active, h.created_at"
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _today_sp() -> date:
    return datetime.now(_SP_TZ).date()


def _parse_target_days(raw: str | None) -> list[int] | None:
    if raw is None or raw == "":
        return None
    try:
        val = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None
    if isinstance(val, list):
        out: list[int] = []
        for x in val:
            try:
                out.append(int(x))
            except (TypeError, ValueError):
                continue
        return out or None
    return None


def _serialize_target_days(days: Iterable[int] | None) -> str | None:
    if not days:
        return None
    return json.dumps(sorted({int(d) for d in days}))


def _row_to_habit(row: tuple[Any, ...]) -> Habit:
    return Habit(
        id=row[0],
        title=row[1],
        icon=row[2] or "check",
        color=row[3] or "#22d3ee",
        frequency=row[4],
        target_days=_parse_target_days(row[5]),
        description=row[6],
        active=bool(row[7]),
        created_at=row[8],
    )


def _row_to_log(row: tuple[Any, ...]) -> HabitLog:
    return HabitLog(
        id=row[0],
        habit_id=row[1],
        date=row[2],
        completed=bool(row[3]),
        created_at=row[4],
    )


# ---------------------------------------------------------------------------
# Pure helpers (no DB)
# ---------------------------------------------------------------------------

def _is_target_day(
    frequency: str,
    target_days: list[int] | None,
    d: date,
) -> bool:
    """Return True if ``d`` is a day on which the habit should be performed."""
    if frequency == "daily":
        return True
    if frequency == "weekdays":
        return d.weekday() < 5  # Mon(0)..Fri(4)
    if frequency == "custom":
        if not target_days:
            return False
        return d.weekday() in target_days
    return False


def _compute_streak(
    completed_dates: set[str],
    is_target_day: Callable[[date], bool],
    today: date,
) -> tuple[int, int, int]:
    """Given the set of completed (YYYY-MM-DD) dates for a habit and a
    target-day predicate, compute (current_streak, best_streak, total_completed).

    Rules:
    - Only target days "count" toward streaks -- non-target days are skipped
      neutrally and do not break the streak.
    - The current streak walks backward from today and stops at the first
      target day that is not in completed_dates. If today itself is a target
      day and not yet completed, the streak is still the run ending at the
      most recent completed target day before today (i.e., today missing
      doesn't retroactively erase yesterday's progress).
    - The best streak is the maximum run of consecutive completed target
      days anywhere in history.
    """
    total = len(completed_dates)
    if total == 0:
        return 0, 0, 0

    # --- best streak: sort target days chronologically up to today, walk ---
    parsed: list[date] = []
    for s in completed_dates:
        try:
            parsed.append(date.fromisoformat(s))
        except ValueError:
            continue
    if not parsed:
        return 0, 0, total
    parsed.sort()

    earliest = parsed[0]
    best = 0
    run = 0
    d = earliest
    while d <= today:
        if is_target_day(d):
            if d.isoformat() in completed_dates:
                run += 1
                if run > best:
                    best = run
            else:
                run = 0
        # non-target days are skipped (run unchanged)
        d = d + timedelta(days=1)

    # --- current streak: walk backward from today through target days ---
    current = 0
    d = today
    # If today is a target day and not completed, the "current streak"
    # is the run ending at the most recent completed target day before
    # today (we step past today if not completed, but only for today).
    today_is_target = is_target_day(today)
    today_done = today.isoformat() in completed_dates
    if today_is_target and not today_done:
        d = d - timedelta(days=1)

    while True:
        if d < earliest - timedelta(days=365 * 5):
            break  # safety
        if is_target_day(d):
            if d.isoformat() in completed_dates:
                current += 1
            else:
                break
        d = d - timedelta(days=1)

    return current, best, total


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------

class HabitService:
    def __init__(self, store: Store) -> None:
        self._store = store

    # ------------------------------------------------------------------
    # Validation
    # ------------------------------------------------------------------

    @staticmethod
    def _validate_frequency(frequency: str, target_days: list[int] | None) -> None:
        if frequency not in _VALID_FREQUENCIES:
            raise ValueError(
                f"invalid frequency: {frequency!r} (must be one of "
                f"{', '.join(_VALID_FREQUENCIES)})"
            )
        if frequency == "custom":
            if not target_days:
                raise ValueError(
                    "target_days is required for frequency=custom"
                )
            for d in target_days:
                if not (0 <= int(d) <= 6):
                    raise ValueError(
                        f"target_days values must be 0..6, got {d}"
                    )

    @staticmethod
    def _validate_color(color: str) -> None:
        if not _COLOR_RE.match(color):
            raise ValueError(
                f"invalid color: {color!r} (expected #RRGGBB)"
            )

    @staticmethod
    def _validate_icon(icon: str) -> None:
        if icon not in _ALLOWED_ICONS:
            raise ValueError(
                f"invalid icon: {icon!r} (allowed: "
                f"{', '.join(_ALLOWED_ICONS)})"
            )

    # ------------------------------------------------------------------
    # CRUD
    # ------------------------------------------------------------------

    async def create(
        self,
        *,
        title: str,
        frequency: str,
        icon: str = "check",
        color: str = "#22d3ee",
        target_days: list[int] | None = None,
        description: str | None = None,
    ) -> Habit:
        title = (title or "").strip()
        if not title:
            raise ValueError("title is required")

        self._validate_frequency(frequency, target_days)
        self._validate_color(color)
        self._validate_icon(icon)

        hid = str(uuid.uuid4())
        ts = _now_iso()
        td_json = _serialize_target_days(target_days)
        desc = (description or "").strip() or None

        def _work() -> Habit:
            with self._store._connect() as conn:
                conn.execute(
                    "INSERT INTO habits"
                    " (id, title, icon, color, frequency, target_days,"
                    "  description, active, created_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)",
                    (hid, title, icon, color, frequency, td_json, desc, ts),
                )
                row = conn.execute(
                    f"SELECT {_HABIT_COLS} FROM habits WHERE id = ?",
                    (hid,),
                ).fetchone()
            return _row_to_habit(row)

        return await asyncio.to_thread(_work)

    async def list_active(self) -> list[Habit]:
        def _work() -> list[Habit]:
            with self._store._connect() as conn:
                rows = conn.execute(
                    f"SELECT {_HABIT_COLS} FROM habits"
                    " WHERE active = 1"
                    " ORDER BY created_at ASC",
                ).fetchall()
            return [_row_to_habit(r) for r in rows]

        return await asyncio.to_thread(_work)

    async def list_with_today_status(self) -> list[dict[str, Any]]:
        """Return active habits enriched with today_completed + current_streak."""
        today_iso = _today_sp().isoformat()

        def _work() -> list[tuple[Habit, bool, set[str]]]:
            with self._store._connect() as conn:
                rows = conn.execute(
                    f"SELECT {_HABIT_COLS_H},"
                    "   (SELECT completed FROM habit_logs l"
                    "    WHERE l.habit_id = h.id AND l.date = ?) AS today_done"
                    " FROM habits h"
                    " WHERE h.active = 1"
                    " ORDER BY h.created_at ASC",
                    (today_iso,),
                ).fetchall()
                out: list[tuple[Habit, bool, set[str]]] = []
                for r in rows:
                    habit = _row_to_habit(r[:9])
                    today_done = bool(r[9]) if r[9] is not None else False
                    log_rows = conn.execute(
                        "SELECT date FROM habit_logs"
                        " WHERE habit_id = ? AND completed = 1",
                        (habit.id,),
                    ).fetchall()
                    completed_dates = {lr[0] for lr in log_rows}
                    out.append((habit, today_done, completed_dates))
            return out

        records = await asyncio.to_thread(_work)
        today = _today_sp()
        result: list[dict[str, Any]] = []
        for habit, today_done, completed_dates in records:
            pred = (
                lambda d, h=habit: _is_target_day(h.frequency, h.target_days, d)
            )
            current, best, total = _compute_streak(completed_dates, pred, today)
            item = habit.to_dict()
            item["today_completed"] = today_done
            item["current_streak"] = current
            item["best_streak"] = best
            item["total_completed"] = total
            item["is_target_today"] = _is_target_day(
                habit.frequency, habit.target_days, today,
            )
            result.append(item)
        return result

    async def get(self, habit_id: str) -> Habit | None:
        def _work() -> Habit | None:
            with self._store._connect() as conn:
                row = conn.execute(
                    f"SELECT {_HABIT_COLS} FROM habits WHERE id = ?",
                    (habit_id,),
                ).fetchone()
            return _row_to_habit(row) if row else None

        return await asyncio.to_thread(_work)

    async def update(self, habit_id: str, **fields: Any) -> Habit | None:
        """Patch-style update. Recognised fields: title, icon, color,
        frequency, target_days, description, active."""
        sets: list[str] = []
        params: list[Any] = []

        if "title" in fields and fields["title"] is not None:
            title = str(fields["title"]).strip()
            if not title:
                raise ValueError("title cannot be empty")
            sets.append("title = ?")
            params.append(title)

        # frequency + target_days are coupled; validate together when either is
        # present.
        new_freq = fields.get("frequency")
        new_days = fields.get("target_days")
        if new_freq is not None or "target_days" in fields:
            current = await self.get(habit_id)
            if current is None:
                return None
            freq = new_freq if new_freq is not None else current.frequency
            days = new_days if "target_days" in fields else current.target_days
            self._validate_frequency(freq, days)
            if new_freq is not None:
                sets.append("frequency = ?")
                params.append(freq)
            if "target_days" in fields:
                sets.append("target_days = ?")
                params.append(_serialize_target_days(days))

        if "icon" in fields and fields["icon"] is not None:
            self._validate_icon(fields["icon"])
            sets.append("icon = ?")
            params.append(fields["icon"])

        if "color" in fields and fields["color"] is not None:
            self._validate_color(fields["color"])
            sets.append("color = ?")
            params.append(fields["color"])

        if "description" in fields:
            desc = fields["description"]
            if desc is None or str(desc).strip() == "":
                sets.append("description = NULL")
            else:
                sets.append("description = ?")
                params.append(str(desc).strip())

        if "active" in fields and fields["active"] is not None:
            sets.append("active = ?")
            params.append(1 if fields["active"] else 0)

        if not sets:
            return await self.get(habit_id)

        params.append(habit_id)

        def _work() -> Habit | None:
            with self._store._connect() as conn:
                cur = conn.execute(
                    f"UPDATE habits SET {', '.join(sets)} WHERE id = ?",
                    params,
                )
                if (cur.rowcount or 0) == 0:
                    return None
                row = conn.execute(
                    f"SELECT {_HABIT_COLS} FROM habits WHERE id = ?",
                    (habit_id,),
                ).fetchone()
            return _row_to_habit(row) if row else None

        return await asyncio.to_thread(_work)

    async def delete(self, habit_id: str) -> int:
        def _work() -> int:
            with self._store._connect() as conn:
                cur = conn.execute(
                    "DELETE FROM habits WHERE id = ?",
                    (habit_id,),
                )
                return cur.rowcount or 0

        return await asyncio.to_thread(_work)

    # ------------------------------------------------------------------
    # Logs / streaks
    # ------------------------------------------------------------------

    async def toggle(
        self,
        habit_id: str,
        target_date: str | None = None,
    ) -> dict[str, Any] | None:
        """INSERT ON CONFLICT flips the `completed` flag for ``target_date``
        (default: today in America/Sao_Paulo).

        Returns a dict { log, current_streak } or None if the habit does not
        exist.
        """
        habit = await self.get(habit_id)
        if habit is None:
            return None

        d_iso = target_date or _today_sp().isoformat()
        # Validate date string
        try:
            date.fromisoformat(d_iso)
        except ValueError as exc:
            raise ValueError(f"invalid date: {d_iso!r}") from exc

        ts = _now_iso()

        def _work() -> HabitLog:
            with self._store._connect() as conn:
                # Upsert: if a row exists, flip completed; else insert
                # completed=1. Done in two steps to stay portable.
                existing = conn.execute(
                    "SELECT id, completed FROM habit_logs"
                    " WHERE habit_id = ? AND date = ?",
                    (habit_id, d_iso),
                ).fetchone()
                if existing is None:
                    conn.execute(
                        "INSERT INTO habit_logs"
                        " (habit_id, date, completed, created_at)"
                        " VALUES (?, ?, 1, ?)",
                        (habit_id, d_iso, ts),
                    )
                else:
                    new_completed = 0 if bool(existing[1]) else 1
                    conn.execute(
                        "UPDATE habit_logs SET completed = ?, created_at = ?"
                        " WHERE id = ?",
                        (new_completed, ts, existing[0]),
                    )
                row = conn.execute(
                    "SELECT id, habit_id, date, completed, created_at"
                    " FROM habit_logs"
                    " WHERE habit_id = ? AND date = ?",
                    (habit_id, d_iso),
                ).fetchone()
            return _row_to_log(row)

        log = await asyncio.to_thread(_work)
        streaks = await self.get_streaks(habit_id)
        return {
            "log": log.to_dict(),
            "current_streak": streaks["current"],
            "best_streak": streaks["best"],
            "total_completed": streaks["total"],
        }

    async def get_streaks(self, habit_id: str) -> dict[str, int]:
        habit = await self.get(habit_id)
        if habit is None:
            return {"current": 0, "best": 0, "total": 0}

        def _work() -> set[str]:
            with self._store._connect() as conn:
                rows = conn.execute(
                    "SELECT date FROM habit_logs"
                    " WHERE habit_id = ? AND completed = 1",
                    (habit_id,),
                ).fetchall()
            return {r[0] for r in rows}

        completed = await asyncio.to_thread(_work)
        today = _today_sp()
        pred = lambda d: _is_target_day(habit.frequency, habit.target_days, d)
        current, best, total = _compute_streak(completed, pred, today)
        return {"current": current, "best": best, "total": total}

    async def get_calendar(
        self,
        habit_id: str,
        month: int,
        year: int,
    ) -> list[HabitLog]:
        if not (1 <= int(month) <= 12):
            raise ValueError("month must be 1..12")
        last_day = _calendar.monthrange(int(year), int(month))[1]
        start = f"{int(year):04d}-{int(month):02d}-01"
        end = f"{int(year):04d}-{int(month):02d}-{last_day:02d}"

        def _work() -> list[HabitLog]:
            with self._store._connect() as conn:
                rows = conn.execute(
                    "SELECT id, habit_id, date, completed, created_at"
                    " FROM habit_logs"
                    " WHERE habit_id = ? AND date BETWEEN ? AND ?"
                    " ORDER BY date ASC",
                    (habit_id, start, end),
                ).fetchall()
            return [_row_to_log(r) for r in rows]

        return await asyncio.to_thread(_work)

    async def get_today_progress(self) -> dict[str, Any]:
        """Summary used by the dashboard.

        { total: <# of active habits whose target day is today>,
          completed: <# of those completed>,
          best_streak: { title, days } | None }
        """
        items = await self.list_with_today_status()
        total = 0
        completed = 0
        best_item: dict[str, Any] | None = None
        for it in items:
            if it.get("is_target_today"):
                total += 1
                if it.get("today_completed"):
                    completed += 1
            streak = int(it.get("current_streak") or 0)
            if streak > 0 and (best_item is None or streak > best_item["days"]):
                best_item = {"title": it["title"], "days": streak}
        return {
            "total": total,
            "completed": completed,
            "best_streak": best_item,
        }
