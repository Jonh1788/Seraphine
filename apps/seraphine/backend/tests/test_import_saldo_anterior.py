"""A importação lê o saldo anterior e não transforma pagamento em lançamento.

Os números são os da fatura C6 Carbon real: saldo 1.373,63, pagamentos
2.083,63, compras 6.148,88, total impresso 5.438,88.
"""

from __future__ import annotations

import pytest
import pytest_asyncio

from core_db import Store
from mod_finance import schema as finance_schema
from mod_finance.service import FinanceService
from seraphine.tools.financial import ImportFinancialPdfTool


@pytest_asyncio.fixture
async def svc(tmp_path):
    store = Store(tmp_path / "finance.sqlite")
    store.register_migrator("mod_finance", finance_schema.migrate)
    await store.ensure_schema()
    service = FinanceService(store)
    yield service
    await service.aclose()
    await store.aclose()


def _tool(svc: FinanceService, header: dict) -> ImportFinancialPdfTool:
    t = ImportFinancialPdfTool(svc, llm=None)
    t._last_invoice_header = header
    return t


_HEADER = {
    "card": "C6 Carbon", "closing_date": "2026-07-24", "due_date": "2026-08-01",
    "total": 5438.88, "previous_balance": 1373.63,
}
_TXS = [
    {"date": "2026-07-15", "description": "MERCADO", "amount": 6148.88, "kind": "purchase"},
    {"date": "2026-07-01", "description": "Inclusao de Pagamento", "amount": 1233.63, "kind": "payment"},
    {"date": "2026-07-09", "description": "Inclusao de Pagamento", "amount": 850.0, "kind": "payment"},
]


async def test_o_pagamento_nao_vira_lancamento(svc: FinanceService, tmp_path) -> None:
    pdf = tmp_path / "c6.pdf"
    pdf.write_bytes(b"%PDF-1.4 fake")
    await _tool(svc, _HEADER)._insert_and_report(_TXS, "llm", 1, str(pdf), failures=[])

    entries = await svc.list_entries(limit=100)
    assert len(entries) == 1
    assert entries[0].description == "MERCADO"
    assert all("Pagamento" not in e.description for e in entries)


async def test_o_saldo_e_os_pagamentos_ficam_gravados(svc: FinanceService, tmp_path) -> None:
    pdf = tmp_path / "c6.pdf"
    pdf.write_bytes(b"%PDF-1.4 fake")
    await _tool(svc, _HEADER)._insert_and_report(_TXS, "llm", 1, str(pdf), failures=[])

    fatura = (await svc.list_open_invoices())[0]
    assert fatura.previous_balance == 1373.63
    assert round(fatura.payments_total or 0, 2) == 2083.63


async def test_a_fatura_do_c6_nasce_aberta(svc: FinanceService, tmp_path) -> None:
    """A regressão que motivou tudo: a conta fecha, então nada de revisão."""
    pdf = tmp_path / "c6.pdf"
    pdf.write_bytes(b"%PDF-1.4 fake")
    await _tool(svc, _HEADER)._insert_and_report(_TXS, "llm", 1, str(pdf), failures=[])

    fatura = (await svc.list_open_invoices())[0]
    assert fatura.status == "open"


async def test_sem_saldo_anterior_a_fatura_pede_revisao(svc: FinanceService, tmp_path) -> None:
    pdf = tmp_path / "c6.pdf"
    pdf.write_bytes(b"%PDF-1.4 fake")
    await _tool(svc, {**_HEADER, "previous_balance": None})._insert_and_report(
        _TXS, "llm", 1, str(pdf), failures=[]
    )
    fatura = (await svc.list_open_invoices())[0]
    assert fatura.status == "needs_review"


