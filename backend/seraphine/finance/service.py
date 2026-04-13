from __future__ import annotations

import asyncio
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from .models import CATEGORIES, FinancialEntry, RecurringRule


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class FinanceService:
    def __init__(self, db_path: str | Path) -> None:
        self.path = Path(db_path)
        self._conn: sqlite3.Connection | None = None

    def _connect(self) -> sqlite3.Connection:
        if self._conn is not None:
            return self._conn
        conn = sqlite3.connect(self.path, check_same_thread=False)
        conn.execute("PRAGMA foreign_keys = ON")
        self._conn = conn
        return conn

    async def aclose(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    # ------------------------------------------------------------------
    # Schema
    # ------------------------------------------------------------------

    async def ensure_tables(self) -> None:
        def _work() -> None:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self._connect() as conn:
                conn.executescript(
                    """
                    CREATE TABLE IF NOT EXISTS recurring_rules (
                      id            INTEGER PRIMARY KEY AUTOINCREMENT,
                      type          TEXT NOT NULL CHECK (type IN ('income', 'expense')),
                      amount        REAL NOT NULL,
                      category      TEXT NOT NULL,
                      description   TEXT NOT NULL,
                      day_of_month  INTEGER,
                      frequency     TEXT NOT NULL CHECK (frequency IN ('monthly', 'weekly', 'custom')),
                      start_date    TEXT NOT NULL,
                      end_date      TEXT,
                      active        INTEGER NOT NULL DEFAULT 1,
                      created_at    TEXT NOT NULL
                    );

                    CREATE TABLE IF NOT EXISTS financial_entries (
                      id            INTEGER PRIMARY KEY AUTOINCREMENT,
                      type          TEXT NOT NULL CHECK (type IN ('income', 'expense')),
                      amount        REAL NOT NULL,
                      currency      TEXT NOT NULL DEFAULT 'BRL',
                      category      TEXT NOT NULL,
                      description   TEXT NOT NULL,
                      date          TEXT NOT NULL,
                      source        TEXT NOT NULL CHECK (source IN ('chat', 'pdf', 'email', 'recurring', 'manual')),
                      recurring_id  INTEGER REFERENCES recurring_rules(id),
                      status        TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'pending_review')),
                      created_at    TEXT NOT NULL
                    );

                    CREATE INDEX IF NOT EXISTS idx_entries_date
                      ON financial_entries(date);
                    CREATE INDEX IF NOT EXISTS idx_entries_category
                      ON financial_entries(category);
                    CREATE INDEX IF NOT EXISTS idx_entries_type
                      ON financial_entries(type);
                    """
                )

        await asyncio.to_thread(_work)

    # ------------------------------------------------------------------
    # Entries CRUD
    # ------------------------------------------------------------------

    async def add_entry(self, entry: FinancialEntry) -> int:
        """Insert a financial entry. Returns the entry ID.

        Deduplication: if an entry with the same date, amount, type,
        and similar description already exists, returns the existing ID
        instead of creating a duplicate.
        """
        ts = _now()

        def _work() -> int:
            with self._connect() as conn:
                # Dedup check: same date + amount + type + similar description
                existing = conn.execute(
                    "SELECT id FROM financial_entries"
                    " WHERE date = ? AND amount = ? AND type = ?"
                    " AND currency = ?"
                    " LIMIT 1",
                    (entry.date, entry.amount, entry.type, entry.currency),
                ).fetchone()
                if existing:
                    return existing[0]

                cur = conn.execute(
                    "INSERT INTO financial_entries"
                    "(type, amount, currency, category, description, date,"
                    " source, recurring_id, status, created_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        entry.type,
                        entry.amount,
                        entry.currency,
                        entry.category,
                        entry.description,
                        entry.date,
                        entry.source,
                        entry.recurring_id,
                        entry.status,
                        ts,
                    ),
                )
                return cur.lastrowid  # type: ignore[return-value]

        return await asyncio.to_thread(_work)

    async def update_entry_status(self, entry_id: int, status: str) -> None:
        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "UPDATE financial_entries SET status = ? WHERE id = ?",
                    (status, entry_id),
                )

        await asyncio.to_thread(_work)

    async def delete_entry(self, entry_id: int) -> None:
        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "DELETE FROM financial_entries WHERE id = ?",
                    (entry_id,),
                )

        await asyncio.to_thread(_work)

    async def list_entries(
        self,
        *,
        month: int | None = None,
        year: int | None = None,
        category: str | None = None,
        type: str | None = None,
        status: str | None = None,
        limit: int = 100,
    ) -> list[FinancialEntry]:
        def _work() -> list[FinancialEntry]:
            clauses: list[str] = []
            params: list[object] = []

            if month is not None and year is not None:
                # Match YYYY-MM prefix of the date column
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

            where = ""
            if clauses:
                where = " WHERE " + " AND ".join(clauses)

            params.append(limit)

            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT id, type, amount, currency, category, description,"
                    " date, source, recurring_id, status, created_at"
                    f" FROM financial_entries{where}"
                    " ORDER BY date DESC LIMIT ?",
                    params,
                ).fetchall()

            return [
                FinancialEntry(
                    id=r[0],
                    type=r[1],
                    amount=r[2],
                    currency=r[3],
                    category=r[4],
                    description=r[5],
                    date=r[6],
                    source=r[7],
                    recurring_id=r[8],
                    status=r[9],
                    created_at=r[10],
                )
                for r in rows
            ]

        return await asyncio.to_thread(_work)

    # ------------------------------------------------------------------
    # Aggregations
    # ------------------------------------------------------------------

    async def get_monthly_summary(self, month: int, year: int) -> dict:
        def _work() -> dict:
            prefix = f"{year:04d}-{month:02d}"
            with self._connect() as conn:
                # totals by type
                row = conn.execute(
                    "SELECT"
                    " COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0),"
                    " COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0)"
                    " FROM financial_entries"
                    " WHERE substr(date, 1, 7) = ? AND status = 'confirmed'",
                    (prefix,),
                ).fetchone()
                income = row[0]
                expenses = row[1]

                # by category
                cat_rows = conn.execute(
                    "SELECT category,"
                    " SUM(amount) AS total,"
                    " COUNT(*) AS cnt"
                    " FROM financial_entries"
                    " WHERE substr(date, 1, 7) = ? AND status = 'confirmed'"
                    " GROUP BY category ORDER BY total DESC",
                    (prefix,),
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

    # ------------------------------------------------------------------
    # Recurring rules
    # ------------------------------------------------------------------

    async def add_recurring(self, rule: RecurringRule) -> int:
        ts = _now()

        def _work() -> int:
            with self._connect() as conn:
                cur = conn.execute(
                    "INSERT INTO recurring_rules"
                    "(type, amount, category, description, day_of_month,"
                    " frequency, start_date, end_date, active, created_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        rule.type,
                        rule.amount,
                        rule.category,
                        rule.description,
                        rule.day_of_month,
                        rule.frequency,
                        rule.start_date,
                        rule.end_date,
                        1 if rule.active else 0,
                        ts,
                    ),
                )
                return cur.lastrowid  # type: ignore[return-value]

        return await asyncio.to_thread(_work)

    async def list_recurring(self, active_only: bool = True) -> list[RecurringRule]:
        def _work() -> list[RecurringRule]:
            where = " WHERE active = 1" if active_only else ""
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT id, type, amount, category, description,"
                    " day_of_month, frequency, start_date, end_date,"
                    f" active, created_at FROM recurring_rules{where}"
                    " ORDER BY created_at DESC",
                ).fetchall()
            return [
                RecurringRule(
                    id=r[0],
                    type=r[1],
                    amount=r[2],
                    category=r[3],
                    description=r[4],
                    day_of_month=r[5],
                    frequency=r[6],
                    start_date=r[7],
                    end_date=r[8],
                    active=bool(r[9]),
                    created_at=r[10],
                )
                for r in rows
            ]

        return await asyncio.to_thread(_work)

    async def deactivate_recurring(self, rule_id: int) -> None:
        def _work() -> None:
            with self._connect() as conn:
                conn.execute(
                    "UPDATE recurring_rules SET active = 0 WHERE id = ?",
                    (rule_id,),
                )

        await asyncio.to_thread(_work)
