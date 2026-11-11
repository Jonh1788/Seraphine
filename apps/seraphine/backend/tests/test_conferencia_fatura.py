"""A conferência usa a conta que a fatura faz.

Uma fatura de cartão é `saldo anterior - pagamentos + compras = total`. A
conferência antiga somava as transações contra o total impresso, o que só
fecha numa fatura sem saldo anterior e sem pagamento — ou seja, quase
nenhuma. A primeira fatura real caiu em `needs_review` com a conta certa
fechando exata.
"""

from __future__ import annotations

import pytest_asyncio

from core_db import Store
from mod_finance import schema as finance_schema
from mod_finance.service import FinanceService
from seraphine.tools.financial import (
    ImportFinancialPdfTool,
    invoice_status_for,
    payments_total_for,
    reconcile_invoice,
    split_purchases_and_payments,
    sum_amounts,
)

# Os numeros da fatura C6 Carbon importada em 2026-08-04, medidos no banco.
_C6_SALDO = 1373.63
_C6_PAGAMENTOS = 2083.63
_C6_COMPRAS = 6148.88
_C6_TOTAL = 5438.88


def _compras(*valores: float) -> list[dict]:
    return [{"amount": v, "type": "expense"} for v in valores]


# --- o sinal ---------------------------------------------------------

def test_sum_amounts_soma_despesa_positiva() -> None:
    assert sum_amounts(_compras(100.0, 140.0)) == 240.0


def test_sum_amounts_subtrai_receita() -> None:
    """Estorno reduz a fatura. Somar com o mesmo sinal inflava o total."""
    txs = [{"amount": 240.0, "type": "expense"}, {"amount": 40.0, "type": "income"}]
    assert sum_amounts(txs) == 200.0


def test_sum_amounts_sem_tipo_conta_como_despesa() -> None:
    assert sum_amounts([{"amount": 100.0}]) == 100.0


def test_sum_amounts_ignora_valor_ilegivel() -> None:
    assert sum_amounts([{"amount": 100.0}, {"amount": "abc"}, {}]) == 100.0


# --- separar compra de pagamento -------------------------------------

def test_pagamento_sai_das_compras_e_vira_numero() -> None:
    txs = [
        {"amount": 100.0, "type": "expense", "kind": "purchase"},
        {"amount": 60.0, "type": "income", "kind": "payment"},
    ]
    compras, pagamentos = split_purchases_and_payments(txs)
    assert [t["amount"] for t in compras] == [100.0]
    assert pagamentos == 60.0


def test_sem_kind_conta_como_compra() -> None:
    """Prompt antigo, ou o modelo omitindo o campo: preserva o comportamento
    de antes em vez de sumir com o lancamento."""
    compras, pagamentos = split_purchases_and_payments([{"amount": 100.0}])
    assert len(compras) == 1
    assert pagamentos == 0.0


def test_varios_pagamentos_somam() -> None:
    txs = [{"amount": v, "kind": "payment"} for v in (1233.63, 200.0, 200.0, 200.0, 140.0, 110.0)]
    compras, pagamentos = split_purchases_and_payments(txs)
    assert compras == []
    assert round(pagamentos, 2) == 2083.63


def test_pagamento_negativo_conta_como_pagamento_feito() -> None:
    """A fatura de papel imprime o pagamento com sinal negativo, e o LLM pode
    devolver o sinal ou nao. Sem o `abs`, o pagamento ADICIONA ao que se
    espera cobrar e a conta erra pelo dobro dele — R$ 4.167,26 na fatura
    real. As duas leituras tem de dar o mesmo numero."""
    negativos = [{"amount": -1233.63, "kind": "payment"}, {"amount": -850.0, "kind": "payment"}]
    positivos = [{"amount": 1233.63, "kind": "payment"}, {"amount": 850.0, "kind": "payment"}]
    _, com_sinal = split_purchases_and_payments(negativos)
    _, sem_sinal = split_purchases_and_payments(positivos)
    assert round(com_sinal, 2) == round(sem_sinal, 2) == 2083.63


