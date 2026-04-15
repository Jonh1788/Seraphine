from __future__ import annotations

import pytest
import pytest_asyncio

from core_db import Store
from mod_finance import schema as finance_schema
from mod_finance.models import FinancialEntry, RecurringRule
from mod_finance.service import FinanceService


@pytest_asyncio.fixture
async def svc(tmp_path):
    store = Store(tmp_path / "finance.sqlite")
    store.register_migrator("mod_finance", finance_schema.migrate)
    await store.ensure_schema()
    service = FinanceService(store)
    yield service
    await service.aclose()
    await store.aclose()


# ------------------------------------------------------------------
# Schema
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ensure_tables(svc: FinanceService):
    """Schema is set up by the fixture and yields empty lists."""
    entries = await svc.list_entries()
    assert entries == []
    rules = await svc.list_recurring()
    assert rules == []


# ------------------------------------------------------------------
# Entries CRUD
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_add_and_list_entry(svc: FinanceService):
    entry = FinancialEntry(
        id=None,
        type="expense",
        amount=150.0,
        currency="BRL",
        category="alimentacao",
        description="Supermercado",
        date="2026-04-01",
        source="manual",
    )
    eid = await svc.add_entry(entry)
    assert isinstance(eid, int) and eid > 0

    rows = await svc.list_entries()
    assert len(rows) == 1
    assert rows[0].id == eid
    assert rows[0].amount == 150.0
    assert rows[0].category == "alimentacao"
    assert rows[0].created_at is not None


@pytest.mark.asyncio
async def test_list_with_filters(svc: FinanceService):
    entries = [
        FinancialEntry(None, "expense", 100, "BRL", "moradia", "Aluguel", "2026-04-05", "manual"),
        FinancialEntry(None, "expense", 50, "BRL", "transporte", "Uber", "2026-04-10", "chat"),
        FinancialEntry(None, "income", 5000, "BRL", "salario", "Salario", "2026-04-01", "manual"),
        FinancialEntry(None, "expense", 200, "BRL", "moradia", "Condominio", "2026-03-05", "manual"),
    ]
    for e in entries:
        await svc.add_entry(e)

    # filter by month+year
    april = await svc.list_entries(month=4, year=2026)
    assert len(april) == 3

    march = await svc.list_entries(month=3, year=2026)
    assert len(march) == 1

    # filter by category
    moradia = await svc.list_entries(category="moradia")
    assert len(moradia) == 2

    # filter by type
    income = await svc.list_entries(type="income")
    assert len(income) == 1
    assert income[0].amount == 5000

    # combined filter
    april_moradia = await svc.list_entries(month=4, year=2026, category="moradia")
    assert len(april_moradia) == 1


@pytest.mark.asyncio
async def test_update_status(svc: FinanceService):
    entry = FinancialEntry(
        None, "expense", 99.0, "BRL", "outros", "Teste", "2026-04-01", "chat",
        status="pending_review",
    )
    eid = await svc.add_entry(entry)

    rows = await svc.list_entries(status="pending_review")
    assert len(rows) == 1

    await svc.update_entry_status(eid, "confirmed")

    rows = await svc.list_entries(status="pending_review")
    assert len(rows) == 0

    rows = await svc.list_entries(status="confirmed")
    assert len(rows) == 1
    assert rows[0].id == eid


@pytest.mark.asyncio
async def test_delete_entry(svc: FinanceService):
    eid = await svc.add_entry(
        FinancialEntry(None, "expense", 10, "BRL", "lazer", "Netflix", "2026-04-01", "manual"),
    )
    assert len(await svc.list_entries()) == 1

    await svc.delete_entry(eid)
    assert len(await svc.list_entries()) == 0


# ------------------------------------------------------------------
# Monthly summary
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_monthly_summary(svc: FinanceService):
    entries = [
        FinancialEntry(None, "income", 5000, "BRL", "salario", "Salario", "2026-04-01", "manual"),
        FinancialEntry(None, "income", 2000, "BRL", "freelance", "Freela", "2026-04-15", "manual"),
        FinancialEntry(None, "expense", 1500, "BRL", "moradia", "Aluguel", "2026-04-05", "manual"),
        FinancialEntry(None, "expense", 800, "BRL", "alimentacao", "Mercado", "2026-04-10", "manual"),
        # pending_review should NOT count
        FinancialEntry(None, "expense", 999, "BRL", "outros", "Pendente", "2026-04-12", "manual", status="pending_review"),
        # different month
        FinancialEntry(None, "expense", 300, "BRL", "transporte", "Combustivel", "2026-03-20", "manual"),
    ]
    for e in entries:
        await svc.add_entry(e)

    summary = await svc.get_monthly_summary(4, 2026)
    assert summary["income"] == 7000.0
    assert summary["expenses"] == 2300.0
    assert summary["balance"] == 4700.0

    cats = {c["category"]: c for c in summary["by_category"]}
    assert cats["moradia"]["total"] == 1500.0
    assert cats["moradia"]["count"] == 1
    assert cats["alimentacao"]["total"] == 800.0
    # pending_review entry should be excluded
    assert "outros" not in cats


