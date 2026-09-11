"""A regra do mês de caixa, exercitada contra SQLite de verdade.

Testar a string do SQL não prova nada — o que importa é o que o banco
responde. Cada caso monta um lançamento real e pergunta em que mês ele cai.

O banco vem de `finance_schema.migrate`, não de um CREATE TABLE escrito à
mão aqui: a expressão é texto SQL puro referenciando nomes de coluna, então
um schema de mentira deixaria estes testes verdes enquanto renomear
`invoice_id`, `paid_date` ou `due_date` quebraria todas as consultas reais.
"""

from __future__ import annotations

import sqlite3

from mod_finance import schema as finance_schema
from mod_finance.cash_month import CASH_MONTH_JOIN, cash_month_expr


def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    finance_schema.migrate(conn)
    return conn


def _mes(conn: sqlite3.Connection, descricao: str) -> str | None:
    row = conn.execute(
        f"SELECT {cash_month_expr()} FROM financial_entries e"
        f"{CASH_MONTH_JOIN} WHERE e.description = ?",
        (descricao,),
    ).fetchone()
    return row[0]


def test_lancamento_avulso_cai_no_mes_da_propria_data() -> None:
    """O caso de longe mais comum: pix, dinheiro, transferência.
    Se este mudar, todo o financeiro existente mudou junto."""
    conn = _db()
    conn.execute(
        "INSERT INTO financial_entries"
        " (type, amount, category, description, date, source, created_at, invoice_id)"
        " VALUES ('expense', 50.0, 'mercado', 'Pix', '2026-07-15', 'chat', '', NULL)"
    )
    assert _mes(conn, "Pix") == "2026-07"


def test_fatura_em_aberto_usa_o_vencimento() -> None:
    conn = _db()
    conn.execute(
        "INSERT INTO card_invoices (id, card, due_date, paid_date, status, created_at)"
        " VALUES (1, 'C6', '2026-08-10', NULL, 'open', '')"
    )
    conn.execute(
        "INSERT INTO financial_entries"
        " (type, amount, category, description, date, source, created_at, invoice_id)"
        " VALUES ('expense', 240.0, 'mercado', 'Mercado', '2026-07-15', 'chat', '', 1)"
    )
    # A compra é de julho e continua sendo. O mês de CAIXA é agosto.
    assert _mes(conn, "Mercado") == "2026-08"


def test_fatura_paga_usa_a_data_do_pagamento() -> None:
    conn = _db()
    conn.execute(
        "INSERT INTO card_invoices (id, card, due_date, paid_date, status, created_at)"
        " VALUES (1, 'C6', '2026-08-10', '2026-08-10', 'paid', '')"
    )
    conn.execute(
        "INSERT INTO financial_entries"
        " (type, amount, category, description, date, source, created_at, invoice_id)"
        " VALUES ('expense', 240.0, 'mercado', 'Mercado', '2026-07-15', 'chat', '', 1)"
    )
    assert _mes(conn, "Mercado") == "2026-08"


def test_pagar_atrasado_move_o_gasto_de_mes() -> None:
    """A feature, não efeito colateral: pagou em setembro, saiu em setembro."""
    conn = _db()
    conn.execute(
        "INSERT INTO card_invoices (id, card, due_date, paid_date, status, created_at)"
        " VALUES (1, 'C6', '2026-08-10', '2026-09-05', 'paid', '')"
    )
    conn.execute(
        "INSERT INTO financial_entries"
        " (type, amount, category, description, date, source, created_at, invoice_id)"
        " VALUES ('expense', 240.0, 'mercado', 'Mercado', '2026-07-15', 'chat', '', 1)"
    )
    assert _mes(conn, "Mercado") == "2026-09"


def test_pagamento_vence_o_vencimento() -> None:
    """Com as duas datas presentes, quem manda é o pagamento — e aqui ele vem
    ANTES do vencimento, o único caso do arquivo assim. É o que separa a regra
    de um `MAX(due, paid)` ou de um `COALESCE(due, paid)`, que acertariam
    todos os outros casos do arquivo."""
    conn = _db()
    conn.execute(
        "INSERT INTO card_invoices (id, card, due_date, paid_date, status, created_at)"
        " VALUES (1, 'C6', '2026-08-10', '2026-07-30', 'paid', '')"
    )
    conn.execute(
        "INSERT INTO financial_entries"
        " (type, amount, category, description, date, source, created_at, invoice_id)"
        " VALUES ('expense', 240.0, 'mercado', 'X', '2026-07-15', 'chat', '', 1)"
    )
    assert _mes(conn, "X") == "2026-07"


def test_fatura_sem_vencimento_nao_cai_em_mes_nenhum() -> None:
    """Sem vencimento e sem pagamento não existe mês onde colocar.
    NULL é deliberado: inventar um mês seria pior."""
    conn = _db()
    conn.execute(
        "INSERT INTO card_invoices (id, card, due_date, paid_date, status, created_at)"
        " VALUES (1, 'C6', NULL, NULL, 'needs_review', '')"
    )
    conn.execute(
        "INSERT INTO financial_entries"
        " (type, amount, category, description, date, source, created_at, invoice_id)"
        " VALUES ('expense', 240.0, 'mercado', 'Ilegivel', '2026-07-15', 'chat', '', 1)"
    )
    assert _mes(conn, "Ilegivel") is None


def test_filtrar_por_um_mes_nao_arrasta_os_sem_mes() -> None:
    """O balde de NULL: um lançamento sem mês não pode aparecer em mês nenhum.

    O mês perguntado é o da COMPRA de propósito — é exatamente onde um
    fallback ingênuo (`ELSE substr(e.date, 1, 7)`) largaria o lançamento.
    Perguntar por um mês qualquer devolveria vazio até com a regra quebrada,
    e o teste passaria pelo motivo errado.
    """
    conn = _db()
    conn.execute(
        "INSERT INTO card_invoices (id, card, due_date, paid_date, status, created_at)"
        " VALUES (1, 'C6', NULL, NULL, 'needs_review', '')"
    )
    conn.execute(
        "INSERT INTO financial_entries"
        " (type, amount, category, description, date, source, created_at, invoice_id)"
        " VALUES ('expense', 240.0, 'mercado', 'Ilegivel', '2026-07-15', 'chat', '', 1)"
    )
    rows = conn.execute(
        f"SELECT e.description FROM financial_entries e{CASH_MONTH_JOIN}"
        f" WHERE {cash_month_expr()} = ?",
        ("2026-07",),
    ).fetchall()
    assert rows == []