def test_pagamento_ilegivel_some_dos_dois_lados_e_a_fatura_vai_para_revisao() -> None:
    """O lado seguro de errar, medido. Um pagamento cujo valor nao deu para
    ler nao vira compra e nao entra na soma dos pagamentos: o `esperado`
    infla pelo valor perdido, a conta nao fecha, e a fatura se declara
    suspeita. Inventar um valor para ele afirmaria o que ninguem sabe."""
    txs = [
        {"amount": _C6_COMPRAS, "kind": "purchase"},
        {"amount": 1233.63, "kind": "payment"},
        {"amount": "R$ 850,00", "kind": "payment"},  # ilegivel para float()
    ]
    compras, pagamentos = split_purchases_and_payments(txs)
    assert [t["amount"] for t in compras] == [_C6_COMPRAS], "nao pode virar compra"
    assert round(pagamentos, 2) == 1233.63, "o ilegivel nao entra na soma"
    assert reconcile_invoice(
        purchases=compras, payments_total=pagamentos,
        previous_balance=_C6_SALDO, total=_C6_TOTAL,
    ) is False


# --- respondeu sobre `kind`, ou nao? ---------------------------------
#
# `split_purchases_and_payments` faz "sem `kind` conta como compra", e esse
# default responde pela COMPRA. Para o valor dos PAGAMENTOS ele nao serve:
# zero seria indistinguivel de "ninguem foi perguntado".


def test_payments_total_for_sem_kind_nenhum_e_desconhecido() -> None:
    """Nenhuma linha respondeu: a soma dos pagamentos e None, nao 0.0."""
    assert payments_total_for([{"amount": 100.0}, {"amount": 60.0}]) is None


def test_payments_total_for_com_kind_vazio_tambem_e_desconhecido() -> None:
    """A chave presente e vazia nao e resposta.

    A regua e a mesma la embaixo: `split_purchases_and_payments` le
    `str(t.get("kind") or "purchase")`, entao `""` e `None` ja contam como
    compra. Se aqui contassem como resposta, um lote inteiro de `"kind": ""`
    autorizaria o zero — a mesma afirmacao sem pergunta, uma casa adiante.
    """
    assert payments_total_for([{"amount": 100.0, "kind": ""}]) is None
    assert payments_total_for([{"amount": 100.0, "kind": None}]) is None
    assert payments_total_for([{"amount": 100.0, "kind": "   "}]) is None


def test_rotulagem_parcial_nao_e_enumeracao_completa() -> None:
    """UMA linha sem `kind` usavel derruba a soma inteira.

    Este teste substitui `test_payments_total_for_uma_linha_respondida_basta`,
    que assertava `== 0.0` para este mesmo lote e CODIFICAVA O DEFEITO: o
    `{"amount": 60.0}` sem rotulo pode ser um pagamento, e afirmar 0.0 e
    afirmar que ninguem pagou nada. Medido no caminho real, com o modelo
    marcando as compras e esquecendo as "Inclusao de Pagamento", isso
    restaurava o incidente original — fatura `open`, zero falso persistido em
    REAL, R$ 2.083,63 de receita fantasma em agosto, e a reimportacao dizendo
    "a fatura ja esta completa". Sem alarme nenhum, porque
    `_linha_dos_pagamentos(0.0)` tambem devolve None.
    """
    txs = [{"amount": 100.0, "kind": "purchase"}, {"amount": 60.0}]
    assert payments_total_for(txs) is None
    # E o lote INTEIRO rotulado continua valendo — senao a regra viraria
    # "nenhuma fatura fecha", que e o defeito que a Task 3 desfez.
    assert payments_total_for(
        [{"amount": 100.0, "kind": "purchase"},
         {"amount": 60.0, "kind": "purchase"}]
    ) == 0.0


