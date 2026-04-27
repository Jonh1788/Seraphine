"""GoalsService — CRUD + overview."""

from __future__ import annotations

import asyncio
import uuid
from datetime import date, datetime, timezone
from typing import Any

from core_db import Store

from aura.goals.models import Goal


_COLS = (
    "id, user_id, title, description, kind, target_value, current_value,"
    " unit, deadline, status, created_at, updated_at"
)
ALLOWED_KIND = ("general", "financial", "habit", "project")
ALLOWED_STATUS = ("active", "completed", "expired", "archived")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row_to_goal(row: tuple[Any, ...]) -> Goal:
    return Goal(
        id=row[0],
        user_id=row[1],
        title=row[2],
        description=row[3],
        kind=row[4],
        target_value=float(row[5]) if row[5] is not None else None,
        current_value=float(row[6] or 0),
        unit=row[7],
        deadline=row[8],
        status=row[9],
        created_at=row[10],
        updated_at=row[11],
    )


class GoalsService:
    def __init__(self, store: Store) -> None:
        self._store = store

    async def aclose(self) -> None:  # pragma: no cover
        pass

    async def create(
        self,
        *,
        user_id: str,
        title: str,
        description: str | None = None,
        kind: str = "general",
        target_value: float | None = None,
        unit: str | None = None,
        deadline: str | None = None,
    ) -> Goal:
        if kind not in ALLOWED_KIND:
            kind = "general"
        ts = _now_iso()
        g = Goal(
            id=str(uuid.uuid4()),
            user_id=user_id,
            title=title.strip(),
            description=(description or "").strip() or None,
            kind=kind,
            target_value=target_value,
            current_value=0.0,
            unit=(unit or "").strip() or None,
            deadline=deadline,
            status="active",
            created_at=ts,
            updated_at=ts,
        )

        def _work() -> None:
            with self._store._connect() as conn:
                conn.execute(
                    f"INSERT INTO goals ({_COLS})"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        g.id, g.user_id, g.title, g.description, g.kind,
                        g.target_value, g.current_value, g.unit, g.deadline,
                        g.status, g.created_at, g.updated_at,
                    ),
                )

        await asyncio.to_thread(_work)
        return g

    async def list_for_user(
        self,
        user_id: str,
        *,
        kind: str | None = None,
        include_archived: bool = False,
    ) -> list[Goal]:
        clauses: list[str] = ["user_id = ?"]
        params: list[object] = [user_id]
        if kind:
            clauses.append("kind = ?")
            params.append(kind)
        if not include_archived:
            clauses.append("status != 'archived'")
        where = " WHERE " + " AND ".join(clauses)

        def _work() -> list[Goal]:
            with self._store._connect() as conn:
                rows = conn.execute(
                    f"SELECT {_COLS} FROM goals{where}"
                    " ORDER BY"
                    "   CASE status WHEN 'active' THEN 0 WHEN 'completed' THEN 1"
                    "                WHEN 'expired' THEN 2 ELSE 3 END,"
                    "   COALESCE(deadline, '9999'),"
                    "   updated_at DESC",
                    params,
                ).fetchall()
            return [_row_to_goal(r) for r in rows]

        return await asyncio.to_thread(_work)

    async def get(self, goal_id: str, user_id: str) -> Goal | None:
        def _work() -> Goal | None:
            with self._store._connect() as conn:
                row = conn.execute(
                    f"SELECT {_COLS} FROM goals WHERE id = ? AND user_id = ?",
                    (goal_id, user_id),
                ).fetchone()
            return _row_to_goal(row) if row else None

        return await asyncio.to_thread(_work)

    async def update(
        self,
        goal_id: str,
        user_id: str,
        *,
        title: str | None = None,
        description: str | None = None,
        kind: str | None = None,
        target_value: float | None = None,
        current_value: float | None = None,
        unit: str | None = None,
        deadline: str | None = None,
        status: str | None = None,
    ) -> Goal | None:
        sets: list[str] = []
        params: list[object] = []
        if title is not None:
            sets.append("title = ?"); params.append(title.strip())
        if description is not None:
            sets.append("description = ?"); params.append(description.strip() or None)
        if kind is not None and kind in ALLOWED_KIND:
            sets.append("kind = ?"); params.append(kind)
        if target_value is not None:
            sets.append("target_value = ?"); params.append(target_value)
        if current_value is not None:
            sets.append("current_value = ?"); params.append(current_value)
        if unit is not None:
            sets.append("unit = ?"); params.append(unit.strip() or None)
        if deadline is not None:
            sets.append("deadline = ?"); params.append(deadline or None)
        if status is not None and status in ALLOWED_STATUS:
            sets.append("status = ?"); params.append(status)
        if not sets:
            return await self.get(goal_id, user_id)
        ts = _now_iso()
        sets.append("updated_at = ?")
        params.append(ts)

        def _work() -> Goal | None:
            with self._store._connect() as conn:
                cur = conn.execute(
                    f"UPDATE goals SET {', '.join(sets)}"
                    " WHERE id = ? AND user_id = ?",
                    (*params, goal_id, user_id),
                )
                if cur.rowcount == 0:
                    return None
                row = conn.execute(
                    f"SELECT {_COLS} FROM goals WHERE id = ?", (goal_id,),
                ).fetchone()
            return _row_to_goal(row) if row else None

        return await asyncio.to_thread(_work)

    async def delete(self, goal_id: str, user_id: str) -> int:
        def _work() -> int:
            with self._store._connect() as conn:
                cur = conn.execute(
                    "DELETE FROM goals WHERE id = ? AND user_id = ?",
                    (goal_id, user_id),
                )
            return cur.rowcount

        return await asyncio.to_thread(_work)

    async def overview(self, user_id: str) -> dict:
        today_iso = date.today().isoformat()

        def _work() -> dict:
            with self._store._connect() as conn:
                rows = conn.execute(
                    "SELECT status, COUNT(*) FROM goals"
                    " WHERE user_id = ? AND status != 'archived'"
                    " GROUP BY status",
                    (user_id,),
                ).fetchall()
                expired = conn.execute(
                    "SELECT COUNT(*) FROM goals"
                    " WHERE user_id = ? AND status = 'active'"
                    "   AND deadline IS NOT NULL AND deadline < ?",
                    (user_id, today_iso),
                ).fetchone()[0]
            counts = {"active": 0, "completed": 0, "expired": 0}
            for status, n in rows:
                if status in counts:
                    counts[status] = int(n)
            counts["expired"] = max(counts["expired"], int(expired or 0))
            total = sum(counts.values())
            return {"total": total, **counts}

        return await asyncio.to_thread(_work)
