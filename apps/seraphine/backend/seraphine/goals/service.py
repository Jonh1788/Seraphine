"""GoalService -- CRUD for goals, key results, links, plus auto-update logic.

Single-tenant: no user_id scoping. Progress is computed as the average of
all key result progress percentages for a given goal.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import date, datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

from core_db import Store

from seraphine.goals.types import Goal, GoalLink, GoalSummary, KeyResult

logger = logging.getLogger(__name__)

_SP_TZ = ZoneInfo("America/Sao_Paulo")

_VALID_AREAS = ("saude", "carreira", "financas", "pessoal", "aprendizado", "relacionamentos")
_VALID_TIMEFRAMES = ("quarterly", "yearly", "open_ended")
_VALID_STATUSES = ("active", "paused", "completed", "abandoned")
_VALID_METRIC_TYPES = ("numeric", "boolean", "percentage")
_VALID_LINKED_TYPES = ("task", "habit", "project")

_GOAL_COLS = (
    "id, title, description, area, timeframe,"
    " start_date, end_date, status, created_at, updated_at"
)

_GOAL_COLS_G = (
    "g.id, g.title, g.description, g.area, g.timeframe,"
    " g.start_date, g.end_date, g.status, g.created_at, g.updated_at"
)

_KR_COLS = (
    "id, goal_id, title, metric_type, target_value,"
    " current_value, unit, auto_source, created_at, updated_at"
)

_LINK_COLS = "id, goal_id, linked_type, linked_id"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _today_sp() -> date:
    return datetime.now(_SP_TZ).date()


def _row_to_goal(row: tuple[Any, ...]) -> Goal:
    return Goal(
        id=row[0],
        title=row[1],
        description=row[2],
        area=row[3],
        timeframe=row[4],
        start_date=row[5],
        end_date=row[6],
        status=row[7],
        created_at=row[8],
        updated_at=row[9],
    )


def _row_to_kr(row: tuple[Any, ...]) -> KeyResult:
    return KeyResult(
        id=row[0],
        goal_id=row[1],
        title=row[2],
        metric_type=row[3],
        target_value=float(row[4]),
        current_value=float(row[5]),
        unit=row[6],
        auto_source=row[7],
        created_at=row[8],
        updated_at=row[9],
    )


def _row_to_link(row: tuple[Any, ...]) -> GoalLink:
    return GoalLink(
        id=row[0],
        goal_id=row[1],
        linked_type=row[2],
        linked_id=row[3],
    )


def _compute_goal_progress(key_results: list[KeyResult]) -> float:
    """Average progress of all key results (0..100)."""
    if not key_results:
        return 0.0
    return sum(kr.progress for kr in key_results) / len(key_results)


class GoalService:
    def __init__(self, store: Store) -> None:
        self._store = store

    # ------------------------------------------------------------------
    # Validation
    # ------------------------------------------------------------------

    @staticmethod
    def _validate_area(area: str) -> None:
        if area not in _VALID_AREAS:
            raise ValueError(
                f"invalid area: {area!r} (must be one of "
                f"{', '.join(_VALID_AREAS)})"
            )

    @staticmethod
    def _validate_timeframe(timeframe: str) -> None:
        if timeframe not in _VALID_TIMEFRAMES:
            raise ValueError(
                f"invalid timeframe: {timeframe!r} (must be one of "
                f"{', '.join(_VALID_TIMEFRAMES)})"
            )

    @staticmethod
    def _validate_metric_type(metric_type: str) -> None:
        if metric_type not in _VALID_METRIC_TYPES:
            raise ValueError(
                f"invalid metric_type: {metric_type!r} (must be one of "
                f"{', '.join(_VALID_METRIC_TYPES)})"
            )

    @staticmethod
    def _validate_linked_type(linked_type: str) -> None:
        if linked_type not in _VALID_LINKED_TYPES:
            raise ValueError(
                f"invalid linked_type: {linked_type!r} (must be one of "
                f"{', '.join(_VALID_LINKED_TYPES)})"
            )

    # ------------------------------------------------------------------
    # Goals CRUD
    # ------------------------------------------------------------------

    async def create_goal(
        self,
        *,
        title: str,
        area: str,
        timeframe: str,
        description: str | None = None,
        start_date: str | None = None,
        end_date: str | None = None,
    ) -> Goal:
        title = (title or "").strip()
        if not title:
            raise ValueError("title is required")

        self._validate_area(area)
        self._validate_timeframe(timeframe)

        gid = str(uuid.uuid4())
        ts = _now_iso()
        desc = (description or "").strip() or None

        def _work() -> Goal:
            with self._store._connect() as conn:
                conn.execute(
                    "INSERT INTO goals"
                    " (id, title, description, area, timeframe,"
                    "  start_date, end_date, status, created_at, updated_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)",
                    (gid, title, desc, area, timeframe,
                     start_date, end_date, ts, ts),
                )
                row = conn.execute(
                    f"SELECT {_GOAL_COLS} FROM goals WHERE id = ?",
                    (gid,),
                ).fetchone()
            return _row_to_goal(row)

        return await asyncio.to_thread(_work)

    async def update_goal(self, goal_id: str, **fields: Any) -> Goal | None:
        """Patch-style update. Recognised fields: title, description, area,
        timeframe, start_date, end_date, status."""
        sets: list[str] = []
        params: list[Any] = []

        if "title" in fields and fields["title"] is not None:
            t = str(fields["title"]).strip()
            if not t:
                raise ValueError("title cannot be empty")
            sets.append("title = ?")
            params.append(t)

        if "description" in fields:
            desc = fields["description"]
            if desc is None or str(desc).strip() == "":
                sets.append("description = NULL")
            else:
                sets.append("description = ?")
                params.append(str(desc).strip())

        if "area" in fields and fields["area"] is not None:
            self._validate_area(fields["area"])
            sets.append("area = ?")
            params.append(fields["area"])

        if "timeframe" in fields and fields["timeframe"] is not None:
            self._validate_timeframe(fields["timeframe"])
            sets.append("timeframe = ?")
            params.append(fields["timeframe"])

        if "start_date" in fields:
            sets.append("start_date = ?")
            params.append(fields["start_date"])

        if "end_date" in fields:
            sets.append("end_date = ?")
            params.append(fields["end_date"])

        if "status" in fields and fields["status"] is not None:
            st = fields["status"]
            if st not in _VALID_STATUSES:
                raise ValueError(f"invalid status: {st!r}")
            sets.append("status = ?")
            params.append(st)

        if not sets:
            return await self.get_goal(goal_id)

        sets.append("updated_at = ?")
        params.append(_now_iso())
        params.append(goal_id)

        def _work() -> Goal | None:
            with self._store._connect() as conn:
                cur = conn.execute(
                    f"UPDATE goals SET {', '.join(sets)} WHERE id = ?",
                    params,
                )
                if (cur.rowcount or 0) == 0:
                    return None
                row = conn.execute(
                    f"SELECT {_GOAL_COLS} FROM goals WHERE id = ?",
                    (goal_id,),
                ).fetchone()
            return _row_to_goal(row) if row else None

        return await asyncio.to_thread(_work)

    async def delete_goal(self, goal_id: str) -> bool:
        """Soft-delete: sets status=abandoned."""
        ts = _now_iso()

        def _work() -> bool:
            with self._store._connect() as conn:
                cur = conn.execute(
                    "UPDATE goals SET status = 'abandoned', updated_at = ?"
                    " WHERE id = ? AND status != 'abandoned'",
                    (ts, goal_id),
                )
                return (cur.rowcount or 0) > 0

        return await asyncio.to_thread(_work)

    async def list_goals(
        self,
        *,
        area: str | None = None,
        status: str | None = None,
    ) -> list[Goal]:
        def _work() -> list[tuple[Goal, list[KeyResult]]]:
            with self._store._connect() as conn:
                clauses: list[str] = []
                params: list[Any] = []
                if area is not None:
                    clauses.append("g.area = ?")
                    params.append(area)
                if status is not None:
                    clauses.append("g.status = ?")
                    params.append(status)
                where = ""
                if clauses:
                    where = " WHERE " + " AND ".join(clauses)

                rows = conn.execute(
                    f"SELECT {_GOAL_COLS_G} FROM goals g{where}"
                    " ORDER BY g.created_at DESC",
                    params,
                ).fetchall()

                results: list[tuple[Goal, list[KeyResult]]] = []
                for r in rows:
                    goal = _row_to_goal(r)
                    kr_rows = conn.execute(
                        f"SELECT {_KR_COLS} FROM key_results"
                        " WHERE goal_id = ?",
                        (goal.id,),
                    ).fetchall()
                    krs = [_row_to_kr(kr) for kr in kr_rows]
                    results.append((goal, krs))
            return results

        records = await asyncio.to_thread(_work)
        goals: list[Goal] = []
        for goal, krs in records:
            goal.key_results = krs
            goal.progress = _compute_goal_progress(krs)
            goals.append(goal)
        return goals

    async def get_goal(self, goal_id: str) -> Goal | None:
        def _work() -> tuple[Goal, list[KeyResult], list[GoalLink]] | None:
            with self._store._connect() as conn:
                row = conn.execute(
                    f"SELECT {_GOAL_COLS} FROM goals WHERE id = ?",
                    (goal_id,),
                ).fetchone()
                if row is None:
                    return None
                goal = _row_to_goal(row)
                kr_rows = conn.execute(
                    f"SELECT {_KR_COLS} FROM key_results WHERE goal_id = ?",
                    (goal_id,),
                ).fetchall()
                krs = [_row_to_kr(kr) for kr in kr_rows]
                link_rows = conn.execute(
                    f"SELECT {_LINK_COLS} FROM goal_links WHERE goal_id = ?",
                    (goal_id,),
                ).fetchall()
                links = [_row_to_link(lk) for lk in link_rows]
            return goal, krs, links

        result = await asyncio.to_thread(_work)
        if result is None:
            return None
        goal, krs, links = result
        goal.key_results = krs
        goal.links = links
        goal.progress = _compute_goal_progress(krs)
        return goal

    # ------------------------------------------------------------------
    # Key Results CRUD
    # ------------------------------------------------------------------

    async def add_key_result(
        self,
        goal_id: str,
        *,
        title: str,
        metric_type: str,
        target_value: float,
        unit: str | None = None,
        auto_source: str | None = None,
    ) -> KeyResult | None:
        """Add a key result to a goal. Returns None if goal not found."""
        title = (title or "").strip()
        if not title:
            raise ValueError("title is required")
        self._validate_metric_type(metric_type)
        if target_value <= 0 and metric_type != "boolean":
            raise ValueError("target_value must be > 0 for non-boolean metrics")

        kr_id = str(uuid.uuid4())
        ts = _now_iso()

        def _work() -> KeyResult | None:
            with self._store._connect() as conn:
                # Verify goal exists
                g = conn.execute(
                    "SELECT id FROM goals WHERE id = ?", (goal_id,),
                ).fetchone()
                if g is None:
                    return None
                conn.execute(
                    "INSERT INTO key_results"
                    " (id, goal_id, title, metric_type, target_value,"
                    "  current_value, unit, auto_source, created_at, updated_at)"
                    " VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)",
                    (kr_id, goal_id, title, metric_type, target_value,
                     unit, auto_source, ts, ts),
                )
                row = conn.execute(
                    f"SELECT {_KR_COLS} FROM key_results WHERE id = ?",
                    (kr_id,),
                ).fetchone()
            return _row_to_kr(row)

        return await asyncio.to_thread(_work)

    async def update_key_result(
        self,
        kr_id: str,
        *,
        current_value: float | None = None,
        target_value: float | None = None,
        title: str | None = None,
    ) -> KeyResult | None:
        sets: list[str] = []
        params: list[Any] = []

        if current_value is not None:
            sets.append("current_value = ?")
            params.append(current_value)
        if target_value is not None:
            sets.append("target_value = ?")
            params.append(target_value)
        if title is not None:
            t = title.strip()
            if not t:
                raise ValueError("title cannot be empty")
            sets.append("title = ?")
            params.append(t)

        if not sets:
            # Just return current
            def _read() -> KeyResult | None:
                with self._store._connect() as conn:
                    row = conn.execute(
                        f"SELECT {_KR_COLS} FROM key_results WHERE id = ?",
                        (kr_id,),
                    ).fetchone()
                return _row_to_kr(row) if row else None
            return await asyncio.to_thread(_read)

        sets.append("updated_at = ?")
        params.append(_now_iso())
        params.append(kr_id)

        def _work() -> KeyResult | None:
            with self._store._connect() as conn:
                cur = conn.execute(
                    f"UPDATE key_results SET {', '.join(sets)} WHERE id = ?",
                    params,
                )
                if (cur.rowcount or 0) == 0:
                    return None
                row = conn.execute(
                    f"SELECT {_KR_COLS} FROM key_results WHERE id = ?",
                    (kr_id,),
                ).fetchone()
            return _row_to_kr(row) if row else None

        return await asyncio.to_thread(_work)

    # ------------------------------------------------------------------
    # Links CRUD
    # ------------------------------------------------------------------

    async def add_link(
        self,
        goal_id: str,
        linked_type: str,
        linked_id: str,
    ) -> GoalLink | None:
        """Link a task/habit/project to a goal. Returns None if goal not found."""
        self._validate_linked_type(linked_type)
        link_id = str(uuid.uuid4())

        def _work() -> GoalLink | None:
            with self._store._connect() as conn:
                g = conn.execute(
                    "SELECT id FROM goals WHERE id = ?", (goal_id,),
                ).fetchone()
                if g is None:
                    return None
                conn.execute(
                    "INSERT OR IGNORE INTO goal_links"
                    " (id, goal_id, linked_type, linked_id)"
                    " VALUES (?, ?, ?, ?)",
                    (link_id, goal_id, linked_type, linked_id),
                )
                row = conn.execute(
                    f"SELECT {_LINK_COLS} FROM goal_links"
                    " WHERE goal_id = ? AND linked_type = ? AND linked_id = ?",
                    (goal_id, linked_type, linked_id),
                ).fetchone()
            return _row_to_link(row) if row else None

        return await asyncio.to_thread(_work)

    async def remove_link(self, link_id: str) -> bool:
        def _work() -> bool:
            with self._store._connect() as conn:
                cur = conn.execute(
                    "DELETE FROM goal_links WHERE id = ?", (link_id,),
                )
                return (cur.rowcount or 0) > 0

        return await asyncio.to_thread(_work)

    # ------------------------------------------------------------------
    # Summary / dashboard
    # ------------------------------------------------------------------

    async def get_summary(self) -> GoalSummary:
        """Dashboard summary: at_risk, on_track, completed counts."""
        goals = await self.list_goals(status="active")
        today = _today_sp()
        at_risk = 0
        on_track = 0
        completed_count = 0

        # Also count already-completed goals
        completed_goals = await self.list_goals(status="completed")
        completed_count = len(completed_goals)

        for goal in goals:
            progress = goal.progress
            days_left = None
            if goal.end_date:
                try:
                    end = date.fromisoformat(goal.end_date)
                    days_left = (end - today).days
                except ValueError:
                    pass

            # At risk: <30% progress AND <30 days left
            if progress < 30.0 and days_left is not None and days_left < 30:
                at_risk += 1
            else:
                on_track += 1

        return GoalSummary(
            goals_at_risk=at_risk,
            goals_on_track=on_track,
            goals_completed=completed_count,
            total_active=len(goals),
        )

    # ------------------------------------------------------------------
    # Auto-update key results from data sources
    # ------------------------------------------------------------------

    async def auto_update_key_results(self, store: Store) -> int:
        """Iterate KRs with auto_source and compute current_value.

        Returns the number of KRs updated.

        Supported auto_source values:
        - "health.steps" -> sum steps from health_snapshots in goal date range
        - "tasks.completed" -> count done tasks in date range
        - "habits.{habit_id}" -> count completions in date range
        - "focus.minutes" -> sum from focus_sessions in date range
        """

        def _fetch_auto_krs() -> list[tuple[KeyResult, str | None, str | None]]:
            """Return (kr, goal_start_date, goal_end_date) for KRs with auto_source."""
            with store._connect() as conn:
                rows = conn.execute(
                    f"SELECT kr.id, kr.goal_id, kr.title, kr.metric_type,"
                    f" kr.target_value, kr.current_value, kr.unit,"
                    f" kr.auto_source, kr.created_at, kr.updated_at,"
                    f" g.start_date, g.end_date"
                    f" FROM key_results kr"
                    f" JOIN goals g ON g.id = kr.goal_id"
                    f" WHERE kr.auto_source IS NOT NULL"
                    f"   AND g.status = 'active'",
                ).fetchall()
            result: list[tuple[KeyResult, str | None, str | None]] = []
            for r in rows:
                kr = _row_to_kr(r[:10])
                result.append((kr, r[10], r[11]))
            return result

        def _compute_value(
            auto_source: str,
            start_date: str | None,
            end_date: str | None,
        ) -> float | None:
            """Compute the current value for a given auto_source. Runs in thread."""
            today_iso = _today_sp().isoformat()
            sd = start_date or "2000-01-01"
            ed = end_date or today_iso

            with store._connect() as conn:
                if auto_source == "health.steps":
                    row = conn.execute(
                        "SELECT COALESCE(SUM(steps), 0) FROM health_snapshots"
                        " WHERE date BETWEEN ? AND ?",
                        (sd, ed),
                    ).fetchone()
                    return float(row[0]) if row else 0.0

                if auto_source == "tasks.completed":
                    row = conn.execute(
                        "SELECT COUNT(*) FROM seraphine_tasks"
                        " WHERE status = 'completed'"
                        "   AND updated_at BETWEEN ? AND ?",
                        (sd, ed + "T23:59:59"),
                    ).fetchone()
                    return float(row[0]) if row else 0.0

                if auto_source.startswith("habits."):
                    habit_id = auto_source.split(".", 1)[1]
                    row = conn.execute(
                        "SELECT COUNT(*) FROM habit_logs"
                        " WHERE habit_id = ? AND completed = 1"
                        "   AND date BETWEEN ? AND ?",
                        (habit_id, sd, ed),
                    ).fetchone()
                    return float(row[0]) if row else 0.0

                if auto_source == "focus.minutes":
                    tbl = conn.execute(
                        "SELECT name FROM sqlite_master"
                        " WHERE type='table' AND name='focus_sessions'",
                    ).fetchone()
                    if tbl is None:
                        return None
                    row = conn.execute(
                        "SELECT COALESCE(SUM(duration_sec) / 60.0, 0)"
                        " FROM focus_sessions"
                        " WHERE started_at BETWEEN ? AND ?",
                        (sd, ed + "T23:59:59"),
                    ).fetchone()
                    return float(row[0]) if row else 0.0

            return None

        auto_krs = await asyncio.to_thread(_fetch_auto_krs)
        updated = 0

        for kr, goal_start, goal_end in auto_krs:
            if not kr.auto_source:
                continue
            try:
                new_val = await asyncio.to_thread(
                    _compute_value, kr.auto_source, goal_start, goal_end,
                )
            except Exception:
                logger.exception(
                    "auto_update: failed for KR %s (source=%s)",
                    kr.id, kr.auto_source,
                )
                continue

            if new_val is not None and new_val != kr.current_value:
                await self.update_key_result(kr.id, current_value=new_val)
                updated += 1

        return updated