def test_rotulagem_parcial_no_lote_do_c6_nao_deixa_a_fatura_abrir() -> None:
    """O caso medido, no nivel do status: as compras marcadas, os pagamentos
    esquecidos. E o que o modelo faz de verdade quando o exemplo de JSON do
    prompt nao traz o campo."""
    txs = [
        {"amount": _C6_COMPRAS, "type": "expense", "kind": "purchase"},
        {"amount": 1233.63, "type": "income"},
        {"amount": 850.0, "type": "income"},
    ]
    assert invoice_status_for(_HEADER_OK, txs) == "needs_review"


def test_payments_total_for_soma_os_pagamentos() -> None:
    assert round(payments_total_for(_TXS_C6) or -1, 2) == _C6_PAGAMENTOS


def test_lote_vazio_nao_responde_nada() -> None:
    """Leitura vazia nao e leitura completa — e isso e APERTO, nao afrouxamento.

    `[]` nao contem resposta nenhuma sobre `kind`, e afirmar "ninguem pagou
    nada" a partir de nada e a mesma troca de "nao sei" por "esta certo" que a
    guarda inteira recusa.

    O preco, medido e preso abaixo: uma fatura cujo saldo anterior seja igual
    ao total impresso e que nao trouxe transacao alguma FECHAVA a conta antes
    (`saldo - 0 + 0 == total`) e agora vai para revisao. A importacao nao
    alcanca esse caso — ela desiste antes, em `if not transactions` — mas
    `invoice_status_for` e publica e nao depende dela.
    """
    assert payments_total_for([]) is None
    header = {"card": "C6", "due_date": "2026-08-01", "total": 240.0,
              "previous_balance": 240.0}
    assert invoice_status_for(header, []) == "needs_review"


# --- a conta ---------------------------------------------------------

def test_a_fatura_do_c6_fecha() -> None:
    """1.373,63 - 2.083,63 + 6.148,88 = 5.438,88. O caso que motivou tudo."""
    assert reconcile_invoice(
        purchases=_compras(_C6_COMPRAS), payments_total=_C6_PAGAMENTOS,
        previous_balance=_C6_SALDO, total=_C6_TOTAL,
    ) is True


def test_a_conta_velha_nao_fecharia_a_do_c6() -> None:
    """O teste que prende que a conta MUDOU: a soma crua das transacoes
    contra o total impresso — saldo e pagamentos zerados, que e exatamente o
    que a conferencia velha fazia — REPROVA a mesma fatura que a conta nova
    aprova no teste acima."""
    assert reconcile_invoice(
        purchases=_compras(_C6_COMPRAS), payments_total=0.0,
        previous_balance=0.0, total=_C6_TOTAL,
    ) is False


def test_primeira_fatura_com_saldo_zero_fecha() -> None:
    assert reconcile_invoice(
        purchases=_compras(100.0), payments_total=0.0,
        previous_balance=0.0, total=100.0,
    ) is True


def test_saldo_ausente_nao_confere() -> None:
    """Ausente e 'nao sei', nao 'zero'. Tratar como zero transformaria nao
    sei em esta certo."""
    assert reconcile_invoice(
        purchases=_compras(100.0), payments_total=0.0,
        previous_balance=None, total=100.0,
    ) is False


def test_total_ausente_nao_confere() -> None:
    assert reconcile_invoice(
        purchases=_compras(100.0), payments_total=0.0,
        previous_balance=0.0, total=None,
    ) is False


def test_pagamentos_ausentes_nao_conferem_e_nao_estouram() -> None:
    """A terceira referencia, pela mesma regra das outras duas.

    Quem chama le `fatura.get("payments_total")`, que e NULL para toda fatura
    gravada antes do campo existir. Sem a guarda isso e `float(None)`:
    TypeError no meio de `_reconcile_after_insert`, e o usuario perde a
    importacao inteira por um campo que nunca foi lido. Com ela, a fatura
    apenas se declara suspeita.
    """
    assert reconcile_invoice(
        purchases=_compras(100.0), payments_total=None,
        previous_balance=0.0, total=100.0,
    ) is False
    # E zero EXPLICITO — ninguem pagou nada no periodo — continua conferindo.
    assert reconcile_invoice(
        purchases=_compras(100.0), payments_total=0.0,
        previous_balance=0.0, total=100.0,
    ) is True


