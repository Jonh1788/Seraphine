"""HabitsService — CRUD habits + daily completion log + heatmap reads.

The toggle endpoint is idempotent on (habit_id, date): hitting it twice
in the same day returns the row to "not done" instead of stacking. This
matches user intent (tap to mark, tap to undo) without needing a
separate delete.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any

from core_db import Store

from aura.habits.models import Habit, HabitLogEntry


_HABIT_COLS = (
    "id, user_id, name, color, target_per_week, archived, created_at"
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row_to_habit(row: tuple[Any, ...]) -> Habit:
    return Habit(
        id=row[0],
        user_id=row[1],
        name=row[2],
        color=row[3],
        target_per_week=int(row[4]),
        archived=bool(row[5]),
        created_at=row[6],
    )


def _start_of_week(d: date) -> date:
    """Monday-based week start (matches Python's weekday())."""
    return d - timedelta(days=d.weekday())


class HabitsService:
    def __init__(self, store: Store) -> None:
        self._store = store

    async def aclose(self) -> None:  # pragma: no cover
        pass

    # ------------------------------------------------------------------
    # CRUD
    # ------------------------------------------------------------------

    async def create(
        self,
        *,
        user_id: str,
        name: str,
        color: str = "emerald",
        target_per_week: int = 7,
    ) -> Habit:
        habit = Habit(
            id=str(uuid.uuid4()),
            user_id=user_id,
            name=name.strip(),
            color=color,
            target_per_week=max(1, min(7, target_per_week)),
            archived=False,
            created_at=_now_iso(),
        )

        def _work() -> None:
            with self._store._connect() as conn:
                conn.execute(
                    f"INSERT INTO habits ({_HABIT_COLS})"
                    " VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (
                        habit.id, habit.user_id, habit.name, habit.color,
                        habit.target_per_week, int(habit.archived),
                        habit.created_at,
                    ),
                )

        await asyncio.to_thread(_work)
        return habit

    async def list_for_user(
        self, user_id: str, *, include_archived: bool = False,
    ) -> list[Habit]:
        def _work() -> list[Habit]:
            with self._store._connect() as conn:
                if include_archived:
                    rows = conn.execute(
                        f"SELECT {_HABIT_COLS} FROM habits"
                        " WHERE user_id = ? ORDER BY created_at",
                        (user_id,),
                    ).fetchall()
                else:
                    rows = conn.execute(
                        f"SELECT {_HABIT_COLS} FROM habits"
                        " WHERE user_id = ? AND archived = 0"
                        " ORDER BY created_at",
                        (user_id,),
                    ).fetchall()
            return [_row_to_habit(r) for r in rows]

        return await asyncio.to_thread(_work)

    async def update(
        self,
        habit_id: str,
        user_id: str,
        *,
        name: str | None = None,
        color: str | None = None,
        target_per_week: int | None = None,
        archived: bool | None = None,
    ) -> Habit | None:
        sets: list[str] = []
        params: list[object] = []
        if name is not None:
            sets.append("name = ?")
            params.append(name.strip())
        if color is not None:
            sets.append("color = ?")
            params.append(color)
        if target_per_week is not None:
            sets.append("target_per_week = ?")
            params.append(max(1, min(7, target_per_week)))
        if archived is not None:
            sets.append("archived = ?")
            params.append(int(archived))
        if not sets:
            return await self.get(habit_id, user_id)

        def _work() -> Habit | None:
            with self._store._connect() as conn:
                cur = conn.execute(
                    f"UPDATE habits SET {', '.join(sets)}"
                    " WHERE id = ? AND user_id = ?",
                    (*params, habit_id, user_id),
                )
                if cur.rowcount == 0:
                    return None
                row = conn.execute(
                    f"SELECT {_HABIT_COLS} FROM habits WHERE id = ?",
                    (habit_id,),
                ).fetchone()
            return _row_to_habit(row) if row else None

        return await asyncio.to_thread(_work)

    async def get(self, habit_id: str, user_id: str) -> Habit | None:
        def _work() -> Habit | None:
            with self._store._connect() as conn:
                row = conn.execute(
                    f"SELECT {_HABIT_COLS} FROM habits"
                    " WHERE id = ? AND user_id = ?",
                    (habit_id, user_id),
                ).fetchone()
            return _row_to_habit(row) if row else None

        return await asyncio.to_thread(_work)

    async def delete(self, habit_id: str, user_id: str) -> int:
        def _work() -> int:
            with self._store._connect() as conn:
                cur = conn.execute(
                    "DELETE FROM habits WHERE id = ? AND user_id = ?",
                    (habit_id, user_id),
                )
            return cur.rowcount

        return await asyncio.to_thread(_work)

    # ------------------------------------------------------------------
    # Logging
    # ------------------------------------------------------------------

    async def toggle_log(
        self,
        habit_id: str,
        user_id: str,
        *,
        on_date: date | None = None,
    ) -> bool:
        """Toggle done/undone for (habit, date). Returns the new state."""
        target = (on_date or date.today()).isoformat()
        ts = _now_iso()

        def _work() -> bool:
            with self._store._connect() as conn:
                # Confirm the habit belongs to this user.
                exists = conn.execute(
                    "SELECT 1 FROM habits WHERE id = ? AND user_id = ?",
                    (habit_id, user_id),
                ).fetchone()
                if not exists:
                    return False
                row = conn.execute(
                    "SELECT done FROM habit_logs"
                    " WHERE habit_id = ? AND date = ?",
                    (habit_id, target),
                ).fetchone()
                if row is None:
                    conn.execute(
                        "INSERT INTO habit_logs"
                        " (habit_id, user_id, date, done, created_at)"
                        " VALUES (?, ?, ?, 1, ?)",
                        (habit_id, user_id, target, ts),
                    )
                    return True
                # Toggle: remove the row instead of flipping. Less state.
                conn.execute(
                    "DELETE FROM habit_logs"
                    " WHERE habit_id = ? AND date = ?",
                    (habit_id, target),
                )
                return False

        return await asyncio.to_thread(_work)

    async def list_logs(
        self,
        user_id: str,
        *,
        from_date: date,
        to_date: date,
    ) -> list[HabitLogEntry]:
        def _work() -> list[HabitLogEntry]:
            with self._store._connect() as conn:
                rows = conn.execute(
                    "SELECT habit_id, date, done FROM habit_logs"
                    " WHERE user_id = ? AND date >= ? AND date <= ?",
                    (user_id, from_date.isoformat(), to_date.isoformat()),
                ).fetchall()
            return [
                HabitLogEntry(habit_id=r[0], date=r[1], done=bool(r[2]))
                for r in rows
            ]

        return await asyncio.to_thread(_work)

    # ------------------------------------------------------------------
    # Aggregations for the page hero
    # ------------------------------------------------------------------

    async def today_overview(self, user_id: str) -> dict:
        """Returns habits + per-habit done_today/streak/week count + ring values.
        Single SQL trip per habit is fine — list is small (<50)."""
        habits = await self.list_for_user(user_id)
        today = date.today()
        week_start = _start_of_week(today)
        # Heatmap window: 26 weeks back, anchored at today.
        heatmap_from = today - timedelta(days=7 * 26 - (today.weekday() + 1))

        logs = await self.list_logs(
            user_id, from_date=heatmap_from, to_date=today,
        )
        by_date: dict[str, set[str]] = {}
        for log in logs:
            if log.done:
                by_date.setdefault(log.date, set()).add(log.habit_id)

        for h in habits:
            h.done_today = h.id in by_date.get(today.isoformat(), set())
            week_count = 0
            for offset in range(7):
                d = (week_start + timedelta(days=offset)).isoformat()
                if h.id in by_date.get(d, set()):
                    week_count += 1
            h.week_done_count = week_count
            # Streak: walk back from today while every day has the habit.
            streak = 0
            cursor = today
            while True:
                key = cursor.isoformat()
                if h.id in by_date.get(key, set()):
                    streak += 1
                    cursor -= timedelta(days=1)
                    if cursor < heatmap_from:
                        break
                else:
                    break
            h.streak = streak

        target = sum(h.target_per_week for h in habits) or 1
        done = sum(h.week_done_count for h in habits)
        ring = {
            "done": done,
            "target": target,
            "ratio": min(1.0, done / target) if target else 0.0,
        }

        # Heatmap: per-day total count of habits done.
        heatmap = {d: len(s) for d, s in by_date.items()}

        return {
            "habits": habits,
            "ring": ring,
            "heatmap": heatmap,
            "heatmap_from": heatmap_from.isoformat(),
            "heatmap_to": today.isoformat(),
        }