async def test_a_receita_do_mes_nao_infla(svc: FinanceService, tmp_path) -> None:
    """Pagar o cartão é dinheiro saindo. Como receita, inflava agosto em
    R$ 2.083,63 — foi o que aconteceu na fatura real."""
    pdf = tmp_path / "c6.pdf"
    pdf.write_bytes(b"%PDF-1.4 fake")
    await _tool(svc, _HEADER)._insert_and_report(_TXS, "llm", 1, str(pdf), failures=[])

    resumo = await svc.get_monthly_summary(8, 2026)
    assert resumo["income"] == 0
    assert resumo["expenses"] == 6148.88


async def test_o_prompt_pede_saldo_anterior_e_o_tipo_da_linha() -> None:
    """Sem isso o modelo nunca devolve os campos e a conferência nunca fecha
    — a feature ficaria inerte com todos os testes verdes."""
    prompt = ImportFinancialPdfTool._pdf_prompt("mercado, outros")
    assert "previous_balance" in prompt
    assert "kind" in prompt
    assert "payment" in prompt


# --- o erro pelo dobro ------------------------------------------------
#
# As duas pontas — o laço de inserção e a conferência — têm de concordar sobre
# o que é pagamento. Se o laço não filtrar `kind`, a linha de pagamento entra
# em `inseridos`, é SUBTRAÍDA dentro de `sum_amounts` (o LLM devolve essas
# linhas como `income`) e subtraída de novo via `payments_total`: a conta erra
# pelo dobro do pagamento, e o dinheiro do usuário some do balanço.


async def _importar(svc: FinanceService, tmp_path, header: dict | None,
                    txs: list[dict] | None = None, arquivo: str = "c6.pdf"):
    """Uma importação inteira, com o PDF de verdade no disco.

    O nome do arquivo é o conteúdo: mesmo nome, mesmos bytes, mesmo hash — é
    assim que o reencontro acha a fatura sem depender do que o LLM leu.
    """
    pdf = tmp_path / arquivo
    pdf.write_bytes(f"%PDF-1.4 {arquivo}".encode())
    tool = ImportFinancialPdfTool(svc, llm=None)
    tool._last_invoice_header = header
    return await tool._insert_and_report(
        [dict(t) for t in (txs if txs is not None else _TXS)],
        "llm", 1, str(pdf), failures=[],
    )


# A leitura como o modelo de fato a devolve: a fatura de papel imprime o
# pagamento como crédito, e o LLM marca `type: income`.
_TXS_PAGAMENTO_COMO_RECEITA = [
    {"date": "2026-07-15", "description": "MERCADO", "amount": 6148.88,
     "type": "expense", "kind": "purchase"},
    {"date": "2026-07-01", "description": "Inclusao de Pagamento",
     "amount": 1233.63, "type": "income", "kind": "payment"},
    {"date": "2026-07-09", "description": "Inclusao de Pagamento",
     "amount": 850.0, "type": "income", "kind": "payment"},
]


async def test_o_pagamento_nao_e_descontado_duas_vezes(
    svc: FinanceService, tmp_path,
) -> None:
    """O erro pelo dobro, medido nos números da fatura real.

    Com o pagamento entrando em `inseridos` como `income`, a conferência
    recebe `1.373,63 - 2.083,63 + (6.148,88 - 2.083,63) = 3.355,25` contra os
    5.438,88 impressos — a fatura correta é rebaixada, e os dois lados erram
    juntos e em silêncio. Só a fatura nascendo `open` prova que as duas pontas
    concordam sobre o que é pagamento.
    """
    r = await _importar(svc, tmp_path, _HEADER, _TXS_PAGAMENTO_COMO_RECEITA)
    assert r.ok, r.error

    fatura = (await svc.list_open_invoices())[0]
    assert fatura.status == "open"
    entries = await svc.list_entries(limit=100)
    assert [e.amount for e in entries] == [6148.88], "só a compra entrou"
    assert all(e.type == "expense" for e in entries)