# ------------------------------------------------------------------
# Recurring rules
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_add_recurring(svc: FinanceService):
    rule = RecurringRule(
        id=None,
        type="expense",
        amount=1500,
        category="moradia",
        description="Aluguel",
        day_of_month=5,
        frequency="monthly",
        start_date="2026-01-01",
    )
    rid = await svc.add_recurring(rule)
    assert isinstance(rid, int) and rid > 0

    rules = await svc.list_recurring()
    assert len(rules) == 1
    assert rules[0].id == rid
    assert rules[0].amount == 1500
    assert rules[0].active is True
    assert rules[0].created_at is not None


@pytest.mark.asyncio
async def test_list_recurring_active_only(svc: FinanceService):
    r1 = RecurringRule(None, "expense", 100, "transporte", "VT", 1, "monthly", "2026-01-01")
    r2 = RecurringRule(None, "expense", 200, "lazer", "Spotify", 15, "monthly", "2026-01-01")
    rid1 = await svc.add_recurring(r1)
    rid2 = await svc.add_recurring(r2)

    await svc.deactivate_recurring(rid1)

    active = await svc.list_recurring(active_only=True)
    assert len(active) == 1
    assert active[0].id == rid2

    all_rules = await svc.list_recurring(active_only=False)
    assert len(all_rules) == 2


@pytest.mark.asyncio
async def test_deactivate_recurring(svc: FinanceService):
    rule = RecurringRule(None, "income", 5000, "salario", "Salario", 1, "monthly", "2026-01-01")
    rid = await svc.add_recurring(rule)

    await svc.deactivate_recurring(rid)

    rules = await svc.list_recurring(active_only=False)
    assert len(rules) == 1
    assert rules[0].active is False


# ------------------------------------------------------------------
# Deduplication
# ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_dedup_same_date_amount_type(svc: FinanceService):
    """Adding an entry with same date+amount+type+currency returns existing ID."""
    entry = FinancialEntry(
        id=None, type="expense", amount=150.0, currency="BRL",
        category="alimentacao", description="Supermercado",
        date="2026-04-10", source="pdf",
    )
    id1 = await svc.add_entry(entry)

    # Same date, amount, type, currency but different description/source
    dup = FinancialEntry(
        id=None, type="expense", amount=150.0, currency="BRL",
        category="outros", description="Compra supermercado",
        date="2026-04-10", source="email",
    )
    id2 = await svc.add_entry(dup)

    assert id1 == id2, "Duplicate entry should return existing ID"
    entries = await svc.list_entries()
    assert len(entries) == 1


@pytest.mark.asyncio
async def test_dedup_different_amount_passes(svc: FinanceService):
    """Different amounts on same date are NOT duplicates."""
    e1 = FinancialEntry(
        id=None, type="expense", amount=150.0, currency="BRL",
        category="alimentacao", description="Compra A",
        date="2026-04-10", source="pdf",
    )
    e2 = FinancialEntry(
        id=None, type="expense", amount=200.0, currency="BRL",
        category="alimentacao", description="Compra B",
        date="2026-04-10", source="pdf",
    )
    id1 = await svc.add_entry(e1)
    id2 = await svc.add_entry(e2)

    assert id1 != id2
    entries = await svc.list_entries()
    assert len(entries) == 2


@pytest.mark.asyncio
async def test_dedup_different_date_passes(svc: FinanceService):
    """Same amount on different dates are NOT duplicates."""
    e1 = FinancialEntry(
        id=None, type="expense", amount=150.0, currency="BRL",
        category="alimentacao", description="Compra",
        date="2026-04-10", source="pdf",
    )
    e2 = FinancialEntry(
        id=None, type="expense", amount=150.0, currency="BRL",
        category="alimentacao", description="Compra",
        date="2026-04-11", source="pdf",
    )
    id1 = await svc.add_entry(e1)
    id2 = await svc.add_entry(e2)

    assert id1 != id2
    entries = await svc.list_entries()
    assert len(entries) == 2
