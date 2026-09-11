"""As consultas mensais lendo o mês de caixa.

O teste que mais importa é o primeiro: um financeiro sem faturas tem de
responder exatamente como antes. Todo o resto do app depende disso.
"""

from __future__ import annotations

import asyncio

import pytest
import pytest_asyncio

from core_db import Store
from mod_finance import schema as finance_schema
from mod_finance.models import FinancialEntry
from mod_finance.service import FinanceService


@pytest_asyncio.fixture
async def svc(tmp_path):
    """Mesma fixture de tests/test_finance_service.py:13-21."""
    store = Store(tmp_path / "finance.sqlite")
    store.register_migrator("mod_finance", finance_schema.migrate)
    await store.ensure_schema()
    service = FinanceService(store)
    yield service
    await service.aclose()
    await store.aclose()


async def _fatura(svc: FinanceService, **kw) -> int:
    """Insere uma fatura direto, sem depender do CRUD da Task 4."""
    def _work() -> int:
        with svc._store._connect() as conn:
            cur = conn.execute(
                "INSERT INTO card_invoices"
                " (card, closing_date, due_date, paid_date, total, status, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?, '')",
                (kw.get("card", "C6"), kw.get("closing_date"), kw.get("due_date"),
                 kw.get("paid_date"), kw.get("total"), kw.get("status", "open")),
            )
            return int(cur.lastrowid)
    return await asyncio.to_thread(_work)


async def _lancamento(svc: FinanceService, date: str, amount: float,
                      invoice_id: int | None = None,
                      user_id: str | None = None) -> None:
    def _work() -> None:
        with svc._store._connect() as conn:
            conn.execute(
                "INSERT INTO financial_entries"
                " (type, amount, currency, category, description, date, source,"
                "  status, created_at, invoice_id, user_id)"
                " VALUES ('expense', ?, 'BRL', 'outros', 'x', ?, 'pdf',"
                "         'confirmed', '', ?, ?)",
                (amount, date, invoice_id, user_id),
            )
    await asyncio.to_thread(_work)


async def test_sem_faturas_o_resumo_responde_como_antes(svc: FinanceService) -> None:
    """A garantia de não-regressão do financeiro inteiro."""
    await _lancamento(svc, "2026-07-15", 240.0)
    resumo = await svc.get_monthly_summary(7, 2026)
    assert resumo["expenses"] == 240.0
    assert await svc.get_monthly_summary(8, 2026) != resumo


async def test_compra_de_julho_em_fatura_de_agosto_pesa_em_agosto(
    svc: FinanceService,
) -> None:
    inv = await _fatura(svc, due_date="2026-08-10")
    await _lancamento(svc, "2026-07-15", 240.0, inv)

    assert (await svc.get_monthly_summary(7, 2026))["expenses"] == 0
    assert (await svc.get_monthly_summary(8, 2026))["expenses"] == 240.0
    # A quebra por categoria é OUTRA consulta, e tem de concordar com o total:
    # o estrago silencioso seria o mês dizer agosto e a categoria dizer julho.
    assert (await svc.get_monthly_summary(8, 2026))["by_category"] == [
        {"category": "outros", "total": 240.0, "count": 1}
    ]
    assert (await svc.get_monthly_summary(7, 2026))["by_category"] == []


async def test_pagar_em_setembro_tira_de_agosto(svc: FinanceService) -> None:
    inv = await _fatura(svc, due_date="2026-08-10", paid_date="2026-09-05", status="paid")
    await _lancamento(svc, "2026-07-15", 240.0, inv)

    assert (await svc.get_monthly_summary(8, 2026))["expenses"] == 0
    assert (await svc.get_monthly_summary(9, 2026))["expenses"] == 240.0


async def test_resumo_separa_realizado_de_previsto(svc: FinanceService) -> None:
    aberta = await _fatura(svc, due_date="2026-08-10")
    paga = await _fatura(svc, due_date="2026-08-10", paid_date="2026-08-10", status="paid")
    await _lancamento(svc, "2026-07-15", 100.0, aberta)
    await _lancamento(svc, "2026-07-16", 30.0, paga)

    resumo = await svc.get_monthly_summary(8, 2026)
    assert resumo["forecast"] == 100.0
    assert resumo["realized"] == 30.0
    # Os dois são partes do mesmo total, não alternativas a ele.
    assert resumo["expenses"] == 130.0


async def test_o_total_do_mes_soma_previsto_e_realizado(svc: FinanceService) -> None:
    """Excluir o previsto faria agosto parecer ótimo até o dia do pagamento."""
    aberta = await _fatura(svc, due_date="2026-08-10")
    await _lancamento(svc, "2026-07-15", 100.0, aberta)

    resumo = await svc.get_monthly_summary(8, 2026)
    assert resumo["expenses"] == 100.0


async def test_lancamento_avulso_conta_como_realizado(svc: FinanceService) -> None:
    await _lancamento(svc, "2026-08-12", 50.0)
    resumo = await svc.get_monthly_summary(8, 2026)
    assert resumo["realized"] == 50.0
    assert resumo["forecast"] == 0


async def test_listar_por_mes_usa_o_mes_de_caixa(svc: FinanceService) -> None:
    inv = await _fatura(svc, due_date="2026-08-10")
    await _lancamento(svc, "2026-07-15", 240.0, inv)

    de_julho = await svc.list_entries(month=7, year=2026)
    de_agosto = await svc.list_entries(month=8, year=2026)
    assert de_julho == []
    assert len(de_agosto) == 1
    # A DATA não mudou: a compra continua sendo de 15/07.
    assert de_agosto[0].date == "2026-07-15"