async def test_o_relatorio_diz_que_o_pagamento_foi_de_proposito(
    svc: FinanceService, tmp_path,
) -> None:
    """O resumo anuncia 1 transação para um documento com 3 linhas.

    Sem dizer por quê, o modelo — que acabou de ler as "Inclusao de Pagamento"
    no PDF — conclui que a importação falhou e as registra na mão, refazendo
    exatamente o estrago que esta task desfaz.
    """
    r = await _importar(svc, tmp_path, _HEADER)
    assert r.ok, r.error
    assert "R$ 2.083,63" in (r.output or ""), r.output
    assert "NAO viraram lancamento" in (r.output or "")
    assert "NAO registre esses pagamentos" in (r.output or "")


async def test_extrato_sem_fatura_nao_perde_o_pagamento_do_cartao(
    svc: FinanceService, tmp_path,
) -> None:
    """A borda oposta, e ela perde dinheiro de verdade.

    Num extrato de conta corrente a linha "PGTO FAT CARTAO" é uma despesa que
    aconteceu — o dinheiro saiu da conta — e o modelo pode marcá-la como
    `payment`, porque ela é, de fato, o pagamento de uma fatura. Sem cabeçalho
    não existe fatura para descontá-la nem coluna onde gravá-la: filtrar aqui
    apagaria o gasto do balanço em silêncio.
    """
    txs = [
        {"date": "2026-07-15", "description": "MERCADO", "amount": 100.0,
         "type": "expense"},
        {"date": "2026-07-20", "description": "PGTO FAT CARTAO",
         "amount": 240.0, "type": "expense", "kind": "payment"},
    ]
    r = await _importar(svc, tmp_path, None, txs)
    assert r.ok, r.error

    assert await svc.list_open_invoices() == [], "extrato comum não vira fatura"
    entries = await svc.list_entries(limit=100)
    assert sorted(e.amount for e in entries) == [100.0, 240.0]
    assert (await svc.get_monthly_summary(7, 2026))["expenses"] == 340.0


# --- a coerção na fronteira -------------------------------------------
#
# `create_invoice` grava o que recebe, sem coagir tipo: um `""` ou um `"n/a"`
# vindo do LLM iria para uma coluna REAL do SQLite como TEXT e voltaria
# string — nem NULL nem número, envenenando a distinção "não consegui ler"
# contra "li, e era zero". `normalize_invoice_header` é a única fronteira.


async def test_saldo_em_formato_brasileiro_e_entendido(
    svc: FinanceService, tmp_path,
) -> None:
    """`R$ 1.373,63` é o formato do documento. Recusá-lo daria needs_review
    na fatura que a conta aprova."""
    await _importar(svc, tmp_path, {**_HEADER, "previous_balance": "R$ 1.373,63"})
    fatura = (await svc.list_open_invoices())[0]
    assert fatura.previous_balance == 1373.63
    assert isinstance(fatura.previous_balance, float), "REAL, nunca TEXT"
    assert fatura.status == "open"


@pytest.mark.parametrize("lixo", ["", "n/a", "nao encontrado", "  "])
async def test_saldo_ilegivel_vira_nulo_e_nao_texto(
    svc: FinanceService, tmp_path, lixo: str,
) -> None:
    """Ilegível é NULL, e NULL é "não sei" — não é zero e não é a string crua.

    Gravado como TEXT, o campo voltaria como `"n/a"`, que é *truthy*: a guarda
    `previous_balance is None` não o pegaria e `float("n/a")` estouraria
    ValueError no meio da importação seguinte.
    """
    await _importar(svc, tmp_path, {**_HEADER, "previous_balance": lixo})
    fatura = (await svc.list_open_invoices())[0]
    assert fatura.previous_balance is None
    assert fatura.status == "needs_review"


async def test_saldo_zero_lido_e_gravado_como_zero(
    svc: FinanceService, tmp_path,
) -> None:
    """O outro lado da distinção: a primeira fatura de um cartão abriu zerada,
    e zero LIDO autoriza a conta a fechar."""
    header = {**_HEADER, "total": 6148.88, "previous_balance": 0.0}
    txs = [{"date": "2026-07-15", "description": "MERCADO",
            "amount": 6148.88, "kind": "purchase"}]
    await _importar(svc, tmp_path, header, txs)
    fatura = (await svc.list_open_invoices())[0]
    assert fatura.previous_balance == 0.0
    assert fatura.payments_total == 0.0
    assert fatura.status == "open"


