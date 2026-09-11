"""A fatura como entidade, e a migração que a introduz.

O que se prende aqui é que um banco que já existe ganha a coluna e a
tabela sem perder linha — o financeiro do usuário tem lançamentos reais.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from mod_finance import schema as finance_schema
from mod_finance.models import CardInvoice, FinancialEntry


def _legacy_db(tmp_path: Path) -> sqlite3.Connection:
    """Um banco no formato anterior: sem card_invoices, sem invoice_id."""
    conn = sqlite3.connect(tmp_path / "legacy.sqlite")
    conn.executescript(
        """
        CREATE TABLE financial_entries (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          type          TEXT NOT NULL,
          amount        REAL NOT NULL,
          currency      TEXT NOT NULL DEFAULT 'BRL',
          category      TEXT NOT NULL,
          description   TEXT NOT NULL,
          date          TEXT NOT NULL,
          source        TEXT NOT NULL,
          recurring_id  INTEGER,
          status        TEXT NOT NULL DEFAULT 'confirmed',
          created_at    TEXT NOT NULL,
          user_id       TEXT
        );
        INSERT INTO financial_entries
          (type, amount, currency, category, description, date, source, status, created_at)
        VALUES
          ('expense', 240.0, 'BRL', 'mercado', 'Compra antiga', '2026-07-15', 'chat', 'confirmed', '2026-07-15T10:00:00Z');
        """
    )
    conn.commit()
    return conn


def test_migracao_cria_a_tabela_de_faturas(tmp_path: Path) -> None:
    conn = _legacy_db(tmp_path)
    finance_schema.migrate(conn)
    tabelas = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert "card_invoices" in tabelas


def test_a_fatura_tem_o_ciclo_inteiro(tmp_path: Path) -> None:
    """Prende as doze colunas: sem due_date/paid_date a fatura não tem mês, sem
    total não há conferência contra o PDF, e sem `source_hash` o reencontro
    volta a depender do que o LLM leu — que é o que produziu cinco rounds de
    faturas duplicadas ou absorvidas em silêncio. `previous_balance` e
    `payments_total` são o que falta para a conferência ser a conta da fatura
    (saldo anterior − pagamentos + compras) em vez da soma solta das
    transações."""
    conn = _legacy_db(tmp_path)
    finance_schema.migrate(conn)
    cols = {r[1] for r in conn.execute("PRAGMA table_info(card_invoices)")}
    assert cols == {
        "id", "card", "closing_date", "due_date", "paid_date",
        "total", "status", "created_at", "user_id", "source_hash",
        "previous_balance", "payments_total",
    }


def test_a_coluna_do_hash_chega_por_alter_em_banco_que_ja_tem_faturas(
    tmp_path: Path,
) -> None:
    """`card_invoices` nasceu na branch anterior: existe banco com a tabela e
    sem a coluna. O ALTER tem de ser idempotente (rodar duas vezes é o normal:
    toda subida chama `migrate`) e não pode perder fatura."""
    conn = _legacy_db(tmp_path)
    finance_schema.migrate(conn)
    conn.execute(
        "INSERT INTO card_invoices (card, created_at)"
        " VALUES ('C6', '2026-08-03T10:00:00Z')"
    )
    conn.commit()

    finance_schema.migrate(conn)   # a segunda subida
    (card, source_hash) = conn.execute(
        "SELECT card, source_hash FROM card_invoices"
    ).fetchone()
    assert card == "C6"
    assert source_hash is None, "fatura que já existia não ganha hash inventado"


def test_fatura_recusa_status_fora_do_ciclo(tmp_path: Path) -> None:
    """O CHECK é o único lugar do projeto onde os três status são mecanizados."""
    conn = _legacy_db(tmp_path)
    finance_schema.migrate(conn)
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO card_invoices (card, status, created_at)"
            " VALUES ('C6', 'qualquer', '2026-08-03T10:00:00Z')"
        )


def test_fatura_nasce_aberta(tmp_path: Path) -> None:
    conn = _legacy_db(tmp_path)
    finance_schema.migrate(conn)
    conn.execute(
        "INSERT INTO card_invoices (card, created_at)"
        " VALUES ('C6', '2026-08-03T10:00:00Z')"
    )
    (status,) = conn.execute("SELECT status FROM card_invoices").fetchone()
    assert status == "open"


def test_invoice_id_aponta_para_a_fatura(tmp_path: Path) -> None:
    """A coluna é uma FK de verdade: o banco recusa lançamento preso a
    fatura que não existe. Só vale com PRAGMA foreign_keys ON, que é o que
    core_db.Store liga em toda conexão."""
    conn = _legacy_db(tmp_path)
    finance_schema.migrate(conn)
    fks = {r[2] for r in conn.execute("PRAGMA foreign_key_list(financial_entries)")}
    assert "card_invoices" in fks

    conn.execute("PRAGMA foreign_keys = ON")
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("UPDATE financial_entries SET invoice_id = 999")


def test_migracao_adiciona_invoice_id_sem_perder_linha(tmp_path: Path) -> None:
    conn = _legacy_db(tmp_path)
    finance_schema.migrate(conn)
    cols = {r[1] for r in conn.execute("PRAGMA table_info(financial_entries)")}
    assert "invoice_id" in cols
    linhas = conn.execute("SELECT description, date FROM financial_entries").fetchall()
    assert linhas == [("Compra antiga", "2026-07-15")]


def test_migracao_roda_duas_vezes_sem_erro(tmp_path: Path) -> None:
    conn = _legacy_db(tmp_path)
    finance_schema.migrate(conn)
    finance_schema.migrate(conn)
    cols = {r[1] for r in conn.execute("PRAGMA table_info(financial_entries)")}
    assert "invoice_id" in cols


def test_lancamento_existente_fica_sem_fatura(tmp_path: Path) -> None:
    """Ninguém vira fatura retroativamente: quem já estava fica avulso."""
    conn = _legacy_db(tmp_path)
    finance_schema.migrate(conn)
    (invoice_id,) = conn.execute("SELECT invoice_id FROM financial_entries").fetchone()
    assert invoice_id is None


def test_card_invoice_dispensa_created_at_e_user_id() -> None:
    """Prende os nomes dos campos do ciclo e quais têm default. Construir
    sem os dois últimos tem de funcionar — é como o serviço a monta."""
    inv = CardInvoice(
        id=1, card="C6", closing_date="2026-08-03", due_date="2026-08-10",
        paid_date=None, total=5438.88, status="open",
    )
    assert inv.created_at is None
    assert inv.user_id is None


def test_entry_aceita_invoice_id_e_o_default_e_nulo() -> None:
    e = FinancialEntry(
        id=1, type="expense", amount=240.0, currency="BRL", category="mercado",
        description="x", date="2026-07-15", source="pdf",
    )
    assert e.invoice_id is None
