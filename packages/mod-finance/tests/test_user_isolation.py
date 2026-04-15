"""Property test: financial entries of one user are invisible to another."""

from __future__ import annotations

from pathlib import Path

import pytest

from core_db import Store
from mod_finance import FinanceService
from mod_finance import schema as finance_schema
from mod_finance.models import FinancialEntry, RecurringRule


@pytest.fixture
async def store(tmp_path: Path) -> Store:
    s = Store(tmp_path / "iso.sqlite")
    s.register_migrator("mod_finance", finance_schema.migrate)
    await s.ensure_schema()
    return s


def _entry(amount: float, description: str) -> FinancialEntry:
    return FinancialEntry(
        id=None,
        type="expense",
        amount=amount,
        currency="BRL",
        category="outros",
        description=description,
        date="2026-04-01",
        source="manual",
    )


async def test_entries_isolation(store: Store) -> None:
    svc = FinanceService(store)

    a_ids = [
        await svc.add_entry(_entry(10.0 + i, f"a-{i}"), user_id="user-a")
        for i in range(3)
    ]
    b_ids = [
        await svc.add_entry(_entry(20.0 + i, f"b-{i}"), user_id="user-b")
        for i in range(2)
    ]

    a_list = await svc.list_entries(user_id="user-a")
    b_list = await svc.list_entries(user_id="user-b")
    assert {e.id for e in a_list} == set(a_ids)
    assert {e.id for e in b_list} == set(b_ids)

    # Cross-user update / delete are no-ops.
    assert await svc.update_entry_status(a_ids[0], "pending_review", user_id="user-b") == 0
    assert await svc.delete_entry(b_ids[0], user_id="user-a") == 0

    # Same operations with the right user_id work.
    assert await svc.update_entry_status(a_ids[0], "pending_review", user_id="user-a") == 1
    assert await svc.delete_entry(b_ids[0], user_id="user-b") == 1


async def test_summary_and_balance_scoped(store: Store) -> None:
    svc = FinanceService(store)

    await svc.add_entry(
        FinancialEntry(
            id=None, type="income", amount=1000.0, currency="BRL",
            category="salario", description="salário a", date="2026-04-15",
            source="manual",
        ),
        user_id="user-a",
    )
    await svc.add_entry(
        FinancialEntry(
            id=None, type="income", amount=500.0, currency="BRL",
            category="salario", description="salário b", date="2026-04-15",
            source="manual",
        ),
        user_id="user-b",
    )

    summary_a = await svc.get_monthly_summary(4, 2026, user_id="user-a")
    summary_b = await svc.get_monthly_summary(4, 2026, user_id="user-b")
    assert summary_a["income"] == 1000.0
    assert summary_b["income"] == 500.0

    balance_a = await svc.get_overall_balance(user_id="user-a")
    assert balance_a["total_income"] == 1000.0


async def test_recurring_isolation(store: Store) -> None:
    svc = FinanceService(store)

    rule = RecurringRule(
        id=None, type="expense", amount=100.0, category="moradia",
        description="aluguel", day_of_month=5, frequency="monthly",
        start_date="2026-01-01",
    )
    a_id = await svc.add_recurring(rule, user_id="user-a")
    b_id = await svc.add_recurring(rule, user_id="user-b")

    a_rules = await svc.list_recurring(user_id="user-a")
    b_rules = await svc.list_recurring(user_id="user-b")
    assert {r.id for r in a_rules} == {a_id}
    assert {r.id for r in b_rules} == {b_id}

    assert await svc.deactivate_recurring(a_id, user_id="user-b") == 0
    assert await svc.deactivate_recurring(a_id, user_id="user-a") == 1