# --- o ramo reencontrado confere contra o BANCO -----------------------
#
# A distinção que cinco rounds anteriores construíram: a segunda leitura é
# justamente a que não merece confiança, então não pode ser ela a definir o
# número de referência. Já estava presa para o `total`
# (test_total_tremido_na_releitura_nao_rebaixa_fatura_correta); as duas
# referências novas entram pela mesma porta.


@pytest.mark.parametrize(
    "saldo_tremido", [None, 999999.0, "nao encontrado", ""],
    ids=["omitido", "digito-a-mais", "ilegivel", "vazio"],
)
async def test_saldo_tremido_na_releitura_nao_rebaixa_fatura_correta(
    svc: FinanceService, tmp_path, saldo_tremido: object,
) -> None:
    """A fatura está íntegra no banco e a releitura erra o saldo anterior.

    Rebaixar aqui seria porta de mão única — nada no produto devolve uma
    fatura para `open` — por causa de um número que o modelo leu torto na
    segunda passada.
    """
    await _importar(svc, tmp_path, _HEADER)
    fatura = (await svc.list_open_invoices())[0]
    assert fatura.status == "open"

    r = await _importar(
        svc, tmp_path, {**_HEADER, "previous_balance": saldo_tremido},
    )
    assert r.ok, r.error
    assert r.metadata.get("transactions") == 0, "a reimportação não insere nada"
    assert r.metadata.get("invoice_reconciles") is True
    assert (await svc.get_invoice(fatura.id)).status == "open"


async def test_fatura_gravada_sem_saldo_nao_se_conferir_e_vai_para_revisao(
    svc: FinanceService, tmp_path,
) -> None:
    """O preço declarado do ramo reencontrado ler o banco.

    Uma fatura criada antes destas colunas existirem tem `previous_balance`
    NULL, e `fill_invoice_header` não sabe escrever esse campo. Reimportar não
    a conserta: sem referência não há conferência, e ela se declara suspeita
    em vez de afirmar que bate. Rebaixa, nunca promove — é o lado seguro de
    errar, e está medido aqui para não passar por regressão.

    TODO(follow-up): este teste prende um comportamento SEGURO, não um
    comportamento CERTO, e é temporário. O caso doloroso é o do usuário que
    segue o reparo que a própria ferramenta recomenda — apagar os lançamentos
    e reenviar o PDF — e mesmo assim vê a fatura rebaixada, porque as duas
    colunas novas nunca chegam ao banco.

    O reparo é maior do que uma linha: dois `COALESCE` em
    `fill_invoice_header` (`packages/mod-finance/src/mod_finance/service.py`),
    coerentes com o contrato "só preenche buraco" dele, MAIS os dois
    parâmetros correspondentes em `_fill_invoice_header`
    (`seraphine/tools/financial.py`), que hoje só repassa fechamento,
    vencimento e total.

    E ele entrega menos do que promete. Medido nos dois estados possíveis:

    O QUE OS COALESCE RESOLVEM — a fatura que ainda está `open` deixa de ser
    rebaixada no reenvio, porque a conferência volta a ter as três
    referências. É a forma que este teste monta hoje (`create_invoice` nasce
    `open`), então a asserção abaixo fica VERMELHA e trocá-la por `open`
    resolve o teste.

    O QUE ELES NÃO RESOLVEM — e é o caso do parágrafo de cima: a fatura que já
    está em `needs_review`, que é justamente o motivo de a ferramenta ter
    mandado reenviar, continua em `needs_review`. Com as colunas escritas, o
    ramo reencontrado-e-vazio de `_prepare_invoice` só REBAIXA, e
    `_reconcile_after_insert` retorna cedo em `needs_review`. Não existe
    primitiva de promoção neste produto: `flag_invoice_for_review` escreve
    `needs_review`, `mark_invoice_paid` escreve `paid`, `fill_invoice_header`
    não toca no status por decisão declarada, e `create_invoice` só decide no
    nascimento.

    Então "exigir `open` depois do reenvio" não é consequência dos COALESCE:
    para o usuário do parágrafo, depende de uma decisão de PRODUTO sobre
    promover fatura — quem promove, sob que evidência, e o que fazer com o
    sinal em que o usuário pode ter se apoiado. Essa decisão não existe hoje e
    o spec a pôs fora de escopo. Quem pegar este follow-up ou a toma primeiro,
    ou entrega só a metade `open`-continua-`open` e deixa este parágrafo de
    pé.
    """
    inv = await svc.create_invoice(
        card="C6 Carbon", closing_date=None, due_date="2026-08-01",
        total=5438.88,
    )
    assert (await svc.get_invoice(inv)).previous_balance is None

    r = await _importar(svc, tmp_path, _HEADER)
    assert r.ok, r.error
    assert (await svc.get_invoice(inv)).status == "needs_review"
    # E os lançamentos entraram na fatura que já existia, sem criar uma gêmea.
    entries = await svc.list_entries(limit=100)
    assert [e.invoice_id for e in entries] == [inv]


