"""Marcar a fatura como paga, pela conversa.

A desambiguação é o caso que importa: escolher sozinho entre duas faturas
em aberto do mesmo cartão seria mover dinheiro de mês por adivinhação.
"""

from __future__ import annotations

import pytest
import pytest_asyncio

from core_db import Store
from mod_finance import schema as finance_schema
from mod_finance.models import FinancialEntry
from mod_finance.service import FinanceService
from seraphine.tools.financial import MarkInvoicePaidTool


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


async def test_criar_e_listar_fatura_em_aberto(svc: FinanceService) -> None:
    await svc.create_invoice(card="C6", closing_date="2026-08-03",
                             due_date="2026-08-10", total=5438.88)
    abertas = await svc.list_open_invoices()
    assert len(abertas) == 1
    assert abertas[0].card == "C6"
    assert abertas[0].paid_date is None


async def test_marcar_paga_grava_data_e_status(svc: FinanceService) -> None:
    inv_id = await svc.create_invoice(card="C6", closing_date="2026-08-03",
                                      due_date="2026-08-10", total=100.0)
    inv = await svc.mark_invoice_paid(inv_id, "2026-08-11")
    assert inv is not None
    assert inv.paid_date == "2026-08-11"
    assert inv.status == "paid"


async def test_fatura_paga_sai_da_lista_de_abertas(svc: FinanceService) -> None:
    inv_id = await svc.create_invoice(card="C6", closing_date=None,
                                      due_date="2026-08-10", total=None)
    await svc.mark_invoice_paid(inv_id, "2026-08-11")
    assert await svc.list_open_invoices() == []


async def test_tool_marca_a_unica_fatura_aberta(svc: FinanceService) -> None:
    await svc.create_invoice(card="C6", closing_date=None,
                             due_date="2026-08-10", total=None)
    r = await MarkInvoicePaidTool(svc).execute({"card": "C6", "paid_date": "2026-08-11"})
    assert r.ok, r.error
    assert await svc.list_open_invoices() == []


async def test_tool_pede_desambiguacao_com_duas_abertas(svc: FinanceService) -> None:
    """Escolher sozinho moveria dinheiro de mês por adivinhação."""
    await svc.create_invoice(card="C6", closing_date=None, due_date="2026-07-10", total=None)
    await svc.create_invoice(card="C6", closing_date=None, due_date="2026-08-10", total=None)

    r = await MarkInvoicePaidTool(svc).execute({"card": "C6", "paid_date": "2026-08-11"})
    assert not r.ok
    # O erro tem de listar as candidatas, ou o usuário não tem como escolher.
    assert "2026-07-10" in (r.error or "")
    assert "2026-08-10" in (r.error or "")
    # E nada foi marcado.
    assert len(await svc.list_open_invoices()) == 2


async def test_tool_aceita_invoice_id_para_desempatar(svc: FinanceService) -> None:
    a = await svc.create_invoice(card="C6", closing_date=None, due_date="2026-07-10", total=None)
    await svc.create_invoice(card="C6", closing_date=None, due_date="2026-08-10", total=None)

    r = await MarkInvoicePaidTool(svc).execute(
        {"invoice_id": a, "paid_date": "2026-08-11"},
    )
    assert r.ok, r.error
    abertas = await svc.list_open_invoices()
    assert len(abertas) == 1
    # Qual sobrou importa: marcar a fatura errada também deixaria uma aberta,
    # e teria movido o dinheiro do mês errado — o dano que esta tool evita.
    assert abertas[0].due_date == "2026-08-10"


async def test_tool_diz_quando_nao_ha_fatura_aberta(svc: FinanceService) -> None:
    r = await MarkInvoicePaidTool(svc).execute({"card": "Nubank", "paid_date": "2026-08-11"})
    assert not r.ok
    assert "Nubank" in (r.error or "")


