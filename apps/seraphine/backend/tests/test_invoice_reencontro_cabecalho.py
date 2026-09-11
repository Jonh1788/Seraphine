"""O reencontro da fatura preenchendo o cabeçalho — e a mensagem dizendo o
que está GRAVADO.

A ponta a ponta que abriu este arquivo, com os números medidos:

    IMPORT 1 (o LLM lê "10/08/2026")  -> fatura due=None, needs_review
                                         julho 0, agosto 0, geral 240
    o usuário segue a recomendação da própria ferramenta:
    apaga os lançamentos e reenvia o PDF
    IMPORT 2 (o LLM lê "2026-08-10")  -> fatura due=None AINDA
                                         julho 0, agosto 0, geral 240
    mensagem: "Fatura C6 (vencimento 2026-08-10) ... Os gastos dela pesam
               no mes do vencimento"

O dinheiro não estava em mês nenhum e a mensagem afirmava que estava em
agosto. Duas coisas com a mesma raiz — a fatura reencontrada nunca recebia o
cabeçalho novo, e o relatório imprimia a leitura em vez do banco.
"""

from __future__ import annotations

import pytest_asyncio

from core_db import Store
from mod_finance import schema as finance_schema
from mod_finance.service import FinanceService
from seraphine.tools.financial import ImportFinancialPdfTool


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


_TXS = [
    {"type": "expense", "amount": 100.0, "category": "alimentacao",
     "description": "IFOOD", "date": "2026-07-15"},
    {"type": "expense", "amount": 140.0, "category": "transporte",
     "description": "UBER", "date": "2026-07-20"},
]

# O cabeçalho bem lido, e a mesma leitura com o vencimento em PT-BR — que é
# fora do ISO, e por isso vira NULL no banco.
_BOM = {"card": "C6", "closing_date": "2026-08-03",
        "due_date": "2026-08-10", "total": 240.0}
_CEGO = {**_BOM, "due_date": "10/08/2026", "closing_date": "03/08/2026"}


async def _importar(svc: FinanceService, header: dict, arquivo: str = "c6.pdf"):
    """O mesmo PDF (mesmos bytes) lido de novo, com o cabeçalho dado.

    O nome do arquivo é o conteúdo: mesmo nome, mesmo documento, e é o hash
    dele que reencontra a fatura sem depender do que o LLM leu.
    """
    caminho = svc._store.path.parent / arquivo
    caminho.write_bytes(f"%PDF-1.4 {arquivo}".encode())
    tool = ImportFinancialPdfTool(service=svc)
    tool._last_invoice_header = header
    return await tool._insert_and_report(
        list(_TXS), "llm-pdf", 1, str(caminho), failures=[],
    )


async def _esvaziar(svc: FinanceService) -> None:
    """O reparo que a própria ferramenta recomenda: apagar os lançamentos."""
    for e in await svc.list_entries(limit=100):
        await svc.delete_entry(e.id)


async def _fatura(svc: FinanceService):
    (f,) = await svc.list_open_invoices()
    return f


# --- o dinheiro ------------------------------------------------------


async def test_reenviar_o_pdf_tira_o_dinheiro_do_limbo(
    svc: FinanceService,
) -> None:
    """A ponta a ponta do topo do arquivo, número por número."""
    await _importar(svc, _CEGO)
    assert (await _fatura(svc)).due_date is None
    assert (await svc.get_monthly_summary(7, 2026))["expenses"] == 0.0
    assert (await svc.get_monthly_summary(8, 2026))["expenses"] == 0.0

    await _esvaziar(svc)
    r = await _importar(svc, _BOM)
    assert r.ok, r.error

    # O cabeçalho novo trouxe o que faltava, e o dinheiro achou o mês.
    assert (await _fatura(svc)).due_date == "2026-08-10"
    assert (await svc.get_monthly_summary(7, 2026))["expenses"] == 0.0
    assert (await svc.get_monthly_summary(8, 2026))["expenses"] == 240.0
    # E não dobrou pelo caminho.
    assert (await svc.get_overall_balance())["total_expenses"] == 240.0


async def test_preencher_nao_precisa_da_fatura_vazia(
    svc: FinanceService,
) -> None:
    """A fatura que JÁ tem lançamentos também sai do limbo.

    É o caminho mais comum: o usuário reenvia o PDF só para perguntar algo
    sobre a fatura. Nada é inserido — e mesmo assim o vencimento que faltava
    entra, porque é o que decide em que mês aquele dinheiro está.
    """
    await _importar(svc, _CEGO)
    r = await _importar(svc, _BOM)
    assert r.ok, r.error
    assert r.metadata["already_imported"] == 2, "nada pode ter sido inserido"

    assert (await _fatura(svc)).due_date == "2026-08-10"
    assert (await svc.get_monthly_summary(8, 2026))["expenses"] == 240.0