# --- o lote que nunca respondeu sobre `kind` --------------------------
#
# `str(t.get("kind") or "purchase")` não distingue "o modelo disse purchase" de
# "o modelo nunca emitiu o campo". Esta é a mais arriscada das duas
# dependências do LLM — `previous_balance` ausente falha alto, `kind` ausente
# falharia calado — e a álgebra conspira para escondê-la.


# A fatura do C6 exatamente como o modelo a devolve HOJE, com o prompt antigo:
# sem `kind` em lugar nenhum, e os pagamentos marcados como receita.
_TXS_SEM_KIND = [
    {"date": "2026-07-15", "description": "MERCADO", "amount": 6148.88,
     "type": "expense"},
    {"date": "2026-07-01", "description": "Inclusao de Pagamento",
     "amount": 1233.63, "type": "income"},
    {"date": "2026-07-09", "description": "Inclusao de Pagamento",
     "amount": 850.0, "type": "income"},
]


async def test_lote_sem_kind_nao_afirma_que_ninguem_pagou(
    svc: FinanceService, tmp_path,
) -> None:
    """Zero sobre pergunta não feita, e a conta fecharia por coincidência.

    Medido: sem `kind`, as três linhas viram lançamento, `sum_amounts` com
    sinal dá 4.065,25, e `1.373,63 - 0 + 4.065,25 = 5.438,88` bate EXATO —
    subtrair o pagamento via `payments_total` e subtraí-lo como receita
    negativa são a mesma álgebra. A fatura nasceria `open` AFIRMANDO que
    fecha.

    A conta VELHA dava `needs_review` nesse mesmo read. Sem esta guarda a
    feature apagaria o alarme acidental que tornou o incidente original
    visível — trocaria um falso alarme útil por um silêncio confiante.

    O que a guarda troca é o status, e SÓ ele. A segunda metade deste teste
    prende o que ela **não** conserta, porque um docstring otimista faria um
    leitor futuro acreditar que o lado do dinheiro está resolvido.
    """
    r = await _importar(svc, tmp_path, _HEADER, _TXS_SEM_KIND)
    assert r.ok, r.error

    fatura = (await svc.list_open_invoices())[0]
    assert fatura.status == "needs_review"
    assert fatura.payments_total is None, "NULL é 'não sei', 0.0 seria 'ninguém pagou'"

    # O FATO DESAGRADÁVEL, preso de propósito: as três linhas entram, e agosto
    # ganha R$ 2.083,63 de receita que não existe. Sem `kind` isso é
    # INEVITÁVEL — uma linha `income` numa fatura é indistinguível de um
    # estorno, que por desenho reduz o total e TEM de ser gravado. A conta
    # velha também as inseria; o `needs_review` acima é a mitigação, não a
    # cura. A cura é o modelo devolver `kind`, e é o que o prompt pede.
    #
    # Se um dia esta asserção falhar porque a receita sumiu, não "conserte" o
    # teste: alguém resolveu o problema, e é o comentário que está velho.
    assert len(await svc.list_entries(limit=100)) == 3
    resumo = await svc.get_monthly_summary(8, 2026)
    assert resumo["income"] == 2083.63, "a receita fantasma entra — é o preço sem `kind`"
    assert resumo["expenses"] == 6148.88


