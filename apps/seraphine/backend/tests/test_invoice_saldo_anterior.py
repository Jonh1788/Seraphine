"""A fatura guarda o que a conferência precisa.

`previous_balance` e `payments_total` ficam gravados porque a reconferência
da reimportação confere contra o BANCO, não contra a leitura nova — e o
pagamento não é lançamento, então não dá para somá-lo depois.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest_asyncio

from core_db import Store
from mod_finance import schema as finance_schema
from mod_finance.models import CardInvoice
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


def _legacy(tmp_path: Path) -> sqlite3.Connection:
    """Banco no formato anterior: card_invoices sem as duas colunas."""
    conn = sqlite3.connect(tmp_path / "legacy.sqlite")
    conn.executescript(
        """
        CREATE TABLE card_invoices (
          id INTEGER PRIMARY KEY AUTOINCREMENT, card TEXT NOT NULL,
          closing_date TEXT, due_date TEXT, paid_date TEXT, total REAL,
          status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, user_id TEXT
        );
        INSERT INTO card_invoices (card, due_date, total, status, created_at)
        VALUES ('C6', '2026-08-01', 5438.88, 'needs_review', '');
        """
    )
    conn.commit()
    return conn


def test_migracao_adiciona_as_duas_colunas_sem_perder_linha(tmp_path: Path) -> None:
    conn = _legacy(tmp_path)
    finance_schema.migrate(conn)
    cols = {r[1] for r in conn.execute("PRAGMA table_info(card_invoices)")}
    assert "previous_balance" in cols
    assert "payments_total" in cols
    assert conn.execute("SELECT card, total FROM card_invoices").fetchall() == [
        ("C6", 5438.88)
    ]


def test_migracao_roda_duas_vezes(tmp_path: Path) -> None:
    conn = _legacy(tmp_path)
    finance_schema.migrate(conn)
    finance_schema.migrate(conn)
    cols = {r[1] for r in conn.execute("PRAGMA table_info(card_invoices)")}
    assert {"previous_balance", "payments_total"} <= cols


def test_fatura_legada_fica_com_saldo_desconhecido(tmp_path: Path) -> None:
    """NULL, não zero. Zero afirmaria que a fatura abriu zerada."""
    conn = _legacy(tmp_path)
    finance_schema.migrate(conn)
    row = conn.execute(
        "SELECT previous_balance, payments_total FROM card_invoices"
    ).fetchone()
    assert row == (None, None)


def test_card_invoice_tem_os_dois_campos_com_default_nulo() -> None:
    inv = CardInvoice(
        id=1, card="C6", closing_date=None, due_date="2026-08-01",
        paid_date=None, total=5438.88, status="open",
    )
    assert inv.previous_balance is None
    assert inv.payments_total is None


async def test_create_invoice_grava_os_dois(svc: FinanceService) -> None:
    inv_id = await svc.create_invoice(
        card="C6", closing_date="2026-07-24", due_date="2026-08-01",
        total=5438.88, previous_balance=1373.63, payments_total=2083.63,
    )
    inv = await svc.get_invoice(inv_id)
    assert inv is not None
    assert inv.previous_balance == 1373.63
    assert inv.payments_total == 2083.63


async def test_saldo_anterior_zero_e_gravado_como_zero(svc: FinanceService) -> None:
    """Primeira fatura de um cartão. Zero explícito não pode virar NULL."""
    inv_id = await svc.create_invoice(
        card="C6", closing_date=None, due_date="2026-08-01",
        total=100.0, previous_balance=0.0, payments_total=0.0,
    )
    inv = await svc.get_invoice(inv_id)
    assert inv is not None
    assert inv.previous_balance == 0.0
    assert inv.payments_total == 0.0


async def test_sem_informar_fica_nulo(svc: FinanceService) -> None:
    inv_id = await svc.create_invoice(
        card="C6", closing_date=None, due_date="2026-08-01", total=100.0,
    )
    inv = await svc.get_invoice(inv_id)
    assert inv is not None
    assert inv.previous_balance is None
    assert inv.payments_total is None
