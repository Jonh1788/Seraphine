"""ProjectsService — CRUD + KPI overview.

Status transitions are enforced by the CHECK constraint at the schema
level; the service trusts the value coming through pydantic validation
in the route layer.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timezone
from typing import Any

from core_db import Store

from aura.projects.models import Project


_COLS = (
    "id, user_id, name, description, color, status, target_date,"
    " progress, created_at, updated_at"
)

ALLOWED_STATUS = ("active", "at_risk", "completed", "archived")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row_to_project(row: tuple[Any, ...]) -> Project:
    return Project(
        id=row[0],
        user_id=row[1],
        name=row[2],
        description=row[3],
        color=row[4],
        status=row[5],
        target_date=row[6],
        progress=int(row[7] or 0),
        created_at=row[8],
        updated_at=row[9],
    )


class ProjectsService:
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
        description: str | None = None,
        color: str = "blue",
        status: str = "active",
        target_date: str | None = None,
    ) -> Project:
        if status not in ALLOWED_STATUS:
            status = "active"
        ts = _now_iso()
        proj = Project(
            id=str(uuid.uuid4()),
            user_id=user_id,
            name=name.strip(),
            description=(description or "").strip() or None,
            color=color,
            status=status,
            target_date=target_date,
            progress=0,
            created_at=ts,
            updated_at=ts,
        )

        def _work() -> None:
            with self._store._connect() as conn:
                conn.execute(
                    f"INSERT INTO projects ({_COLS})"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        proj.id, proj.user_id, proj.name, proj.description,
                        proj.color, proj.status, proj.target_date,
                        proj.progress, proj.created_at, proj.updated_at,
                    ),
                )

        await asyncio.to_thread(_work)
        return proj

    async def list_for_user(
        self,
        user_id: str,
        *,
        include_archived: bool = False,
    ) -> list[Project]:
        def _work() -> list[Project]:
            with self._store._connect() as conn:
                if include_archived:
                    rows = conn.execute(
                        f"SELECT {_COLS} FROM projects"
                        " WHERE user_id = ?"
                        " ORDER BY status, updated_at DESC",
                        (user_id,),
                    ).fetchall()
                else:
                    rows = conn.execute(
                        f"SELECT {_COLS} FROM projects"
                        " WHERE user_id = ? AND status != 'archived'"
                        " ORDER BY"
                        "   CASE status"
                        "     WHEN 'at_risk' THEN 0"
                        "     WHEN 'active' THEN 1"
                        "     WHEN 'completed' THEN 2"
                        "     ELSE 3"
                        "   END,"
                        "   updated_at DESC",
                        (user_id,),
                    ).fetchall()
            return [_row_to_project(r) for r in rows]

        return await asyncio.to_thread(_work)

    async def get(self, project_id: str, user_id: str) -> Project | None:
        def _work() -> Project | None:
            with self._store._connect() as conn:
                row = conn.execute(
                    f"SELECT {_COLS} FROM projects"
                    " WHERE id = ? AND user_id = ?",
                    (project_id, user_id),
                ).fetchone()
            return _row_to_project(row) if row else None

        return await asyncio.to_thread(_work)

    async def update(
        self,
        project_id: str,
        user_id: str,
        *,
        name: str | None = None,
        description: str | None = None,
        color: str | None = None,
        status: str | None = None,
        target_date: str | None = None,
        progress: int | None = None,
    ) -> Project | None:
        sets: list[str] = []
        params: list[object] = []
        if name is not None:
            sets.append("name = ?")
            params.append(name.strip())
        if description is not None:
            sets.append("description = ?")
            params.append(description.strip() or None)
        if color is not None:
            sets.append("color = ?")
            params.append(color)
        if status is not None:
            if status not in ALLOWED_STATUS:
                return await self.get(project_id, user_id)
            sets.append("status = ?")
            params.append(status)
        if target_date is not None:
            sets.append("target_date = ?")
            params.append(target_date or None)
        if progress is not None:
            sets.append("progress = ?")
            params.append(max(0, min(100, progress)))
        if not sets:
            return await self.get(project_id, user_id)
        ts = _now_iso()
        sets.append("updated_at = ?")
        params.append(ts)

        def _work() -> Project | None:
            with self._store._connect() as conn:
                cur = conn.execute(
                    f"UPDATE projects SET {', '.join(sets)}"
                    " WHERE id = ? AND user_id = ?",
                    (*params, project_id, user_id),
                )
                if cur.rowcount == 0:
                    return None
                row = conn.execute(
                    f"SELECT {_COLS} FROM projects WHERE id = ?",
                    (project_id,),
                ).fetchone()
            return _row_to_project(row) if row else None

        return await asyncio.to_thread(_work)

    async def delete(self, project_id: str, user_id: str) -> int:
        def _work() -> int:
            with self._store._connect() as conn:
                cur = conn.execute(
                    "DELETE FROM projects WHERE id = ? AND user_id = ?",
                    (project_id, user_id),
                )
            return cur.rowcount

        return await asyncio.to_thread(_work)

    # ------------------------------------------------------------------
    # KPIs
    # ------------------------------------------------------------------

    async def overview(self, user_id: str) -> dict:
        def _work() -> dict:
            with self._store._connect() as conn:
                rows = conn.execute(
                    "SELECT status, COUNT(*) FROM projects"
                    " WHERE user_id = ? GROUP BY status",
                    (user_id,),
                ).fetchall()
            counts = {s: 0 for s in ALLOWED_STATUS}
            for status, n in rows:
                counts[status] = int(n)
            total = sum(counts.values())
            return {
                "total": total,
                "active": counts["active"],
                "at_risk": counts["at_risk"],
                "completed": counts["completed"],
                "archived": counts["archived"],
            }

        return await asyncio.to_thread(_work)