async def test_lote_inteiro_rotulado_autoriza_o_zero(
    svc: FinanceService, tmp_path,
) -> None:
    """O outro lado: o modelo respondeu em TODAS as linhas, e nenhuma era
    pagamento.

    Aí o zero é uma soma sobre enumeração completa — a primeira fatura de um
    cartão, em que ninguém pagou nada mesmo — e a fatura pode se dizer
    completa. Sem este lado, a guarda acima viraria "toda fatura vai para
    revisão", que é o defeito que a Task 3 desfez.
    """
    txs = [{"date": "2026-07-15", "description": "MERCADO", "amount": 6148.88,
            "type": "expense", "kind": "purchase"}]
    r = await _importar(
        svc, tmp_path, {**_HEADER, "total": 6148.88, "previous_balance": 0.0},
        txs,
    )
    assert r.ok, r.error

    fatura = (await svc.list_open_invoices())[0]
    assert fatura.payments_total == 0.0
    assert fatura.status == "open"


async def test_a_reimportacao_tambem_avisa_sobre_os_pagamentos(
    svc: FinanceService, tmp_path,
) -> None:
    """Na reimportação nada é inserido — e o modelo acabou de reler as mesmas
    linhas de pagamento no PDF. Sem o aviso ele não as encontra entre os
    lançamentos ligados e conclui que faltam, que é a mesma tentação que o
    relatório da importação já desarma."""
    await _importar(svc, tmp_path, _HEADER)
    r = await _importar(svc, tmp_path, _HEADER)
    assert r.ok, r.error
    assert r.metadata.get("transactions") == 0, "nada pode ter sido inserido"
    assert "R$ 2.083,63" in (r.output or ""), r.output
    assert "NAO registre esses pagamentos" in (r.output or "")


# A rotulagem PARCIAL: o modelo marca as compras e esquece as linhas de
# pagamento. Não é hipótese — é o que ele faz quando o exemplo de JSON do
# prompt não traz `kind`, a `temperature: 0.7`.
_TXS_KIND_PELA_METADE = [
    {"date": "2026-07-15", "description": "MERCADO", "amount": 6148.88,
     "type": "expense", "kind": "purchase"},
    {"date": "2026-07-01", "description": "Inclusao de Pagamento",
     "amount": 1233.63, "type": "income"},
    {"date": "2026-07-09", "description": "Inclusao de Pagamento",
     "amount": 850.0, "type": "income"},
]


async def test_rotulagem_parcial_nao_grava_zero_falso(
    svc: FinanceService, tmp_path,
) -> None:
    """O incidente original de volta, e sem alarme — foi o que se mediu.

    Com `any(kind usável)`, UMA compra marcada bastava para autorizar
    `payments_total = 0.0`. Medido no caminho real:

        status='open'   payments_total = REAL 0.0   (o zero falso PERSISTIDO)
        agosto/2026: income=2083.63  expenses=6148.88
        reimportação: "a fatura ja esta completa", invoice_reconciles=True

    E `_linha_dos_pagamentos(0.0)` devolve None, então nem o aviso saía. Antes
    desta feature o mesmo lote dava `needs_review`.
    """
    r = await _importar(svc, tmp_path, _HEADER, _TXS_KIND_PELA_METADE)
    assert r.ok, r.error

    fatura = (await svc.list_open_invoices())[0]
    assert fatura.status == "needs_review"
    assert fatura.payments_total is None, \
        "0.0 aqui é o zero falso: ninguém perguntou sobre as linhas de pagamento"