def test_falta_lancamento_nao_fecha() -> None:
    assert reconcile_invoice(
        purchases=_compras(_C6_COMPRAS - 500.0), payments_total=_C6_PAGAMENTOS,
        previous_balance=_C6_SALDO, total=_C6_TOTAL,
    ) is False


def test_rotulagem_trocada_nao_fecha() -> None:
    """A formula E a conferencia da etiqueta: uma compra marcada como
    pagamento tira o valor das compras E soma nos pagamentos, entao a conta
    erra pelo dobro e a fatura vai para revisao."""
    txs = [{"amount": 6148.88, "kind": "payment"}]
    compras, pagamentos = split_purchases_and_payments(txs)
    assert reconcile_invoice(
        purchases=compras, payments_total=_C6_PAGAMENTOS + pagamentos,
        previous_balance=_C6_SALDO, total=_C6_TOTAL,
    ) is False


def test_diferenca_de_centavo_e_tolerada() -> None:
    assert reconcile_invoice(
        purchases=_compras(100.0), payments_total=0.0,
        previous_balance=0.0, total=100.01,
    ) is True


def test_o_centavo_e_tolerado_TAMBEM_na_magnitude_da_fatura_real() -> None:
    """A tolerancia de um centavo era um sorteio pela magnitude.

    `abs(240.0 - 240.01)` vale 0.009999999999991 em binario e passava;
    `abs(5438.88 - 5438.89)` vale 0.010000000000218 e NAO passava. O teste
    antigo escolheu 240,01, um dos valores em que o erro de representacao cai
    para o lado bom — entao a tolerancia parecia funcionar e nao funcionava
    na unica magnitude que ja apareceu em producao. Um centavo de
    arredondamento de PDF mandaria a fatura do C6 para revisao.
    """
    assert reconcile_invoice(
        purchases=_compras(_C6_COMPRAS), payments_total=_C6_PAGAMENTOS,
        previous_balance=_C6_SALDO, total=_C6_TOTAL + 0.01,
    ) is True
    assert reconcile_invoice(
        purchases=_compras(_C6_COMPRAS), payments_total=_C6_PAGAMENTOS,
        previous_balance=_C6_SALDO, total=_C6_TOTAL - 0.01,
    ) is True
    # E a tolerancia continua sendo de UM centavo, nao de dois.
    assert reconcile_invoice(
        purchases=_compras(_C6_COMPRAS), payments_total=_C6_PAGAMENTOS,
        previous_balance=_C6_SALDO, total=_C6_TOTAL + 0.02,
    ) is False


# --- o status --------------------------------------------------------

_HEADER_OK = {
    "card": "C6", "due_date": "2026-08-01", "total": _C6_TOTAL,
    "previous_balance": _C6_SALDO,
}
_TXS_C6 = [
    {"amount": _C6_COMPRAS, "kind": "purchase"},
    {"amount": _C6_PAGAMENTOS, "kind": "payment"},
]


def test_fatura_completa_abre() -> None:
    assert invoice_status_for(_HEADER_OK, _TXS_C6) == "open"


def test_sem_saldo_anterior_vai_para_revisao() -> None:
    # ATENCAO: este teste passa mesmo com a distincao ausente/zero MORTA — os
    # numeros do C6 nao fecham com saldo zero de qualquer jeito. Quem
    # discrimina de verdade e o teste logo abaixo; nao confie neste pelo nome.
    assert invoice_status_for({**_HEADER_OK, "previous_balance": None}, _TXS_C6) == "needs_review"