async def test_desambiguacao_pede_card_e_invoice_id(svc: FinanceService) -> None:
    """A instrução do desempate é o que mantém a conferência viva.

    Pedir só `invoice_id` desliga o guard de `card` no único caminho onde id
    cru trafega: o modelo obedece, `card` vem vazio, e não sobra contra o que
    conferir. Este teste prende a instrução — sem ele, alguém reescreve a
    mensagem e o guard volta a ser inerte em silêncio.
    """
    await svc.create_invoice(card="C6", closing_date=None, due_date="2026-07-10",
                             total=None)
    await svc.create_invoice(card="C6", closing_date=None, due_date="2026-08-10",
                             total=None)

    tool = MarkInvoicePaidTool(svc)
    r = await tool.execute({"card": "C6", "paid_date": "2026-08-11"})
    assert not r.ok
    erro = r.error or ""
    assert "card" in erro
    assert "invoice_id" in erro

    # A description tem de dizer o mesmo: é ela que o modelo lê antes de errar.
    assert "card" in tool.description
    assert "invoice_id" in tool.description


async def test_tool_recusa_id_de_outro_cartao(svc: FinanceService) -> None:
    """Id alucinado de um turno anterior pagaria a fatura do cartão errado."""
    nubank = await svc.create_invoice(card="Nubank", closing_date=None,
                                      due_date="2026-08-10", total=None)
    await svc.create_invoice(card="C6", closing_date=None,
                             due_date="2026-08-10", total=None)

    r = await MarkInvoicePaidTool(svc).execute(
        {"card": "C6", "invoice_id": nubank, "paid_date": "2026-08-11"},
    )
    assert not r.ok
    assert "Nubank" in (r.error or "")
    assert "C6" in (r.error or "")
    # Nenhuma das duas foi marcada.
    assert len(await svc.list_open_invoices()) == 2


async def test_tool_recusa_id_inexistente_com_cartao(svc: FinanceService) -> None:
    await svc.create_invoice(card="C6", closing_date=None,
                             due_date="2026-08-10", total=None)
    r = await MarkInvoicePaidTool(svc).execute(
        {"card": "C6", "invoice_id": 9999, "paid_date": "2026-08-11"},
    )
    assert not r.ok
    assert "9999" in (r.error or "")
    assert len(await svc.list_open_invoices()) == 1


async def test_id_certo_com_cartao_certo_passa(svc: FinanceService) -> None:
    """A conferência não pode atrapalhar o caminho honesto."""
    inv_id = await svc.create_invoice(card="c6 ", closing_date=None,
                                      due_date="2026-08-10", total=None)
    r = await MarkInvoicePaidTool(svc).execute(
        {"card": "C6", "invoice_id": inv_id, "paid_date": "2026-08-11"},
    )
    assert r.ok, r.error
    assert await svc.list_open_invoices() == []


async def test_desempate_lista_fatura_sem_vencimento_legivel(
    svc: FinanceService,
) -> None:
    """`None` é token de Python; o usuário lê português."""
    await svc.create_invoice(card="C6", closing_date=None, due_date=None,
                             total=None)
    await svc.create_invoice(card="C6", closing_date=None,
                             due_date="2026-08-10", total=None)

    r = await MarkInvoicePaidTool(svc).execute(
        {"card": "C6", "paid_date": "2026-08-11"},
    )
    assert not r.ok
    assert "None" not in (r.error or "")
    assert "sem vencimento" in (r.error or "")


async def test_criar_fatura_ja_paga_e_recusado(svc: FinanceService) -> None:
    """`create_invoice` não grava `paid_date`: aceitar status 'paid' criaria a
    fatura que se diz paga e nunca sai da lista de abertas."""
    with pytest.raises(ValueError):
        await svc.create_invoice(card="C6", closing_date=None,
                                 due_date="2026-08-10", total=None,
                                 status="paid")
    assert await svc.list_open_invoices() == []