async def test_rotulagem_parcial_nao_diz_que_a_fatura_esta_completa(
    svc: FinanceService, tmp_path,
) -> None:
    """A ponta que o modelo lê. Com o zero falso gravado, a reimportação
    afirmava `invoice_reconciles: True` e "a fatura ja esta completa" sobre
    uma fatura com R$ 2.083,63 de receita fantasma dentro."""
    await _importar(svc, tmp_path, _HEADER, _TXS_KIND_PELA_METADE)
    r = await _importar(svc, tmp_path, _HEADER, _TXS_KIND_PELA_METADE)
    assert r.ok, r.error
    assert r.metadata.get("invoice_reconciles") is False
    assert "ja esta completa" not in (r.output or ""), r.output
    assert "NAO DA PARA CONFERIR" in (r.output or "")
    assert "NAO quer dizer que falta lancamento" in (r.output or "")


# A rotulagem parcial na direção INVERSA, que é a que ninguém tinha medido: o
# modelo marca os PAGAMENTOS e esquece o `kind` de uma compra qualquer. É o
# deslize provável justamente porque o prompt ensina `kind` como o marcador de
# pagamento — esquecê-lo numa linha comum de compra é o caminho de menor
# atenção.
_TXS_COMPRA_SEM_KIND = [
    {"date": "2026-07-15", "description": "MERCADO", "amount": 6000.0,
     "type": "expense", "kind": "purchase"},
    # A linha que esqueceu o campo. É uma COMPRA, e o default já a trata como
    # tal — o estrago não está na inserção, está no que se diz sobre ela.
    {"date": "2026-07-16", "description": "PADARIA", "amount": 148.88,
     "type": "expense"},
    {"date": "2026-07-01", "description": "Inclusao de Pagamento",
     "amount": 1233.63, "type": "income", "kind": "payment"},
    {"date": "2026-07-09", "description": "Inclusao de Pagamento",
     "amount": 850.0, "type": "income", "kind": "payment"},
]


async def test_o_aviso_de_pagamento_sai_mesmo_com_a_rotulagem_pela_metade(
    svc: FinanceService, tmp_path,
) -> None:
    """Duas perguntas diferentes, e o aviso estava lendo a resposta da outra.

    `payments_total_for` responde "a rotulagem está completa?" — e nesta
    leitura a resposta é não, então ela devolve None, a coluna fica NULL e a
    fatura vai para revisão. Tudo certo desse lado.

    O aviso responde outra coisa: "linhas foram TIRADAS da inserção?". Aqui
    foram duas, somando R$ 2.083,63, e isso é um fato sobre o que a importação
    acabou de fazer — não depende de `kind` estar completo em lugar nenhum.
    Alimentado pela resposta errada, ele sumia. Medido, com estas 4 linhas:

        compras inseridas    : 2 de 4 linhas do PDF
        payments_total_for   : None   -> persistido como NULL
        linha de aviso       : None          <-- desaparecia
        status               : needs_review

    Na fatura real são 40 de 46, o resumo abre com `SUCESSO: 40 transacoes JA
    FORAM REGISTRADAS`, e nada explica as seis "Inclusao de Pagamento" que o
    modelo acabou de ler no PDF. Ele conclui que faltam e as cadastra na mão —
    a receita fantasma de volta, agora com a bênção do usuário.
    """
    r = await _importar(svc, tmp_path, _HEADER, _TXS_COMPRA_SEM_KIND)
    assert r.ok, r.error
    assert r.metadata.get("transactions") == 2, "as duas compras entraram"

    saida = r.output or ""
    assert "R$ 2.083,63" in saida, saida
    assert "NAO viraram lancamento" in saida
    assert "NAO registre esses pagamentos" in saida

    # E a outra pergunta continua com a fonte dela: rotulagem incompleta não
    # autoriza a coluna nem o `open`.
    fatura = (await svc.list_open_invoices())[0]
    assert fatura.payments_total is None, "NULL é 'não sei', e a rotulagem veio pela metade"
    assert fatura.status == "needs_review"


