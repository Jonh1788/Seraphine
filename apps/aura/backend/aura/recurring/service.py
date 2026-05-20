"""RecurringService — CRUD + materialization for recurring task rules.

Every method scopes by user_id; the materialize_due loop is global but
creates tasks owned by each rule's user. Materialization is idempotent:
last_materialized_date is bumped after a successful insert, so running
the loop N times on the same day creates at most one task per rule.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import date, datetime, timezone
from typing import Any

from core_db import Store
from mod_tasks.offsets import validate_offsets
from mod_tasks.service import TaskService

from aura.recurring.models import RecurringRule

logger = logging.getLogger(__name__)


_SELECT_COLS = (
    "id, user_id, title, description, frequency, weekday, day_of_month,"
    " time, active, last_materialized_date, created_at, updated_at,"
    " reminder_offsets"
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_offsets(raw: str | None) -> list[int] | None:
    if raw is None:
        return None
    try:
        decoded = json.loads(raw)
    except (ValueError, TypeError):
        return None
    if not isinstance(decoded, list):
        return None
    out: list[int] = []
    for v in decoded:
        if isinstance(v, bool) or not isinstance(v, int):
            continue
        out.append(v)
    return out


def _encode_offsets(offsets: list[int] | None) -> str | None:
    if offsets is None:
        return None
    return json.dumps(sorted({int(o) for o in offsets}))


def _row_to_rule(row: tuple[Any, ...]) -> RecurringRule:
    return RecurringRule(
        id=row[0],
        user_id=row[1],
        title=row[2],
        description=row[3],
        frequency=row[4],
        weekday=row[5],
        day_of_month=row[6],
        time=row[7],
        active=bool(row[8]),
        last_materialized_date=row[9],
        created_at=row[10],
        updated_at=row[11],
        reminder_offsets=_parse_offsets(row[12] if len(row) > 12 else None),
    )


def _is_due_today(rule: RecurringRule, today: date) -> bool:
    """Pure weekday/day-of-month arithmetic. Monday=0..Sunday=6 matches
    Python's date.weekday() so no conversion is needed."""
    if not rule.active:
        return False
    if rule.frequency == "daily":
        return True
    if rule.frequency == "weekly":
        if rule.weekday is None:
            return False
        return today.weekday() == rule.weekday
    if rule.frequency == "monthly":
        if rule.day_of_month is None:
            return False
        # Clamp: if the rule says "day 31" but the month has only 30,
        # fire on the last day of the month instead of skipping it.
        import calendar
        last = calendar.monthrange(today.year, today.month)[1]
        target = min(rule.day_of_month, last)
        return today.day == target
    return False