async def test_tool_nao_estoura_com_invoice_id_invalido(svc: FinanceService) -> None:
    """O LLM manda o nome do cartão em `invoice_id` mais cedo ou mais tarde."""
    r = await MarkInvoicePaidTool(svc).execute(
        {"invoice_id": "C6", "paid_date": "2026-08-11"},
    )
    assert not r.ok
    assert r.error


async def test_data_vazia_e_gravada_como_null(svc: FinanceService) -> None:
    """String vazia mente para todo `IS NOT NULL`.

    A regra do mês de caixa testa `due_date IS NOT NULL`; `''` passa nesse
    teste e vira o mês `''`, que não casa com mês algum — o lançamento some
    do balanço sem erro nenhum.
    """
    await svc.create_invoice(card="C6", closing_date="", due_date="  ",
                             total=None)
    inv = (await svc.list_open_invoices())[0]
    assert inv.closing_date is None
    assert inv.due_date is None


async def test_marcar_paga_sem_data_e_recusado(svc: FinanceService) -> None:
    """`status='paid'` com `paid_date` vazio é uma fatura que se diz paga e
    continua na lista de abertas. Recusar alto é melhor que gravar isso."""
    inv_id = await svc.create_invoice(card="C6", closing_date=None,
                                      due_date="2026-08-10", total=None)
    with pytest.raises(ValueError):
        await svc.mark_invoice_paid(inv_id, "   ")
    assert len(await svc.list_open_invoices()) == 1

    r = await MarkInvoicePaidTool(svc).execute({"card": "C6", "paid_date": " "})
    assert not r.ok
    assert len(await svc.list_open_invoices()) == 1


# --- a data que o LLM manda ------------------------------------------

#: Tudo que um LLM em contexto PT-BR devolve quando ninguém exige ISO. A
#: primeira é a que apareceu de verdade; as outras são o mesmo buraco por
#: outros lados — inclusive as que `date.fromisoformat` aceita sozinha e as
#: que passam por um regex de formato sem existir no calendário.
_FORA_DO_ISO = [
    "05/09/2026",
    "hoje",
    "11-08-2026",
    "2026-13-45",
    "2026-02-30",
    "2026-8-11",
    "20260811",
    "2026-08-11T10:00:00",
]


@pytest.mark.parametrize("data", _FORA_DO_ISO)
async def test_servico_recusa_paid_date_fora_do_iso(
    svc: FinanceService, data: str,
) -> None:
    """O mês de caixa recorta com `substr(paid_date, 1, 7)`, que é um corte
    posicional: `05/09/2026` vira o mês `05/09/2` e não casa com mês nenhum.
    O gasto sai do balanço mensal INTEIRO em silêncio."""
    inv_id = await svc.create_invoice(card="C6", closing_date=None,
                                      due_date="2026-08-10", total=None)
    with pytest.raises(ValueError):
        await svc.mark_invoice_paid(inv_id, data)

    # E não pode ter escrito nada: meia marcação é pior que nenhuma.
    fatura = await svc.get_invoice(inv_id)
    assert fatura.paid_date is None
    assert fatura.status == "open"
    assert len(await svc.list_open_invoices()) == 1


@pytest.mark.parametrize("data", _FORA_DO_ISO)
async def test_tool_recusa_paid_date_fora_do_iso(
    svc: FinanceService, data: str,
) -> None:
    """`ok=True` com "marcada como paga" era a pior parte: o modelo lia
    sucesso e contava ao usuário que estava feito."""
    inv_id = await svc.create_invoice(card="C6", closing_date=None,
                                      due_date="2026-08-10", total=None)
    r = await MarkInvoicePaidTool(svc).execute(
        {"card": "C6", "paid_date": data},
    )
    assert not r.ok, f"{data!r} passou como data válida"
    # Quem lê o erro é o modelo: sem o formato dentro dele, ele só tenta de
    # novo com outro palpite.
    assert "YYYY-MM-DD" in (r.error or "")
    assert (await svc.get_invoice(inv_id)).paid_date is None
    assert len(await svc.list_open_invoices()) == 1


