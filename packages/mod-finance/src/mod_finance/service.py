"""FinanceService — domain service backed by core-db Store.

Multi-tenant aware: every method takes ``user_id``. When None, all
queries omit the user filter (Seraphine single-tenant legacy
contract). When set, queries are scoped to that user.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any

from core_db import Store

from mod_finance.models import FinancialEntry, RecurringRule


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


_ENTRY_COLS = (
    "id, type, amount, currency, category, description, date, source,"
    " recurring_id, status, created_at, user_id"
)
_RULE_COLS = (
    "id, type, amount, category, description, day_of_month, frequency,"
    " start_date, end_date, active, created_at, user_id"
)


def _row_to_entry(r: tuple[Any, ...]) -> FinancialEntry:
    return FinancialEntry(
        id=r[0], type=r[1], amount=r[2], currency=r[3], category=r[4],
        description=r[5], date=r[6], source=r[7], recurring_id=r[8],
        status=r[9], created_at=r[10], user_id=r[11],
    )


def _row_to_rule(r: tuple[Any, ...]) -> RecurringRule:
    return RecurringRule(
        id=r[0], type=r[1], amount=r[2], category=r[3], description=r[4],
        day_of_month=r[5], frequency=r[6], start_date=r[7], end_date=r[8],
        active=bool(r[9]), created_at=r[10], user_id=r[11],
    )


class FinanceService:
    def __init__(self, store: Store) -> None:
        self._store = store

    async def aclose(self) -> None:  # pragma: no cover
        return None

    # ------------------------------------------------------------------
    # Entries CRUD
    # ------------------------------------------------------------------

    async def add_entry(
        self,
        entry: FinancialEntry,
        *,
        skip_dedup: bool = False,
        user_id: str | None = None,
    ) -> int:
        ts = _now()
        # Caller may have set entry.user_id; otherwise scope by argument.
        effective_user = entry.user_id if entry.user_id is not None else user_id

        def _work() -> int:
            with self._store._connect() as conn:
                if not skip_dedup:
                    if effective_user is None:
                        existing = conn.execute(
                            "SELECT id FROM financial_entries"
                            " WHERE date = ? AND amount = ? AND type = ?"
                            " AND currency = ? AND description = ?"
                            " AND user_id IS NULL LIMIT 1",
                            (entry.date, entry.amount, entry.type,
                             entry.currency, entry.description),
                        ).fetchone()
                    else:
                        existing = conn.execute(
                            "SELECT id FROM financial_entries"
                            " WHERE date = ? AND amount = ? AND type = ?"
                            " AND currency = ? AND description = ?"
                            " AND user_id = ? LIMIT 1",
                            (entry.date, entry.amount, entry.type,
                             entry.currency, entry.description, effective_user),
                        ).fetchone()
                    if existing:
                        return existing[0]

                cur = conn.execute(
                    "INSERT INTO financial_entries"
                    " (type, amount, currency, category, description, date,"
                    "  source, recurring_id, status, created_at, user_id)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (entry.type, entry.amount, entry.currency, entry.category,
                     entry.description, entry.date, entry.source,
                     entry.recurring_id, entry.status, ts, effective_user),
                )
                return cur.lastrowid  # type: ignore[return-value]

        return await asyncio.to_thread(_work)

    async def update_entry_status(
        self, entry_id: int, status: str, *, user_id: str | None = None,
    ) -> int:
        def _work() -> int:
            with self._store._connect() as conn:
                if user_id is None:
                    cur = conn.execute(
                        "UPDATE financial_entries SET status = ?"
                        " WHERE id = ?",
                        (status, entry_id),
                    )
                else:
                    cur = conn.execute(
                        "UPDATE financial_entries SET status = ?"
                        " WHERE id = ? AND user_id = ?",
                        (status, entry_id, user_id),
                    )
                return cur.rowcount or 0

        return await asyncio.to_thread(_work)

    async def delete_entry(
        self, entry_id: int, *, user_id: str | None = None,
    ) -> int:
        def _work() -> int:
            with self._store._connect() as conn:
                if user_id is None:
                    cur = conn.execute(
                        "DELETE FROM financial_entries WHERE id = ?",
                        (entry_id,),
                    )
                else:
                    cur = conn.execute(
                        "DELETE FROM financial_entries"
                        " WHERE id = ? AND user_id = ?",
                        (entry_id, user_id),
                    )
                return cur.rowcount or 0

        return await asyncio.to_thread(_work)

    async def list_entries(
        self,
        *,
        month: int | None = None,
        year: int | None = None,
        category: str | None = None,
        type: str | None = None,
        status: str | None = None,
        limit: int = 100,
        user_id: str | None = None,
    ) -> list[FinancialEntry]:
        def _work() -> list[FinancialEntry]:
            clauses: list[str] = []
            params: list[object] = []
            if user_id is not None:
                clauses.append("user_id = ?")
                params.append(user_id)
            if month is not None and year is not None:
                clauses.append("substr(date, 1, 7) = ?")
                params.append(f"{year:04d}-{month:02d}")
            elif year is not None:
                clauses.append("substr(date, 1, 4) = ?")
                params.append(f"{year:04d}")
            if category is not None:
                clauses.append("category = ?")
                params.append(category)
            if type is not None:
                clauses.append("type = ?")
                params.append(type)
            if status is not None:
                clauses.append("status = ?")
                params.append(status)
            where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
            params.append(limit)

            with self._store._connect() as conn:
                rows = conn.execute(
                    f"SELECT {_ENTRY_COLS} FROM financial_entries{where}"
                    " ORDER BY date DESC LIMIT ?",
                    params,
                ).fetchall()
            return [_row_to_entry(r) for r in rows]

        return await asyncio.to_thread(_work)

    # ------------------------------------------------------------------
    # Aggregations
    # ------------------------------------------------------------------

    async def get_monthly_summary(
        self, month: int, year: int, *, user_id: str | None = None,
    ) -> dict:
        def _work() -> dict:
            prefix = f"{year:04d}-{month:02d}"
            extra = ""
            params_total: tuple[object, ...] = (prefix,)
            params_cat: tuple[object, ...] = (prefix,)
            if user_id is not None:
                extra = " AND user_id = ?"
                params_total = (prefix, user_id)
                params_cat = (prefix, user_id)
            with self._store._connect() as conn:
                row = conn.execute(
                    "SELECT"
                    " COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0),"
                    " COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0)"
                    " FROM financial_entries"
                    " WHERE substr(date, 1, 7) = ? AND status = 'confirmed'"
                    + extra,
                    params_total,
                ).fetchone()
                income, expenses = row[0], row[1]
                cat_rows = conn.execute(
                    "SELECT category, SUM(amount) AS total, COUNT(*) AS cnt"
                    " FROM financial_entries"
                    " WHERE substr(date, 1, 7) = ? AND status = 'confirmed'"
                    " AND type = 'expense'" + extra
                    + " GROUP BY category ORDER BY total DESC",
                    params_cat,
                ).fetchall()
            return {
                "income": income,
                "expenses": expenses,
                "balance": income - expenses,
                "by_category": [
                    {"category": r[0], "total": r[1], "count": r[2]}
                    for r in cat_rows
                ],
            }

        return await asyncio.to_thread(_work)

    async def get_overall_balance(
        self, *, user_id: str | None = None,
    ) -> dict:
        def _work() -> dict:
            extra = ""
            params: tuple[object, ...] = ()
            if user_id is not None:
                extra = " AND user_id = ?"
                params = (user_id,)
            with self._store._connect() as conn:
                row = conn.execute(
                    "SELECT"
                    " COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0),"
                    " COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0)"
                    " FROM financial_entries WHERE status = 'confirmed'"
                    + extra,
                    params,
                ).fetchone()
                income, expenses = row[0], row[1]
                adj_row = conn.execute(
                    "SELECT COALESCE(SUM(amount), 0) FROM financial_entries"
                    " WHERE source = 'adjustment' AND status = 'confirmed'"
                    + extra,
                    params,
                ).fetchone()
                adjustment = adj_row[0]
            return {
                "total_income": income,
                "total_expenses": expenses,
                "adjustment": adjustment,
                "balance": income - expenses,
            }

        return await asyncio.to_thread(_work)

    # ------------------------------------------------------------------
    # Recurring rules
    # ------------------------------------------------------------------

    async def add_recurring(
        self, rule: RecurringRule, *, user_id: str | None = None,
    ) -> int:
        ts = _now()
        effective_user = rule.user_id if rule.user_id is not None else user_id

        def _work() -> int:
            with self._store._connect() as conn:
                cur = conn.execute(
                    "INSERT INTO recurring_rules"
                    " (type, amount, category, description, day_of_month,"
                    "  frequency, start_date, end_date, active, created_at,"
                    "  user_id)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (rule.type, rule.amount, rule.category, rule.description,
                     rule.day_of_month, rule.frequency, rule.start_date,
                     rule.end_date, 1 if rule.active else 0, ts, effective_user),
                )
                return cur.lastrowid  # type: ignore[return-value]

        return await asyncio.to_thread(_work)

    async def list_recurring(
        self, active_only: bool = True, *, user_id: str | None = None,
    ) -> list[RecurringRule]:
        def _work() -> list[RecurringRule]:
            clauses: list[str] = []
            params: list[object] = []
            if active_only:
                clauses.append("active = 1")
            if user_id is not None:
                clauses.append("user_id = ?")
                params.append(user_id)
            where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
            with self._store._connect() as conn:
                rows = conn.execute(
                    f"SELECT {_RULE_COLS} FROM recurring_rules{where}"
                    " ORDER BY created_at DESC",
                    params,
                ).fetchall()
            return [_row_to_rule(r) for r in rows]

        return await asyncio.to_thread(_work)

    async def deactivate_recurring(
        self, rule_id: int, *, user_id: str | None = None,
    ) -> int:
        def _work() -> int:
            with self._store._connect() as conn:
                if user_id is None:
                    cur = conn.execute(
                        "UPDATE recurring_rules SET active = 0 WHERE id = ?",
                        (rule_id,),
                    )
                else:
                    cur = conn.execute(
                        "UPDATE recurring_rules SET active = 0"
                        " WHERE id = ? AND user_id = ?",
                        (rule_id, user_id),
                    )
                return cur.rowcount or 0

        return await asyncio.to_thread(_work)
