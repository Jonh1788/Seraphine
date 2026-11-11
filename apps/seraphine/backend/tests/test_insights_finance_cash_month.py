"""O analisador de finanças dos insights, contra o mês de caixa.

`_finance_weekday_outliers` agrupa pelo dia da semana da COMPRA e carimba o
insight com `period`. `list_entries(month=, year=)` responde outra pergunta:
em que mês o dinheiro sai do caixa, que para uma compra no cartão é o mês do
vencimento ou do pagamento. Pedir uma e usar a outra troca o CONJUNTO — o
insight de agosto sai calculado sobre compras de julho, e as compras de julho
numa fatura ainda não paga faltam na análise do próprio julho.

Mesma forma do que já foi consertado em `insights/weekly.py`, e por isso o
serviço aqui é o REAL: um fake de `list_entries` decidiria por conta própria
o que é "o mês", que é exatamente a premissa em disputa.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
import pytest_asyncio

from core_db import Store
from mod_finance import schema as finance_schema
from mod_finance.models import FinancialEntry
from mod_finance.service import FinanceService
from seraphine.insights import schema as insights_schema
from seraphine.insights.service import InsightEngine
from seraphine.memory.store import MemoryStore


@pytest_asyncio.fixture
async def financas(tmp_path: Path):
    store = Store(tmp_path / "finance.sqlite")
    store.register_migrator("mod_finance", finance_schema.migrate)
    await store.ensure_schema()
    service = FinanceService(store)
    yield service
    await service.aclose()
    await store.aclose()


@pytest.fixture
async def memoria(tmp_path: Path) -> MemoryStore:
    s = MemoryStore(tmp_path / "insights.sqlite")
    s.register_migrator("seraphine_insights", insights_schema.migrate)
    await s.ensure_schema()
    return s


# Julho de 2026: as sextas caem em 03, 10 e 17; segunda a quinta, em 06–09.
_SEXTAS = ("2026-07-03", "2026-07-10", "2026-07-17")
_SEG_A_QUI = ("2026-07-06", "2026-07-07", "2026-07-08", "2026-07-09")


async def _compra(
    svc: FinanceService, data: str, valor: float, invoice_id: int,
) -> None:
    await svc.add_entry(FinancialEntry(
        id=None, type="expense", amount=valor, currency="BRL",
        category="alimentacao", description=f"restaurante {data}",
        date=data, source="pdf", invoice_id=invoice_id,
    ))


async def _julho_no_cartao(svc: FinanceService, **fatura: Any) -> int:
    """Todo o padrão de julho dentro de UMA fatura que vence em agosto.

    Sexta com ticket médio de R$ 300 contra R$ 100 nos outros dias: +200%,
    muito acima do OUTLIER_PCT de 40%.
    """
    inv = await svc.create_invoice(
        card="C6", closing_date=None, due_date="2026-08-10",
        total=1300.0, **fatura,
    )
    for d in _SEXTAS:
        await _compra(svc, d, 300.0, inv)
    for d in _SEG_A_QUI:
        await _compra(svc, d, 100.0, inv)
    return inv


def _sextas(insights: list[Any], period: str) -> list[Any]:
    return [
        i for i in insights
        if i.type == "finance"
        and i.data.get("weekday") == 4
        and i.data.get("period") == period
    ]


async def test_o_padrao_de_julho_aparece_na_analise_de_julho(
    financas: FinanceService, memoria: MemoryStore,
) -> None:
    """As compras estão TODAS em julho; a fatura vence em agosto.

    Buscando por mês de caixa, julho volta vazio e o padrão de julho não é
    analisado em mês nenhum — nem em julho, que é quando ele aconteceu.
    """
    await _julho_no_cartao(financas)
    eng = InsightEngine(memoria, finance_service=financas)

    achados = _sextas(await eng.analyze_finance(7, 2026), "2026-07")
    assert achados, "o padrão de sexta de julho sumiu da análise de julho"
    assert achados[0].data["avg_this_day"] == 300.0
    assert achados[0].data["avg_other_days"] == 100.0


async def test_agosto_nao_carimba_um_insight_feito_de_compras_de_julho(
    financas: FinanceService, memoria: MemoryStore,
) -> None:
    """O outro lado do mesmo troco de conjunto.

    Com a busca por mês de caixa, `analyze_finance(8, 2026)` recebia as
    compras de JULHO (é o mês em que a fatura vence) e devolvia um insight
    com `period=2026-08` — uma afirmação sobre agosto calculada sobre um mês
    em que nada disso foi comprado.
    """
    await _julho_no_cartao(financas)
    eng = InsightEngine(memoria, finance_service=financas)

    de_agosto = await eng.analyze_finance(8, 2026)
    assert _sextas(de_agosto, "2026-08") == []


async def test_pagar_a_fatura_nao_move_o_padrao_de_julho(
    financas: FinanceService, memoria: MemoryStore,
) -> None:
    """E não é adiamento: pago em setembro, o mês de caixa anda para a frente
    e a data da compra fica para trás. Julho continua sendo julho."""
    inv = await _julho_no_cartao(financas)
    await financas.mark_invoice_paid(inv, "2026-09-05")
    eng = InsightEngine(memoria, finance_service=financas)

    assert _sextas(await eng.analyze_finance(7, 2026), "2026-07")
    assert _sextas(await eng.analyze_finance(9, 2026), "2026-09") == []


async def test_o_recorte_do_mes_continua_recortando(
    financas: FinanceService, memoria: MemoryStore,
) -> None:
    """Não-regressão: buscar sem mês não pode virar "está tudo lá".

    Um único gasto avulso em junho, sozinho na sua categoria, não pode
    aparecer na análise de julho.
    """
    await _julho_no_cartao(financas)
    await financas.add_entry(FinancialEntry(
        id=None, type="expense", amount=999.0, currency="BRL",
        category="lazer", description="cinema em junho",
        date="2026-06-20", source="chat",
    ))
    eng = InsightEngine(memoria, finance_service=financas)

    de_julho = await eng.analyze_finance(7, 2026)
    assert all(i.data.get("category") != "lazer" for i in de_julho)
