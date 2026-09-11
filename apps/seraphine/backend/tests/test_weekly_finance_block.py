"""O bloco de finanças do relatório semanal, contra o mês de caixa.

O relatório semanal responde "quanto eu gastei NAQUELA semana", então a
referência dele é a data da COMPRA. `list_entries(month, year)` responde
outra pergunta — em que mês o dinheiro sai do caixa, que para uma compra no
cartão é o mês do vencimento ou do pagamento. Pedir o mês da semana e depois
filtrar por `e.date` mistura as duas: a compra de cartão não bate em nenhum
dos dois lados e não entra em semana nenhuma, nunca.
"""

from __future__ import annotations

from datetime import date
from types import SimpleNamespace

import pytest_asyncio

from core_db import Store
from mod_finance import schema as finance_schema
from mod_finance.models import FinancialEntry
from mod_finance.service import FinanceService
from seraphine.insights.weekly import _build_finance_block


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


# A semana 13–19/07/2026 (segunda a domingo).
_SEGUNDA = date(2026, 7, 13)
_DOMINGO = date(2026, 7, 19)
# A semana do pagamento, num mês diferente.
_SEGUNDA_PGTO = date(2026, 8, 10)
_DOMINGO_PGTO = date(2026, 8, 16)


async def _gasto(svc: FinanceService, data: str, valor: float,
                 invoice_id: int | None = None) -> None:
    await svc.add_entry(FinancialEntry(
        id=None, type="expense", amount=valor, currency="BRL",
        category="outros", description=f"compra {valor}", date=data,
        source="pdf" if invoice_id else "chat", invoice_id=invoice_id,
    ))


async def _semana(svc: FinanceService, segunda: date, domingo: date) -> dict:
    return await _build_finance_block(
        SimpleNamespace(_finance=svc), segunda, domingo,
    )


async def _cenario(svc: FinanceService) -> int:
    """R$ 200 no cartão + R$ 50 no PIX, os dois na semana 13–19/07."""
    inv = await svc.create_invoice(card="C6", closing_date=None,
                                   due_date="2026-08-10", total=200.0)
    await _gasto(svc, "2026-07-15", 200.0, inv)
    await _gasto(svc, "2026-07-16", 50.0)
    return inv


async def test_compra_de_cartao_entra_na_semana_em_que_foi_feita(
    svc: FinanceService,
) -> None:
    """O número medido: a semana mostrava R$ 50,00 com R$ 250,00 gastos."""
    await _cenario(svc)
    bloco = await _semana(svc, _SEGUNDA, _DOMINGO)
    assert bloco["expenses"] == 250.0


async def test_a_compra_de_cartao_nao_fica_sem_semana_nenhuma(
    svc: FinanceService,
) -> None:
    """E não era adiamento: depois do pagamento a semana de julho continuava
    R$ 50,00 e a semana do pagamento dava R$ 0,00 — a compra no cartão não
    entrava em semana alguma, nunca."""
    inv = await _cenario(svc)
    await svc.mark_invoice_paid(inv, "2026-08-11")

    assert (await _semana(svc, _SEGUNDA, _DOMINGO))["expenses"] == 250.0
    # E não pode aparecer DE NOVO na semana do pagamento: seria dinheiro
    # contado duas vezes em dois relatórios diferentes.
    assert (await _semana(svc, _SEGUNDA_PGTO, _DOMINGO_PGTO))["expenses"] == 0.0


async def test_a_semana_recorta_de_verdade(svc: FinanceService) -> None:
    """Não-regressão do recorte: o que está fora da semana continua fora,
    senão "está tudo lá" passaria por conserto."""
    await _cenario(svc)
    await _gasto(svc, "2026-07-12", 999.0)   # domingo anterior
    await _gasto(svc, "2026-07-20", 777.0)   # segunda seguinte

    bloco = await _semana(svc, _SEGUNDA, _DOMINGO)
    assert bloco["expenses"] == 250.0


async def test_receita_e_saldo_da_semana_seguem_a_data_da_compra(
    svc: FinanceService,
) -> None:
    inv = await _cenario(svc)
    await svc.add_entry(FinancialEntry(
        id=None, type="income", amount=1000.0, currency="BRL",
        category="salario", description="salario", date="2026-07-17",
        source="chat",
    ))
    await svc.mark_invoice_paid(inv, "2026-08-11")

    bloco = await _semana(svc, _SEGUNDA, _DOMINGO)
    assert bloco["income"] == 1000.0
    assert bloco["expenses"] == 250.0
    assert bloco["balance"] == 750.0


async def test_sem_servico_de_financas_o_bloco_nao_estoura() -> None:
    bloco = await _build_finance_block(
        SimpleNamespace(_finance=None), _SEGUNDA, _DOMINGO,
    )
    assert bloco == {"income": 0, "expenses": 0, "balance": 0}