class RecurringService:
    def __init__(self, store: Store, tasks: TaskService) -> None:
        self._store = store
        self._tasks = tasks

    # ------------------------------------------------------------------
    # CRUD
    # ------------------------------------------------------------------

    async def create(
        self,
        *,
        user_id: str,
        title: str,
        frequency: str,
        weekday: int | None = None,
        day_of_month: int | None = None,
        time: str | None = None,
        description: str | None = None,
        reminder_offsets: list[int] | None = None,
    ) -> RecurringRule:
        if frequency not in ("daily", "weekly", "monthly"):
            raise ValueError(f"frequency inválida: {frequency!r}")
        if frequency == "weekly" and weekday is None:
            raise ValueError("weekday é obrigatório para frequency=weekly")
        if frequency == "monthly" and day_of_month is None:
            raise ValueError("day_of_month é obrigatório para frequency=monthly")
        if weekday is not None and not (0 <= weekday <= 6):
            raise ValueError("weekday deve estar entre 0..6")
        if day_of_month is not None and not (1 <= day_of_month <= 31):
            raise ValueError("day_of_month deve estar entre 1..31")

        # validate_offsets raises HTTPException(422) on bad inputs — routes
        # surface that directly; programmatic callers (chat tool) catch it.
        validated_offsets = validate_offsets(reminder_offsets)
        offsets_blob = _encode_offsets(validated_offsets)

        rid = str(uuid.uuid4())
        ts = _now_iso()

        def _work() -> RecurringRule:
            with self._store._connect() as conn:
                conn.execute(
                    "INSERT INTO recurring_tasks"
                    " (id, user_id, title, description, frequency, weekday,"
                    "  day_of_month, time, active, last_materialized_date,"
                    "  created_at, updated_at, reminder_offsets)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?)",
                    (rid, user_id, title.strip(),
                     (description or "").strip() or None,
                     frequency, weekday, day_of_month, time, ts, ts,
                     offsets_blob),
                )
                row = conn.execute(
                    f"SELECT {_SELECT_COLS} FROM recurring_tasks WHERE id = ?",
                    (rid,),
                ).fetchone()
            return _row_to_rule(row)

        return await asyncio.to_thread(_work)

    async def list_for_user(self, user_id: str) -> list[RecurringRule]:
        def _work() -> list[RecurringRule]:
            with self._store._connect() as conn:
                rows = conn.execute(
                    f"SELECT {_SELECT_COLS} FROM recurring_tasks"
                    " WHERE user_id = ?"
                    " ORDER BY created_at DESC",
                    (user_id,),
                ).fetchall()
            return [_row_to_rule(r) for r in rows]

        return await asyncio.to_thread(_work)

    async def get(self, rule_id: str, user_id: str) -> RecurringRule | None:
        def _work() -> RecurringRule | None:
            with self._store._connect() as conn:
                row = conn.execute(
                    f"SELECT {_SELECT_COLS} FROM recurring_tasks"
                    " WHERE id = ? AND user_id = ?",
                    (rule_id, user_id),
                ).fetchone()
            return _row_to_rule(row) if row else None

        return await asyncio.to_thread(_work)

    async def delete(self, rule_id: str, user_id: str) -> int:
        def _work() -> int:
            with self._store._connect() as conn:
                cur = conn.execute(
                    "DELETE FROM recurring_tasks WHERE id = ? AND user_id = ?",
                    (rule_id, user_id),
                )
                return cur.rowcount or 0

        return await asyncio.to_thread(_work)

    async def update(
        self,
        rule_id: str,
        user_id: str,
        *,
        active: bool | None = None,
        time: str | None = None,
        weekday: int | None = None,
        day_of_month: int | None = None,
        title: str | None = None,
        description: str | None = None,
        reminder_offsets: list[int] | None = None,
        _time_provided: bool = False,
        _weekday_provided: bool = False,
        _day_of_month_provided: bool = False,
        _description_provided: bool = False,
        _reminder_offsets_provided: bool = False,
    ) -> RecurringRule | None:
        """Patch-style update. Fields not mentioned stay untouched."""
        sets: list[str] = []
        params: list[Any] = []
        if active is not None:
            sets.append("active = ?")
            params.append(1 if active else 0)
        if title is not None:
            sets.append("title = ?")
            params.append(title.strip())
        if _time_provided:
            sets.append("time = ?")
            params.append(time)
        if _weekday_provided:
            if weekday is not None and not (0 <= weekday <= 6):
                raise ValueError("weekday deve estar entre 0..6")
            sets.append("weekday = ?")
            params.append(weekday)
        if _day_of_month_provided:
            if day_of_month is not None and not (1 <= day_of_month <= 31):
                raise ValueError("day_of_month deve estar entre 1..31")
            sets.append("day_of_month = ?")
            params.append(day_of_month)
        if _description_provided:
            sets.append("description = ?")
            params.append((description or "").strip() or None)
        if _reminder_offsets_provided:
            validated = validate_offsets(reminder_offsets)
            sets.append("reminder_offsets = ?")
            params.append(_encode_offsets(validated))

        if not sets:
            return await self.get(rule_id, user_id)

        sets.append("updated_at = ?")
        params.append(_now_iso())
        params.extend([rule_id, user_id])

        def _work() -> RecurringRule | None:
            with self._store._connect() as conn:
                cur = conn.execute(
                    f"UPDATE recurring_tasks SET {', '.join(sets)}"
                    " WHERE id = ? AND user_id = ?",
                    params,
                )
                if (cur.rowcount or 0) == 0:
                    return None
                row = conn.execute(
                    f"SELECT {_SELECT_COLS} FROM recurring_tasks WHERE id = ?",
                    (rule_id,),
                ).fetchone()
            return _row_to_rule(row) if row else None

        return await asyncio.to_thread(_work)

    # ------------------------------------------------------------------
    # Materialization
    # ------------------------------------------------------------------

    async def materialize_due(
        self, now: datetime,
    ) -> list[tuple[RecurringRule, int]]:
        """For every active rule that is due today and hasn't been fired
        yet today, create one mod_tasks task owned by the rule's user and
        bump last_materialized_date.

        Returns the list of (rule, task_id) tuples that were materialized.
        """
        today_iso = now.date().isoformat()
        today = now.date()

        def _candidates() -> list[RecurringRule]:
            with self._store._connect() as conn:
                rows = conn.execute(
                    f"SELECT {_SELECT_COLS} FROM recurring_tasks"
                    " WHERE active = 1"
                    " AND (last_materialized_date IS NULL"
                    "      OR last_materialized_date < ?)",
                    (today_iso,),
                ).fetchall()
            return [_row_to_rule(r) for r in rows]

        rules = await asyncio.to_thread(_candidates)
        created: list[tuple[RecurringRule, int]] = []
        for rule in rules:
            if not _is_due_today(rule, today):
                continue
            try:
                task_id = await self._materialize_rule(rule, today_iso)
                if task_id is not None:
                    created.append((rule, task_id))
            except Exception:
                logger.exception(
                    "materialize_due: failed for rule %s (user %s)",
                    rule.id, rule.user_id,
                )
        return created

    async def _apply_reminder_offsets(
        self, rule: RecurringRule, task_id: int,
    ) -> None:
        """Push the rule's offsets (or the user's profile defaults) onto
        the freshly-materialized task. Always includes 0 so the occurrence
        fires at the scheduled time — preserves today's UX for rules that
        never had per-rule overrides set."""
        if rule.reminder_offsets is not None:
            base = rule.reminder_offsets
        else:
            base = await self._tasks.get_default_offsets(rule.user_id)
        final = sorted({0, *(int(o) for o in base)})
        try:
            await self._tasks.set_reminder_offsets(
                str(task_id), rule.user_id, final,
            )
        except Exception:
            logger.exception(
                "set_reminder_offsets failed for task %s (rule %s)",
                task_id, rule.id,
            )

    async def _materialize_rule(
        self, rule: RecurringRule, today_iso: str,
    ) -> int | None:
        """Create a task for this rule today. Uses a conditional UPDATE
        to claim the day — if another loop already materialized, the
        UPDATE affects zero rows and we skip insert."""

        def _claim() -> bool:
            with self._store._connect() as conn:
                cur = conn.execute(
                    "UPDATE recurring_tasks"
                    " SET last_materialized_date = ?, updated_at = ?"
                    " WHERE id = ?"
                    "   AND active = 1"
                    "   AND (last_materialized_date IS NULL"
                    "        OR last_materialized_date < ?)",
                    (today_iso, _now_iso(), rule.id, today_iso),
                )
                return (cur.rowcount or 0) > 0

        claimed = await asyncio.to_thread(_claim)
        if not claimed:
            return None

        task_id = await self._tasks.create_task(
            type="generic",
            title=rule.title,
            description=rule.description or "",
            source="recurring",
            payload={"recurring_id": rule.id},
            status="pending",
            due_date=today_iso,
            due_time=rule.time,
            user_id=rule.user_id,
        )
        await self._apply_reminder_offsets(rule, task_id)
        return task_id

    async def materialize_for_rule_if_due(
        self, rule: RecurringRule, now: datetime,
    ) -> int | None:
        """Same logic used by create_recurring_task tool right after insert —
        if today matches, fire an occurrence immediately so the user sees
        today's card."""
        if not _is_due_today(rule, now.date()):
            return None
        return await self._materialize_rule(rule, now.date().isoformat())