async def test_o_total_gravado_tambem_e_preenchido(svc: FinanceService) -> None:
    """A pendência do ledger: a coluna `total` nunca era atualizada no ramo
    reencontrado-e-vazio, então a reconciliação seguia sem referência."""
    await _importar(svc, {**_CEGO, "total": None})
    assert (await _fatura(svc)).total is None

    await _esvaziar(svc)
    await _importar(svc, _BOM)
    assert (await _fatura(svc)).total == 240.0


async def test_o_que_ja_esta_gravado_nao_e_sobrescrito(
    svc: FinanceService,
) -> None:
    """Só preenche buraco.

    A releitura é a leitura que menos merece confiança — é por isso que a
    identidade da fatura virou o hash do arquivo. Deixar o segundo
    vencimento vencer moveria dinheiro de mês por causa de um dígito lido
    diferente, e sem volta.
    """
    await _importar(svc, _BOM)
    await _importar(svc, {**_BOM, "due_date": "2026-09-10", "total": 999.0,
                          "closing_date": "2026-09-03"})

    f = await _fatura(svc)
    assert (f.due_date, f.closing_date, f.total) == (
        "2026-08-10", "2026-08-03", 240.0,
    )
    assert (await svc.get_monthly_summary(8, 2026))["expenses"] == 240.0


async def test_preencher_nao_promove_o_status(svc: FinanceService) -> None:
    """A decisão declarada: preencher e promover são coisas diferentes.

    A fatura ganha o vencimento que faltava e passa a fechar contra o total —
    e continua `needs_review`. Não existe primitiva de promoção em lugar
    nenhum deste produto, e preencher não abre uma pela porta dos fundos: o
    `needs_review` é um sinal em que o usuário pode ter se apoiado.
    """
    await _importar(svc, _CEGO)
    await _esvaziar(svc)
    await _importar(svc, _BOM)

    f = await _fatura(svc)
    assert (f.due_date, f.total) == ("2026-08-10", 240.0)
    assert f.status == "needs_review"


# --- a mensagem ------------------------------------------------------


async def test_a_mensagem_reporta_o_vencimento_gravado_e_nao_o_lido(
    svc: FinanceService,
) -> None:
    """A linha do relatório imprimia o vencimento RECÉM-LIDO ao lado de um
    veredito calculado sobre o que está gravado.

    Aqui a fatura tem 10/08 no banco e a segunda leitura diz 10/09: o
    dinheiro está em agosto, e a mensagem dizia setembro.
    """
    await _importar(svc, _BOM)
    r = await _importar(svc, {**_BOM, "due_date": "2026-09-10"})

    assert "2026-08-10" in r.output
    assert "2026-09-10" not in r.output


async def test_a_mensagem_nao_afirma_um_mes_que_nao_existe(
    svc: FinanceService,
) -> None:
    """Sem vencimento gravado e sem pagamento não há mês de caixa, e a frase
    fixa "os gastos dela pesam no mes do vencimento" era simplesmente falsa —
    dita, no relatório medido, junto de um vencimento que o banco não tinha.
    """
    r = await _importar(svc, _CEGO)

    assert "pesam no mes do vencimento" not in r.output
    assert "nao pesam em mes NENHUM" in r.output
    assert "sem vencimento gravado" in r.output
    # E o número confirma a frase.
    assert (await svc.get_monthly_summary(8, 2026))["expenses"] == 0.0


async def test_a_mensagem_diz_o_mes_certo_quando_ele_existe(
    svc: FinanceService,
) -> None:
    """Não-regressão: a frase honesta não pode ter apagado a informativa."""
    r = await _importar(svc, _BOM)
    assert "vencimento 2026-08-10" in r.output
    assert "pesam no mes do vencimento (2026-08)" in r.output


async def test_a_mensagem_segue_o_pagamento_quando_a_fatura_esta_paga(
    svc: FinanceService,
) -> None:
    """Pagamento vence vencimento na regra do mês de caixa, e a mensagem
    tem de contar a mesma história que o resumo mensal."""
    await _importar(svc, _BOM)
    (f,) = await svc.list_open_invoices()
    await svc.mark_invoice_paid(f.id, "2026-09-05")

    r = await _importar(svc, _BOM)
    assert "paga em 2026-09-05" in r.output
    assert "pesam em 2026-09" in r.output
    assert (await svc.get_monthly_summary(9, 2026))["expenses"] == 240.0