def test_saldo_ausente_vai_para_revisao_MESMO_quando_zero_fecharia() -> None:
    """O teste acima passa por coincidencia aritmetica, nao pela distincao.

    Medido: colapsando `previous_balance` ausente para zero, a conta do C6 da
    4.065,25 contra 5.438,88 impressos — nao fecha de qualquer jeito, entao a
    fatura vai para revisao pelo motivo errado e o teste fica verde com a
    distincao morta. Aqui os numeros sao escolhidos para FECHAREM com saldo
    zero: se ausente virar zero, esta fatura nasce `open` afirmando que a
    conta bate, quando ninguem conseguiu ler o saldo anterior.
    """
    header = {"card": "C6", "due_date": "2026-08-01", "total": 100.0,
              "previous_balance": None}
    txs = [{"amount": 100.0, "kind": "purchase"}]
    assert invoice_status_for(header, txs) == "needs_review"
    # E o mesmo cabecalho com zero EXPLICITO — primeira fatura do cartao —
    # continua abrindo: a distincao tem dois lados.
    assert invoice_status_for({**header, "previous_balance": 0.0}, txs) == "open"


def test_lote_sem_kind_nao_deixa_a_fatura_abrir() -> None:
    """A armadilha em que a algebra conspira, na funcao pura.

    Sem `kind`, os pagamentos ficam entre as compras marcados como receita.
    `sum_amounts` os subtrai — e subtrair o pagamento como receita negativa e
    a MESMA conta que subtrai-lo via `payments_total`. A conta fecha exata, e
    a fatura nasceria `open` afirmando que bate, com os pagamentos virando
    lancamento e inflando o mes.

    O primeiro `assert` mede a armadilha; o segundo, a guarda. Sem o segundo,
    `invoice_status_for` pode voltar a usar a metade crua do `split` e a
    suite fica verde — o rebaixamento de `_reconcile_after_insert` esconderia
    o defeito no caminho da importacao inteira.
    """
    txs = [
        {"amount": _C6_COMPRAS, "type": "expense"},
        {"amount": 1233.63, "type": "income"},
        {"amount": 850.0, "type": "income"},
    ]
    compras, _ = split_purchases_and_payments(txs)
    assert reconcile_invoice(
        purchases=compras, payments_total=0.0,
        previous_balance=_C6_SALDO, total=_C6_TOTAL,
    ) is True, "a conta FECHA com zero — e por isso que zero nao pode ser o default"
    assert invoice_status_for(_HEADER_OK, txs) == "needs_review"


def test_sem_vencimento_vai_para_revisao() -> None:
    assert invoice_status_for({**_HEADER_OK, "due_date": None}, _TXS_C6) == "needs_review"


def test_vencimento_fora_do_iso_vai_para_revisao() -> None:
    assert invoice_status_for({**_HEADER_OK, "due_date": "01/08/2026"}, _TXS_C6) == "needs_review"


def test_sem_total_vai_para_revisao() -> None:
    assert invoice_status_for({**_HEADER_OK, "total": None}, _TXS_C6) == "needs_review"


# --- o sinal chegando nos dois chamadores ----------------------------
#
# Ate aqui tudo era funcao pura. Nenhum dos dois chamadores tinha teste, e foi
# exatamente ali que a sensibilidade ao sinal quase ficou inerte: os dois
# montavam dicts so com `amount`, descartando o `type` que `sum_amounts`
# passou a ler.


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


_HEADER_IMPORT = {"card": "C6", "closing_date": "2026-07-24",
                  "due_date": "2026-08-01", "total": 100.0,
                  "previous_balance": 0.0}