async def test_o_exemplo_do_prompt_traz_kind_e_nao_so_a_prosa() -> None:
    """O modelo copia o exemplo; a prosa ele lê.

    `kind` estava descrito em palavras e ausente do JSON de exemplo — e é o
    JSON que vira o formato da resposta, a `temperature: 0.7`. Foi assim que a
    rotulagem parcial deixou de ser hipótese.
    """
    prompt = ImportFinancialPdfTool._pdf_prompt("mercado, outros")
    assert '"kind":"purchase"' in prompt, "o exemplo de transação tem de trazer o campo"
    # E o exemplo do cabeçalho continua trazendo o saldo, pelo mesmo motivo.
    assert '"previous_balance":1373.63' in prompt
    # A prosa tem de dizer que é em TODAS: marcar parte é pior que não marcar.
    assert "TODAS as transacoes levam `kind`" in prompt


async def test_a_conferencia_mostra_a_conta_que_decidiu_o_veredito(
    svc: FinanceService, tmp_path,
) -> None:
    """A mensagem imprimia `somando R$ 6.148,88 (total gravado: R$ 5.438,88)`
    e logo abaixo "A soma bate com o total gravado" — duas verdades opostas na
    mesma mensagem, no caminho FELIZ da fatura real.

    O texto era verbatim de quando `bate` significava `soma == total`; a
    conferência passou a ser `saldo - pagamentos + compras = total` e o texto
    não acompanhou. Agora o número exibido sai da conta que decidiu.
    """
    await _importar(svc, tmp_path, _HEADER)
    r = await _importar(svc, tmp_path, _HEADER)
    assert r.ok, r.error
    assert r.metadata.get("invoice_reconciles") is True

    saida = r.output or ""
    assert "A conta da fatura FECHA" in saida
    assert "saldo anterior R$ 1.373,63" in saida, saida
    assert "pagamentos R$ 2.083,63" in saida
    assert "lancamentos R$ 6.148,88" in saida
    assert "= R$ 5.438,88, contra R$ 5.438,88 de total gravado" in saida
    # E a frase que afirmava o falso não pode ter sobrado.
    assert "A soma bate com o total gravado" not in saida


async def test_o_aviso_de_revisao_nao_promete_a_conta_removida(
    svc: FinanceService, tmp_path,
) -> None:
    """A mensagem irmã de `_texto_da_conta`, que não recebeu o mesmo conserto.

    "ou a soma dos lancamentos nao bate com o total impresso" é verbatim de
    antes desta branch, quando `bate` significava `soma == total`. A conta
    virou `saldo anterior - pagamentos + compras = total` e o texto ficou
    prometendo a antiga — e omitindo a terceira causa que a branch introduziu:
    referência ausente, em que NÃO DEU para conferir.

    Pior, ela acusa o usuário de ter perdido lançamento, que é exatamente o
    que `_texto_da_conta` decidiu explicitamente não fazer. Isso dispara na
    PRIMEIRA importação de toda fatura que vai para revisão. Junto com a
    contagem curta do resumo, o modelo conclui que faltam linhas e as cadastra
    na mão.
    """
    r = await _importar(svc, tmp_path, {**_HEADER, "previous_balance": None})
    assert r.ok, r.error
    fatura = (await svc.list_open_invoices())[0]
    assert fatura.status == "needs_review", "é o caminho que emite o aviso"

    saida = r.output or ""
    assert "a fatura ficou em revisao" in saida, saida
    # A fórmula REMOVIDA não pode continuar sendo prometida.
    assert "a soma dos lancamentos nao bate com o total impresso" not in saida
    # As três causas reais, cada uma nomeada.
    assert "vencimento" in saida
    assert "NAO DEU para conferir" in saida
    assert "saldo anterior - pagamentos + lancamentos = total impresso" in saida
    # E o que a irmã já tinha decidido não acusar.
    assert "nada aqui afirma que falta lancamento" in saida
    assert "nao recadastre lancamento nenhum" in saida