async def test_tool_recusa_a_data_antes_de_procurar_a_fatura(
    svc: FinanceService,
) -> None:
    """A conferência da tool não é redundante com a do serviço: ela acontece
    ANTES de a fatura ser procurada. Sem ela, com duas faturas abertas o
    modelo recebe "escolha uma" — corrige o id, reenvia, e só então descobre
    que o problema era a data. Dois turnos para um erro só, e o segundo com o
    usuário já achando que pagou."""
    await svc.create_invoice(card="C6", closing_date=None,
                             due_date="2026-07-10", total=None)
    await svc.create_invoice(card="C6", closing_date=None,
                             due_date="2026-08-10", total=None)

    r = await MarkInvoicePaidTool(svc).execute(
        {"card": "C6", "paid_date": "05/09/2026"},
    )
    assert not r.ok
    erro = r.error or ""
    assert "YYYY-MM-DD" in erro, "o erro tem de ser sobre a data, nao sobre o id"
    assert "faturas em aberto" not in erro
    assert len(await svc.list_open_invoices()) == 2


async def test_data_brasileira_nao_e_convertida_por_adivinhacao(
    svc: FinanceService,
) -> None:
    """Em PT-BR `05/09/2026` é 5 de setembro. Adivinhar acerta quase sempre e
    erra calado no resto — movendo dinheiro para o mês errado, que é o mesmo
    defeito de novo. Recusar é a resposta."""
    inv_id = await svc.create_invoice(card="C6", closing_date=None,
                                      due_date="2026-08-10", total=None)
    r = await MarkInvoicePaidTool(svc).execute(
        {"card": "C6", "paid_date": "05/09/2026"},
    )
    assert not r.ok
    assert (await svc.get_invoice(inv_id)).paid_date is None


async def test_data_ilegivel_nao_tira_o_gasto_de_todos_os_meses(
    svc: FinanceService,
) -> None:
    """O estrago medido em dinheiro: com a data crua gravada, agosto perdia a
    despesa e nenhum outro mês a ganhava — ela sobrava só no saldo geral."""
    inv_id = await svc.create_invoice(card="C6", closing_date=None,
                                      due_date="2026-08-10", total=200.0)
    await svc.add_entry(FinancialEntry(
        id=None, type="expense", amount=200.0, currency="BRL",
        category="outros", description="MERCADO", date="2026-07-15",
        source="pdf", invoice_id=inv_id,
    ))
    assert (await svc.get_monthly_summary(8, 2026))["expenses"] == 200.0

    r = await MarkInvoicePaidTool(svc).execute(
        {"card": "C6", "paid_date": "05/09/2026"},
    )
    assert not r.ok
    # A fatura continua aberta e o gasto continua tendo um mês.
    assert (await svc.get_monthly_summary(8, 2026))["expenses"] == 200.0
    assert (await svc.get_monthly_summary(9, 2026))["expenses"] == 0


async def test_o_caminho_honesto_continua_passando(svc: FinanceService) -> None:
    """A validação não pode custar o fluxo que funciona."""
    inv_id = await svc.create_invoice(card="C6", closing_date=None,
                                      due_date="2026-08-10", total=200.0)
    await svc.add_entry(FinancialEntry(
        id=None, type="expense", amount=200.0, currency="BRL",
        category="outros", description="MERCADO", date="2026-07-15",
        source="pdf", invoice_id=inv_id,
    ))
    r = await MarkInvoicePaidTool(svc).execute(
        {"card": "C6", "paid_date": "2026-09-05"},
    )
    assert r.ok, r.error
    assert (await svc.get_invoice(inv_id)).paid_date == "2026-09-05"
    assert (await svc.get_monthly_summary(8, 2026))["expenses"] == 0
    assert (await svc.get_monthly_summary(9, 2026))["expenses"] == 200.0