# Uma compra e um estorno: a fatura cobra 240 - 140 = 100.
# `kind: "purchase"` nas duas: estorno NAO e pagamento de fatura — ele reduz o
# que a fatura cobra, e e por isso que o sinal precisa chegar na conferencia.
# Sem `kind` nenhum o lote inteiro iria para revisao (o modelo nao respondeu
# sobre o campo) e este teste nao conseguiria observar o `open`.
_TXS_COM_ESTORNO = [
    {"type": "expense", "amount": 240.0, "category": "outros",
     "description": "MERCADO", "date": "2026-07-15", "kind": "purchase"},
    {"type": "income", "amount": 140.0, "category": "outros",
     "description": "ESTORNO MERCADO", "date": "2026-07-18",
     "kind": "purchase"},
]


def _tool(svc: FinanceService, tmp_path, header: dict) -> tuple:
    pdf = tmp_path / "c6.pdf"
    pdf.write_bytes(b"%PDF-1.4 fake")
    tool = ImportFinancialPdfTool(service=svc)
    tool._last_invoice_header = dict(header)
    return tool, str(pdf)


async def test_a_fatura_com_estorno_nasce_aberta(
    svc: FinanceService, tmp_path,
) -> None:
    """O sinal chega na conferencia da PRIMEIRA importacao — pelo resultado.

    Este e o fluxo que o docstring de `_reconcile_after_insert` chama de "o
    fluxo que esta feature existe para servir". O laco montava
    `{"amount": amount}` com `entry_type` calculado tres linhas acima e jogado
    fora: a fatura acima cobra R$ 100,00 (240 de compra menos 140 de estorno)
    e a conferencia recebia R$ 380,00, entao a fatura correta era rebaixada.

    Ate a Task 3 este teste espiava a LISTA que chegava em
    `_reconcile_after_insert`, porque a conferencia devolvia False para tudo e
    um teste de comportamento passaria verde com o sinal morto. Agora que ela
    funciona, o veredito e observavel: com o sinal, `open`; sem ele, os
    R$ 380,00 nao batem com os R$ 100,00 impressos e a fatura vai para revisao.
    """
    tool, pdf = _tool(svc, tmp_path, _HEADER_IMPORT)
    r = await tool._insert_and_report(
        list(_TXS_COM_ESTORNO), "llm-pdf", 1, pdf, failures=[],
    )
    assert r.ok, r.error

    entries = await svc.list_entries(limit=50)
    assert len(entries) == 2, "os dois lancamentos entraram"
    assert sum_amounts(
        [{"amount": e.amount, "type": e.type} for e in entries]
    ) == 100.0, "o estorno tem de REDUZIR o que a fatura cobra"
    fatura = (await svc.list_open_invoices())[0]
    assert fatura.status == "open", \
        "a fatura cobra R$ 100,00 e e isso que esta impresso: ela fecha"
    assert {e.invoice_id for e in entries} == {fatura.id}


async def test_a_reimportacao_mostra_a_soma_com_o_sinal(
    svc: FinanceService, tmp_path,
) -> None:
    """`_already_imported_result` conta o estorno como negativo.

    Aqui o numero e visivel mesmo antes da Task 3: ele vai para a MENSAGEM
    que o modelo le. Com o `type` descartado a frase dizia "somando
    R$ 380,00" sobre uma fatura de R$ 100,00 — e a conferencia usa essa mesma
    soma, entao os dois erravam juntos e em silencio.
    """
    tool, pdf = _tool(svc, tmp_path, _HEADER_IMPORT)
    await tool._insert_and_report(
        list(_TXS_COM_ESTORNO), "llm-pdf", 1, pdf, failures=[],
    )
    assert len(await svc.list_entries(limit=50)) == 2

    tool2, _ = _tool(svc, tmp_path, _HEADER_IMPORT)
    r = await tool2._insert_and_report(
        list(_TXS_COM_ESTORNO), "llm-pdf", 1, pdf, failures=[],
    )
    assert r.ok, r.error
    assert r.metadata.get("transactions") == 0, "a reimportacao nao insere nada"
    assert "somando R$ 100,00" in (r.output or ""), r.output
    assert "R$ 380,00" not in (r.output or "")
