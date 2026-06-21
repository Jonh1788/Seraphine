"""FocusService -- persist and query focus sessions and app logs.

Single-tenant: no user_id scoping. Days are bucketed in America/Sao_Paulo time.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from core_db import Store

from seraphine.focus.types import (
    FocusAppLog,
    FocusCategoryStat,
    FocusDayStat,
    FocusSession,
    FocusStats,
)

logger = logging.getLogger(__name__)

_SP_TZ = ZoneInfo("America/Sao_Paulo")

_VALID_TYPES = ("work", "short_break", "long_break")

_SESSION_COLS = (
    "id, started_at, ended_at, duration_sec, type,"
    " completed, interruptions, notes, category"
)

_DEFAULT_CATEGORY = "Foco"

_APP_LOG_COLS = "id, session_id, app_name, started_at, duration_sec"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _today_sp() -> date:
    return datetime.now(_SP_TZ).date()


def _row_to_session(row: tuple[Any, ...]) -> FocusSession:
    return FocusSession(
        id=str(row[0]),
        started_at=str(row[1]),
        ended_at=str(row[2]),
        duration_sec=int(row[3]),
        type=str(row[4]),
        completed=bool(row[5]),
        interruptions=int(row[6]),
        notes=str(row[7]) if row[7] is not None else None,
        category=str(row[8]) if len(row) > 8 and row[8] else _DEFAULT_CATEGORY,
    )


def _row_to_app_log(row: tuple[Any, ...]) -> FocusAppLog:
    return FocusAppLog(
        id=str(row[0]),
        session_id=str(row[1]),
        app_name=str(row[2]),
        started_at=str(row[3]),
        duration_sec=int(row[4]),
    )


class FocusService:
    def __init__(self, store: Store) -> None:
        self._store = store
        self._active: bool = False

    # ------------------------------------------------------------------
    # Real-time active flag (in-memory, no DB)
    # ------------------------------------------------------------------

    def set_active(self, active: bool) -> None:
        """Set whether a focus session is currently running on the client."""
        self._active = active

    def is_active(self) -> bool:
        """Return True if the client reported an active focus session."""
        return self._active

    # ------------------------------------------------------------------
    # Write
    # ------------------------------------------------------------------

    async def log_session(
        self,
        *,
        started_at: str,
        ended_at: str,
        type: str,
        completed: bool,
        interruptions: int = 0,
        notes: str | None = None,
        category: str | None = None,
    ) -> FocusSession:
        """Persist a finished focus session."""
        if type not in _VALID_TYPES:
            raise ValueError(
                f"invalid type: {type!r} (must be one of "
                f"{', '.join(_VALID_TYPES)})"
            )

        # Parse timestamps to compute duration
        try:
            t_start = datetime.fromisoformat(started_at)
            t_end = datetime.fromisoformat(ended_at)
        except ValueError as exc:
            raise ValueError(f"invalid timestamp: {exc}") from exc

        duration_sec = max(0, int((t_end - t_start).total_seconds()))
        sid = str(uuid.uuid4())
        clean_notes = (notes or "").strip() or None
        clean_category = (category or "").strip() or _DEFAULT_CATEGORY

        def _work() -> FocusSession:
            with self._store._connect() as conn:
                conn.execute(
                    f"INSERT INTO focus_sessions ({_SESSION_COLS})"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        sid,
                        started_at,
                        ended_at,
                        duration_sec,
                        type,
                        1 if completed else 0,
                        interruptions,
                        clean_notes,
                        clean_category,
                    ),
                )
                row = conn.execute(
                    f"SELECT {_SESSION_COLS} FROM focus_sessions WHERE id = ?",
                    (sid,),
                ).fetchone()
            return _row_to_session(row)

        return await asyncio.to_thread(_work)

    async def log_app(
        self,
        *,
        session_id: str,
        app_name: str,
        started_at: str,
        duration_sec: int,
    ) -> FocusAppLog:
        """Log app usage during a focus session."""
        if not app_name or not app_name.strip():
            raise ValueError("app_name is required")
        if duration_sec < 0:
            raise ValueError(f"duration_sec must be >= 0, got {duration_sec}")

        aid = str(uuid.uuid4())

        def _work() -> FocusAppLog:
            with self._store._connect() as conn:
                # Verify session exists
                exists = conn.execute(
                    "SELECT 1 FROM focus_sessions WHERE id = ?",
                    (session_id,),
                ).fetchone()
                if not exists:
                    raise LookupError(f"session {session_id!r} not found")
                conn.execute(
                    f"INSERT INTO focus_app_logs ({_APP_LOG_COLS})"
                    " VALUES (?, ?, ?, ?, ?)",
                    (aid, session_id, app_name.strip(), started_at, duration_sec),
                )
                row = conn.execute(
                    f"SELECT {_APP_LOG_COLS} FROM focus_app_logs WHERE id = ?",
                    (aid,),
                ).fetchone()
            return _row_to_app_log(row)

        return await asyncio.to_thread(_work)

    # ------------------------------------------------------------------
    # Queries
    # ------------------------------------------------------------------

    async def get_sessions(
        self,
        start: str,
        end: str,
    ) -> list[FocusSession]:
        """List sessions whose started_at falls within [start, end]."""

        def _work() -> list[FocusSession]:
            with self._store._connect() as conn:
                rows = conn.execute(
                    f"SELECT {_SESSION_COLS} FROM focus_sessions"
                    " WHERE started_at BETWEEN ? AND ?"
                    " ORDER BY started_at DESC",
                    (start, end),
                ).fetchall()
            return [_row_to_session(r) for r in rows]

        return await asyncio.to_thread(_work)

    async def get_stats(self, period: str = "week") -> FocusStats:
        """Compute focus statistics for the given period ('week' or 'month')."""
        today = _today_sp()
        if period == "month":
            start_date = today.replace(day=1)
        else:
            # Default: last 7 days (including today)
            start_date = today - timedelta(days=6)

        # Convert to UTC range for querying
        start_utc = datetime(
            start_date.year, start_date.month, start_date.day,
            tzinfo=_SP_TZ,
        ).astimezone(timezone.utc).isoformat()
        end_utc = datetime(
            today.year, today.month, today.day,
            hour=23, minute=59, second=59,
            tzinfo=_SP_TZ,
        ).astimezone(timezone.utc).isoformat()

        def _work() -> list[FocusSession]:
            with self._store._connect() as conn:
                rows = conn.execute(
                    f"SELECT {_SESSION_COLS} FROM focus_sessions"
                    " WHERE started_at BETWEEN ? AND ?"
                    " ORDER BY started_at ASC",
                    (start_utc, end_utc),
                ).fetchall()
            return [_row_to_session(r) for r in rows]

        sessions = await asyncio.to_thread(_work)

        # Aggregate
        total_focus_sec = 0
        completed_count = 0
        cancelled_count = 0
        total_interruptions = 0

        # Group by SP date
        by_day_map: dict[str, dict[str, int]] = defaultdict(
            lambda: {"focus_sec": 0, "completed": 0, "cancelled": 0, "interruptions": 0}
        )
        # Group focus minutes by category ("onde foi seu tempo").
        by_cat_map: dict[str, dict[str, int]] = defaultdict(
            lambda: {"focus_sec": 0, "sessions": 0}
        )
        completed_dates: set[str] = set()

        for s in sessions:
            # Only count 'work' sessions for focus minutes
            if s.type == "work":
                total_focus_sec += s.duration_sec
                cat = (s.category or _DEFAULT_CATEGORY).strip() or _DEFAULT_CATEGORY
                by_cat_map[cat]["focus_sec"] += s.duration_sec
                by_cat_map[cat]["sessions"] += 1
            if s.completed:
                completed_count += 1
            else:
                cancelled_count += 1
            total_interruptions += s.interruptions

            # Bucket by SP date
            try:
                ts = datetime.fromisoformat(s.started_at)
                sp_date = ts.astimezone(_SP_TZ).date().isoformat()
            except (ValueError, TypeError):
                sp_date = start_date.isoformat()

            day = by_day_map[sp_date]
            if s.type == "work":
                day["focus_sec"] += s.duration_sec
            if s.completed:
                day["completed"] += 1
                if s.type == "work":
                    completed_dates.add(sp_date)
            else:
                day["cancelled"] += 1
            day["interruptions"] += s.interruptions

        total_sessions = completed_count + cancelled_count
        total_focus_min = total_focus_sec // 60
        avg_session_min = (
            (total_focus_sec / total_sessions / 60) if total_sessions > 0 else 0.0
        )
        interruption_rate = (
            total_interruptions / total_sessions if total_sessions > 0 else 0.0
        )

        # Streak: consecutive days with >= 1 completed work session
        streak_days = await self._compute_streak()

        # Build by_day list
        by_day: list[FocusDayStat] = []
        d = start_date
        while d <= today:
            iso = d.isoformat()
            day = by_day_map.get(iso)
            if day:
                by_day.append(FocusDayStat(
                    date=iso,
                    focus_min=day["focus_sec"] // 60,
                    completed=day["completed"],
                    cancelled=day["cancelled"],
                    interruptions=day["interruptions"],
                ))
            else:
                by_day.append(FocusDayStat(
                    date=iso,
                    focus_min=0,
                    completed=0,
                    cancelled=0,
                    interruptions=0,
                ))
            d += timedelta(days=1)

        # Build by_category list (descending by focus minutes).
        by_category: list[FocusCategoryStat] = [
            FocusCategoryStat(
                category=cat,
                focus_min=vals["focus_sec"] // 60,
                sessions=vals["sessions"],
            )
            for cat, vals in by_cat_map.items()
        ]
        by_category.sort(key=lambda c: (-c.focus_min, c.category))

        return FocusStats(
            total_focus_min=total_focus_min,
            completed_sessions=completed_count,
            cancelled_sessions=cancelled_count,
            avg_session_min=avg_session_min,
            streak_days=streak_days,
            interruption_rate=interruption_rate,
            by_day=by_day,
            by_category=by_category,
        )

    async def _compute_streak(self) -> int:
        """Count consecutive days (ending at today) with >= 1 completed work session."""
        today = _today_sp()

        def _work() -> set[str]:
            with self._store._connect() as conn:
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
            return dates

        completed_dates = await asyncio.to_thread(_work)
        if not completed_dates:
            return 0

        streak = 0
        d = today
        # If today doesn't have a completed session, start from yesterday
        if d.isoformat() not in completed_dates:
            d = d - timedelta(days=1)

        while d.isoformat() in completed_dates:
            streak += 1
            d = d - timedelta(days=1)

        return streak

    async def get_top_apps(
        self,
        start: str,
        end: str,
        limit: int = 10,
    ) -> list[dict[str, Any]]:
        """Aggregate app usage time during focus sessions in the given range."""
        if limit < 1:
            limit = 10

        def _work() -> list[dict[str, Any]]:
            with self._store._connect() as conn:
                rows = conn.execute(
                    "SELECT a.app_name,"
                    "   SUM(a.duration_sec) AS total_sec,"
                    "   COUNT(*) AS count"
                    " FROM focus_app_logs a"
                    " JOIN focus_sessions s ON s.id = a.session_id"
                    " WHERE s.started_at BETWEEN ? AND ?"
                    " GROUP BY a.app_name"
                    " ORDER BY total_sec DESC"
                    " LIMIT ?",
                    (start, end, limit),
                ).fetchall()
            return [
                {
                    "app_name": str(r[0]),
                    "total_sec": int(r[1]),
                    "total_min": int(r[1]) // 60,
                    "count": int(r[2]),
                }
                for r in rows
            ]

        return await asyncio.to_thread(_work)