async def test_listar_por_data_da_compra_ignora_o_mes_de_caixa(
    svc: FinanceService,
) -> None:
    """A outra pergunta: "o que eu comprei naquela semana".

    É o que o calendário precisa — ele posiciona cada lançamento por `date` —
    e o mês de caixa não serve para respondê-la: a semana de 28/06 a 04/07
    não encosta em agosto, então a compra numa fatura que vence em 10/08
    nunca seria buscada e sumiria do dia em que aconteceu.
    """
    inv = await _fatura(svc, due_date="2026-08-10")
    await _lancamento(svc, "2026-07-01", 240.0, inv)
    await _lancamento(svc, "2026-07-06", 50.0)   # fora da semana, sem fatura

    da_semana = await svc.list_entries(
        date_from="2026-06-28", date_to="2026-07-04",
    )
    assert [e.amount for e in da_semana] == [240.0]

    # Extremos incluídos, dos dois lados — o dia da ponta é o que some quando
    # a comparação vira estrita, e some em silêncio.
    assert len(await svc.list_entries(date_from="2026-07-01", date_to="2026-07-01")) == 1
    assert len(await svc.list_entries(date_from="2026-07-02", date_to="2026-07-06")) == 1


async def test_pagar_a_fatura_nao_move_a_data_da_compra(svc: FinanceService) -> None:
    """O mês de caixa anda; a data da compra não. Senão a compra de julho
    trocaria de semana no dia em que a fatura fosse paga."""
    inv = await _fatura(svc, due_date="2026-08-10")
    await _lancamento(svc, "2026-07-01", 240.0, inv)
    await svc.mark_invoice_paid(inv, "2026-09-05")

    assert len(await svc.list_entries(date_from="2026-06-28", date_to="2026-07-04")) == 1
    assert await svc.list_entries(date_from="2026-09-01", date_to="2026-09-30") == []


async def test_data_fora_do_iso_no_filtro_e_erro_duro(svc: FinanceService) -> None:
    """Descartar em silêncio devolveria "não há lançamentos" para um período
    cheio deles: a comparação é de string, e `01/07/2026` não casa com nada."""
    with pytest.raises(ValueError):
        await svc.list_entries(date_from="01/07/2026")
    with pytest.raises(ValueError):
        await svc.list_entries(date_to="2026-13-01")


async def test_listar_por_ano_usa_o_mes_de_caixa(svc: FinanceService) -> None:
    """O filtro só-por-ano é OUTRO ramo de SQL, e tem de virar o ano junto.

    `GET /finance/entries?year=2026` chega aqui sem mês e cai em
    `substr(cash_month_expr(), 1, 4)`. Uma compra de dezembro numa fatura
    paga em janeiro sai de 2026 e entra em 2027: se este ramo lesse
    `substr(e.date, 1, 4)`, o mesmo lançamento estaria em 2026 pelo ano e em
    2027 pelo mês — duas respostas para a mesma pergunta na mesma tela.
    """
    inv = await _fatura(svc, due_date="2027-01-10",
                        paid_date="2027-01-08", status="paid")
    await _lancamento(svc, "2026-12-20", 240.0, inv)

    assert await svc.list_entries(year=2026) == []
    (lido,) = await svc.list_entries(year=2027)
    # A DATA não mudou: a compra continua sendo de 20/12.
    assert lido.date == "2026-12-20"


async def test_o_filtro_de_usuario_sobrevive_ao_join(svc: FinanceService) -> None:
    """`user_id` existe nas DUAS tabelas.

    Sem o prefixo `e.` isto estoura em `ambiguous column name: user_id` já no
    prepare, com ou sem dados — e é o caminho que a Aura usa em produção. Os
    outros testes deste arquivo passam por fora dele, porque Seraphine é
    single-tenant e manda `user_id=None`.
    """
    inv = await _fatura(svc, due_date="2026-08-10")
    await _lancamento(svc, "2026-07-15", 100.0, inv, user_id="u1")
    # De outro usuário, e de agosto pela data: se o filtro cair, entra na soma.
    await _lancamento(svc, "2026-08-03", 70.0, None, user_id="u2")

    resumo = await svc.get_monthly_summary(8, 2026, user_id="u1")
    assert resumo["expenses"] == 100.0
    assert resumo["by_category"] == [
        {"category": "outros", "total": 100.0, "count": 1}
    ]

    de_u1 = await svc.list_entries(month=8, year=2026, user_id="u1")
    assert [e.amount for e in de_u1] == [100.0]


async def test_o_lancamento_guarda_e_devolve_a_fatura(svc: FinanceService) -> None:
    """O caminho inteiro de `invoice_id`: grava, lê de volta, e o mês obedece.

    Sem o INSERT nomeando a coluna, quem ligasse um lançamento à fatura teria o
    valor descartado em silêncio, e a regra do mês de caixa nunca sairia do
    primeiro ramo.
    """
    inv = await _fatura(svc, due_date="2026-08-10")
    await svc.add_entry(FinancialEntry(
        id=None, type="expense", amount=42.0, currency="BRL",
        category="outros", description="compra na fatura",
        date="2026-07-15", source="pdf", invoice_id=inv,
    ))

    de_julho = await svc.list_entries(month=7, year=2026)
    (lido,) = await svc.list_entries(month=8, year=2026)
    assert de_julho == []
    assert lido.invoice_id == inv
    assert lido.date == "2026-07-15"


async def test_lancamento_avulso_volta_sem_fatura(svc: FinanceService) -> None:
    await svc.add_entry(FinancialEntry(
        id=None, type="expense", amount=42.0, currency="BRL",
        category="outros", description="pix", date="2026-08-12", source="chat",
    ))

    (lido,) = await svc.list_entries(month=8, year=2026)
    assert lido.invoice_id is None
