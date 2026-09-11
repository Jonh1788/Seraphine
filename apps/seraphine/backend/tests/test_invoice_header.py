"""A conferência do total impresso.

Uma fatura pela metade que se apresenta como completa é pior que uma que
se declara suspeita — foi assim que a fatura do C6 gerou um diagnóstico
errado com confiança.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path

import pytest
import pytest_asyncio

from core_db import Store
from mod_finance import schema as finance_schema
from mod_finance.models import FinancialEntry
from mod_finance.service import FinanceService
from seraphine.tools.financial import (
    ImportFinancialPdfTool,
    invoice_status_for,
    reconcile_invoice,
    split_invoice_payload,
)


def _conferir(txs: list[dict], total: float | None) -> bool:
    """A conferência como este arquivo sempre a fez, na função nova.

    `reconcile_invoice_total` foi removida junto com a conta velha, mas o que
    ela media continua medido aqui: saldo anterior e pagamentos ZERO —
    explícito, não ausente. É a primeira fatura de um cartão, o único caso em
    que somar as transações contra o total impresso é a conta certa.
    """
    return reconcile_invoice(
        purchases=txs, payments_total=0.0, previous_balance=0.0, total=total,
    )


def test_soma_bate_com_o_total() -> None:
    txs = [{"amount": 100.0}, {"amount": 140.0}]
    assert _conferir(txs, 240.0) is True


def test_diferenca_de_centavo_e_tolerada() -> None:
    """Arredondamento de PDF não é fatura incompleta."""
    txs = [{"amount": 100.0}, {"amount": 140.0}]
    assert _conferir(txs, 240.01) is True


def test_soma_menor_que_o_total_nao_bate() -> None:
    """O caso real: o parser perdeu páginas."""
    txs = [{"amount": 100.0}]
    assert _conferir(txs, 5438.88) is False


def test_soma_maior_que_o_total_tambem_nao_bate() -> None:
    txs = [{"amount": 100.0}, {"amount": 200.0}]
    assert _conferir(txs, 240.0) is False


def test_sem_total_impresso_nao_da_para_conferir() -> None:
    """Sem referência não existe conferência — não invente um `True`."""
    txs = [{"amount": 100.0}]
    assert _conferir(txs, None) is False


def test_lista_vazia_com_total_nao_bate() -> None:
    assert _conferir([], 240.0) is False


def test_amount_ilegivel_nao_derruba_a_conferencia() -> None:
    txs = [{"amount": 100.0}, {"amount": "abc"}, {}]
    assert _conferir(txs, 100.0) is True


# --- o status da fatura importada -----------------------------------

# `previous_balance: 0.0` é a primeira fatura do cartão — saldo LIDO e igual a
# zero, que é o mundo que este arquivo sempre descreveu (240,00 de compras,
# 240,00 impressos, nada vindo do período anterior). Zero explícito confere;
# ausente seria "não deu para ler" e mandaria tudo para revisão, medindo outra
# coisa. A distinção entre os dois está presa em tests/test_conferencia_fatura.py.
_OK = {"card": "C6", "due_date": "2026-08-10", "total": 240.0,
       "previous_balance": 0.0}
# `kind` em toda linha pelo mesmo motivo do saldo zero explícito: é a resposta
# do modelo sobre o campo, e é ela que autoriza `payments_total = 0.0` a
# significar "ninguém pagou nada" em vez de "ninguém foi perguntado". Um lote
# inteiro SEM `kind` vai para `needs_review` de propósito — está preso em
# tests/test_import_saldo_anterior.py.
_TXS = [{"amount": 100.0, "kind": "purchase"},
        {"amount": 140.0, "kind": "purchase"}]


def test_cabecalho_completo_e_soma_batendo_abre_a_fatura() -> None:
    assert invoice_status_for(_OK, _TXS) == "open"


def test_soma_divergente_manda_para_revisao() -> None:
    """Uma fatura pela metade não pode se apresentar como completa."""
    assert invoice_status_for({**_OK, "total": 5438.88}, _TXS) == "needs_review"


def test_sem_vencimento_manda_para_revisao() -> None:
    """Sem vencimento ela não tem mês; ficar em aberto seria sumir calada."""
    assert invoice_status_for({**_OK, "due_date": None}, _TXS) == "needs_review"


def test_vencimento_vazio_conta_como_ausente() -> None:
    assert invoice_status_for({**_OK, "due_date": ""}, _TXS) == "needs_review"


@pytest.mark.parametrize(
    "vencimento",
    ["10/08/2026", "10-08-2026", "2026-13-45", "2026-02-30", "2026-8-10",
     "20260810", "2026-08-10T00:00:00", "ate 10 de agosto"],
)
def test_vencimento_fora_do_iso_conta_como_ausente(vencimento: str) -> None:
    """`10/08/2026` é o formato natural do LLM em PT-BR, e o mês de caixa
    recorta com `substr(due_date, 1, 7)` — um corte posicional, não uma
    leitura. Ele viraria o mês `10/08/2`, que não casa com mês algum: a
    despesa some de TODOS os meses enquanto a fatura se diz `open`.

    Adivinhar o dia seria mover dinheiro de mês por chute. `needs_review` é
    a resposta honesta: a fatura existe e se declara suspeita."""
    assert invoice_status_for({**_OK, "due_date": vencimento}, _TXS) == "needs_review"


def test_vencimento_iso_de_verdade_ainda_abre_a_fatura() -> None:
    """A validação não pode fechar a porta do caminho honesto."""
    assert invoice_status_for({**_OK, "due_date": "2026-02-29"}, _TXS) == "needs_review"
    assert invoice_status_for({**_OK, "due_date": "2028-02-29"}, _TXS) == "open"


def test_sem_total_impresso_manda_para_revisao() -> None:
    """Sem total não dá para saber se veio inteira — não presuma que sim."""
    assert invoice_status_for({**_OK, "total": None}, _TXS) == "needs_review"


def test_vencimento_presente_nao_salva_soma_errada() -> None:
    """As duas condições valem juntas; uma não compensa a outra."""
    assert invoice_status_for({**_OK, "total": 999.0}, _TXS) == "needs_review"


# --- as duas formas de resposta do LLM -------------------------------


def test_array_puro_continua_sendo_extrato_sem_cabecalho() -> None:
    """O extrato comum não pode passar a criar fatura."""
    header, txs = split_invoice_payload([{"amount": 1.0}])
    assert header is None
    assert txs == [{"amount": 1.0}]


def test_objeto_com_invoice_separa_cabecalho_das_transacoes() -> None:
    header, txs = split_invoice_payload(
        {"invoice": {"card": "C6"}, "transactions": [{"amount": 1.0}]}
    )
    assert header == {"card": "C6"}
    assert txs == [{"amount": 1.0}]


def test_objeto_sem_invoice_ainda_entrega_as_transacoes() -> None:
    header, txs = split_invoice_payload({"transactions": [{"amount": 1.0}]})
    assert header is None
    assert txs == [{"amount": 1.0}]


def test_resposta_de_formato_estranho_nao_vira_transacao() -> None:
    """String, número ou `invoice` que não é objeto: nada a inserir."""
    assert split_invoice_payload("blá") == (None, [])
    assert split_invoice_payload({"invoice": "C6", "transactions": "x"}) == (None, [])


# --- da resposta do LLM até a inserção -------------------------------

_RESPOSTA_FATURA = (
    '{"invoice": {"card": "C6", "closing_date": "2026-08-03",'
    ' "due_date": "2026-08-10", "total": 240.0},'
    ' "transactions": [{"type": "expense", "amount": 240.0,'
    ' "category": "outros", "description": "IFOOD", "date": "2026-07-15"}]}'
)


def test_o_cabecalho_lido_fica_guardado_para_a_insercao() -> None:
    """O fio entre ler e criar. Se ele se soltar, a importação volta a ser
    um monte de lançamento avulso e nada reclama."""
    tool = ImportFinancialPdfTool(service=None, llm=None)
    txs = tool._consume_extraction(_RESPOSTA_FATURA)
    assert len(txs) == 1
    assert tool._last_invoice_header is not None
    assert tool._last_invoice_header["card"] == "C6"


def test_resposta_em_bloco_de_codigo_ainda_entrega_o_cabecalho() -> None:
    tool = ImportFinancialPdfTool(service=None, llm=None)
    tool._consume_extraction(f"```json\n{_RESPOSTA_FATURA}\n```")
    assert tool._last_invoice_header is not None


def test_extrato_comum_nao_inventa_cabecalho() -> None:
    tool = ImportFinancialPdfTool(service=None, llm=None)
    txs = tool._consume_extraction('[{"amount": 1.0}]')
    assert txs == [{"amount": 1.0}]
    assert tool._last_invoice_header is None


class _FakeStream:
    """O suficiente de uma resposta SSE da Anthropic para o laço de leitura."""

    def __init__(self, linhas: list[str]) -> None:
        self._linhas = linhas

    async def __aenter__(self) -> "_FakeStream":
        return self

    async def __aexit__(self, *exc: object) -> bool:
        return False

    def raise_for_status(self) -> None:
        return None

    async def aiter_lines(self):
        for linha in self._linhas:
            yield linha


class _FakeHttp:
    def __init__(self, texto: str) -> None:
        self._texto = texto
        self.body: dict | None = None

    def stream(self, method: str, url: str, *, json: dict, timeout: float):
        self.body = json
        import json as _json

        metade = len(self._texto) // 2
        linhas = [
            "data: " + _json.dumps({
                "type": "content_block_delta",
                "delta": {"type": "text_delta", "text": pedaco},
            })
            for pedaco in (self._texto[:metade], self._texto[metade:])
        ]
        return _FakeStream([*linhas, "data: [DONE]"])


async def test_a_extracao_do_pdf_guarda_o_cabecalho_de_ponta_a_ponta() -> None:
    """O único caminho que roda em produção. Sem este teste, a extração podia
    devolver o array de sempre e a feature ficaria inerte com tudo verde."""
    from llm_adapters.anthropic import AnthropicClient

    llm = AnthropicClient(api_key="x", model="claude-sonnet-4-6")
    fake = _FakeHttp(_RESPOSTA_FATURA)
    llm._client = fake  # type: ignore[assignment]

    tool = ImportFinancialPdfTool(service=None, llm=llm)
    txs = await tool._llm_extract_pdf_stream(b"%PDF-1.4 fake", "outros")

    assert len(txs) == 1
    assert tool._last_invoice_header is not None
    assert tool._last_invoice_header["due_date"] == "2026-08-10"
    assert fake.body is not None
    enviado = fake.body["messages"][0]["content"]
    assert enviado[0]["type"] == "document"
    assert "FATURA DE CARTAO" in enviado[1]["text"]


async def test_execute_zera_o_cabecalho_do_pdf_anterior() -> None:
    """Sobra da importação anterior criaria uma fatura para o documento
    errado — o dinheiro de um cartão indo para o vencimento de outro."""
    tool = ImportFinancialPdfTool(service=None, llm=None)
    tool._last_invoice_header = {"card": "C6", "due_date": "2026-08-10"}
    r = await tool.execute({"file_path": "/tmp/nao-existe-seraphine-task5.pdf"})
    assert not r.ok
    assert tool._last_invoice_header is None


# --- a importação criando a fatura e ligando os lançamentos ----------


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


_PDF_TXS = [
    {"type": "expense", "amount": 100.0, "category": "alimentacao",
     "description": "IFOOD", "date": "2026-07-15", "kind": "purchase"},
    {"type": "expense", "amount": 140.0, "category": "transporte",
     "description": "UBER", "date": "2026-07-20", "kind": "purchase"},
]

# `previous_balance: 0.0` pelo mesmo motivo de `_OK`: é a primeira fatura do
# cartão, saldo LIDO e igual a zero — 240,00 de compras, 240,00 impressos,
# nada vindo do período anterior. O campo é LOAD-BEARING daqui para baixo: ele
# é gravado na fatura e é uma das três referências da conferência, então
# retirá-lo não faz estes testes medirem menos — faz todos eles medirem
# `needs_review`, porque sem saldo anterior não existe conta para fechar.
_HEADER = {"card": "C6", "closing_date": "2026-08-03",
           "due_date": "2026-08-10", "total": 240.0,
           "previous_balance": 0.0}


def _caminho_inexistente(svc: FinanceService) -> str:
    """Um caminho que garantidamente não é arquivo, dentro do `tmp_path`.

    Os testes que passam `source=None` estão medindo o mundo SEM identidade
    gravada, e essa medição só vale enquanto o caminho não existir. Um nome
    fixo em `/tmp` é compartilhado com a máquina inteira: bastaria alguém
    criá-lo uma vez para esses testes passarem a medir outra coisa, calados.
    O diretório do banco da fixture é por teste, e ninguém escreve aqui.
    """
    return str(svc._store.path.parent / "fatura-que-nao-existe.pdf")


def _arquivo_do_pdf(svc: FinanceService, nome: str) -> str:
    """Um PDF de verdade no disco, ao lado do banco da fixture.

    O hash da importação é dos BYTES, então o nome do arquivo tem de virar
    conteúdo diferente: dois nomes são dois documentos, o mesmo nome é o
    mesmo documento reenviado. Sem um arquivo real aqui, todo teste rodaria
    num mundo sem identidade — que é justamente o que não existe em produção.
    """
    caminho = svc._store.path.parent / nome
    caminho.write_bytes(f"%PDF-1.4 {nome}".encode())
    return str(caminho)


async def _importar(svc: FinanceService, header: dict | None,
                    txs: list[dict] | None = None,
                    source: str | None = "c6.pdf"):
    """Roda o trecho de inserção como se o LLM tivesse acabado de ler o PDF.

    `source` é o NOME do arquivo: o mesmo nome duas vezes é o mesmo PDF
    reenviado; nomes diferentes são documentos diferentes. `source=None`
    aponta para um caminho inexistente — é assim que se mede o mundo sem
    hash, onde só a chave forte `(cartão, vencimento)` responde.
    """
    tool = ImportFinancialPdfTool(service=svc)
    tool._last_invoice_header = header
    caminho = (_arquivo_do_pdf(svc, source) if source
               else _caminho_inexistente(svc))
    return await tool._insert_and_report(
        list(txs if txs is not None else _PDF_TXS),
        "llm-pdf", 1, caminho, failures=[],
    )


async def test_cabecalho_cria_a_fatura_e_liga_os_lancamentos(
    svc: FinanceService,
) -> None:
    """O laço que a feature inteira fecha: sem isso nada é alcançável."""
    r = await _importar(svc, _HEADER)
    assert r.ok, r.error

    abertas = await svc.list_open_invoices()
    assert len(abertas) == 1
    fatura = abertas[0]
    assert fatura.card == "C6"
    assert fatura.due_date == "2026-08-10"
    assert fatura.total == 240.0
    assert fatura.status == "open"

    entries = await svc.list_entries(limit=50)
    assert len(entries) == 2
    assert {e.invoice_id for e in entries} == {fatura.id}


async def test_extrato_sem_cabecalho_nao_cria_fatura(svc: FinanceService) -> None:
    """Não-regressão: extrato comum continua sendo lançamento avulso."""
    r = await _importar(svc, None)
    assert r.ok, r.error
    assert await svc.list_open_invoices() == []
    entries = await svc.list_entries(limit=50)
    assert len(entries) == 2
    assert {e.invoice_id for e in entries} == {None}


async def test_cabecalho_vazio_nao_cria_fatura(svc: FinanceService) -> None:
    """`"invoice": {}` é o LLM não achando nada, não uma fatura sem nome."""
    r = await _importar(svc, {})
    assert r.ok, r.error
    assert await svc.list_open_invoices() == []


async def test_soma_divergente_grava_a_fatura_para_revisao(
    svc: FinanceService,
) -> None:
    """Ela é criada e ligada do mesmo jeito — só não se diz completa."""
    r = await _importar(svc, {**_HEADER, "total": 5438.88})
    assert r.ok, r.error
    abertas = await svc.list_open_invoices()
    assert len(abertas) == 1
    assert abertas[0].status == "needs_review"
    entries = await svc.list_entries(limit=50)
    assert {e.invoice_id for e in entries} == {abertas[0].id}


@pytest.mark.parametrize(
    "quebrada",
    [
        {"date": "sei la"},
        {"date": ""},
        {"amount": 0},
        {"amount": "cento e quarenta"},
    ],
    ids=["data-ilegivel", "data-vazia", "valor-zero", "valor-ilegivel"],
)
async def test_transacao_descartada_faz_a_fatura_nascer_em_revisao(
    svc: FinanceService, quebrada: dict,
) -> None:
    """O status tem de valer para o que FICOU no banco. O laço descarta
    transação com data ilegível, valor <= 0 ou erro de inserção; contar o que
    o LLM leu deixa a fatura nascer `open` com o total cheio gravado e metade
    dos lançamentos — na PRIMEIRA importação, que é o fluxo que a feature
    existe para servir."""
    r = await _importar(svc, _HEADER, txs=[
        _PDF_TXS[0],
        {**_PDF_TXS[1], **quebrada},
    ])
    assert r.ok, r.error
    assert r.metadata.get("transactions") == 1

    abertas = await svc.list_open_invoices()
    assert len(abertas) == 1
    assert abertas[0].status == "needs_review"
    assert abertas[0].total == 240.0, "o total lido continua gravado"
    assert r.metadata.get("invoice_status") == "needs_review"
    assert "ATENCAO" in (r.output or "")
    assert "revisao" in (r.output or "")


async def test_fatura_vazia_reencontrada_com_transacao_descartada_e_rebaixada(
    svc: FinanceService,
) -> None:
    """O mesmo descarte no ramo reencontrado. Aqui a leitura RECONCILIA
    (100 + 140 = 240), então a conferência de antes do laço passa: só a de
    depois vê que um dos dois não entrou."""
    inv = await svc.create_invoice(card="C6", closing_date=None,
                                   due_date="2026-08-10", total=240.0)
    r = await _importar(svc, _HEADER, txs=[
        _PDF_TXS[0],
        {**_PDF_TXS[1], "date": "sei la"},
    ])
    assert r.ok, r.error
    assert r.metadata.get("transactions") == 1
    assert (await svc.get_invoice(inv)).status == "needs_review"


async def test_data_vazia_no_cabecalho_vira_null_e_nao_string(
    svc: FinanceService,
) -> None:
    """String vazia produziria o mês `''` e o gasto sumiria do balanço."""
    r = await _importar(
        svc, {**_HEADER, "closing_date": "", "due_date": ""},
    )
    assert r.ok, r.error
    abertas = await svc.list_open_invoices()
    assert len(abertas) == 1
    assert abertas[0].closing_date is None
    assert abertas[0].due_date is None
    assert abertas[0].status == "needs_review"


async def test_data_do_cabecalho_fora_do_iso_vira_null_e_a_fatura_se_declara(
    svc: FinanceService,
) -> None:
    """O mesmo buraco pela importação. `10/08/2026` gravado cru daria o mês
    `10/08/2` no `substr`: a fatura nasceria `open`, a mensagem diria
    "registrada, status open", e nenhum mês teria a despesa.

    Aqui a data ilegível é descartada — não recusada: a fatura vai para
    `needs_review` pelo caminho que o spec já desenhou, os lançamentos entram
    e o histórico continua mostrando as compras nas datas certas."""
    r = await _importar(
        svc, {**_HEADER, "closing_date": "03/08/2026", "due_date": "10/08/2026"},
    )
    assert r.ok, r.error

    abertas = await svc.list_open_invoices()
    assert len(abertas) == 1
    fatura = abertas[0]
    assert fatura.due_date is None, "data fora do ISO nao pode ser gravada crua"
    assert fatura.closing_date is None
    assert fatura.status == "needs_review"
    assert r.metadata.get("invoice_status") == "needs_review"
    # E o usuário tem de ver o aviso: uma fatura suspeita calada não serve.
    assert "ATENCAO" in (r.output or "")
    assert "revisao" in (r.output or "")

    # Os lançamentos entraram e continuam com a data da COMPRA.
    entries = await svc.list_entries(limit=50)
    assert len(entries) == 2
    assert {e.invoice_id for e in entries} == {fatura.id}
    assert sorted(e.date for e in entries) == ["2026-07-15", "2026-07-20"]


async def _conferir_uma_so_fatura(svc: FinanceService) -> None:
    """1 fatura, 2 lançamentos, R$ 240,00 — o documento importado uma vez."""
    faturas = await svc.list_open_invoices()
    assert len(faturas) == 1, "reimportar não pode criar uma segunda fatura"
    entries = await svc.list_entries(limit=50)
    assert len(entries) == 2, "reimportar não pode reinserir os lançamentos"
    assert sum(e.amount for e in entries) == 240.0
    assert {e.invoice_id for e in entries} == {faturas[0].id}


# O cabeçalho podre em duas doses. Nenhuma das duas é chave: sem vencimento
# legível, quem reencontra a fatura é o hash do arquivo, e mais nada.
_SEM_VENCIMENTO = {**_HEADER, "due_date": "10/08/2026"}
_CABECALHO_CEGO = {**_HEADER, "due_date": "10/08/2026",
                   "closing_date": "03/08/2026"}


async def test_reimportar_cabecalho_fora_do_iso_nao_dobra_o_dinheiro(
    svc: FinanceService,
) -> None:
    """A regressão que o conserto das datas abriu: com `due_date` anulado, a
    busca da reimportação desistia e o mesmo PDF criava uma SEGUNDA fatura,
    reinserindo tudo (a inserção usa `skip_dedup=True`). Medido: 2 faturas,
    4 lançamentos, R$ 480,00 num documento de R$ 240,00 — e a resposta dizia
    "SUCESSO: 2 transacoes JA FORAM REGISTRADAS".

    O agravante é o laço: o próprio conserto empurra essas faturas para
    `needs_review`, que é exatamente o sinal que convida a reenviar o PDF.

    Quem fecha isto hoje é o hash do arquivo: nenhum campo do cabeçalho está
    legível, e mesmo assim o mesmo PDF é o mesmo PDF.
    """
    await _importar(svc, _CABECALHO_CEGO)
    r = await _importar(svc, _CABECALHO_CEGO)
    assert r.ok, r.error
    await _conferir_uma_so_fatura(svc)
    assert r.metadata.get("transactions") == 0


async def test_reimportar_sem_vencimento_legivel_reencontra_pelo_hash(
    svc: FinanceService,
) -> None:
    """O degrau que a cascata de chaves fracas existia para servir, e que
    agora é uma linha: o mesmo arquivo é a mesma fatura.

    O cabeçalho não oferece nada — `10/08/2026` não é ISO, então a fatura
    nasce sem vencimento e sem mês de caixa. O fechamento, que a versão
    anterior usava como chave, pertence a um ciclo com a mesma facilidade
    com que pertence a outro; os bytes do PDF não.
    """
    await _importar(svc, _SEM_VENCIMENTO)
    fatura = (await svc.list_open_invoices())[0]
    assert fatura.due_date is None
    assert fatura.closing_date == "2026-08-03"
    assert fatura.source_hash, "a identidade tem de ficar GRAVADA na fatura"

    r = await _importar(svc, _SEM_VENCIMENTO)
    assert r.ok, r.error
    await _conferir_uma_so_fatura(svc)


async def test_sem_hash_e_sem_vencimento_legivel_nasce_outra_fatura(
    svc: FinanceService,
) -> None:
    """A outra metade da mesma decisão, e o preço declarado.

    Sem arquivo legível (aqui: um caminho que não existe) e sem vencimento no
    ISO não há identidade nenhuma — criar fatura nova é o comportamento, e
    adivinhar por fechamento ou por total é o que produziu cinco rounds de
    variantes da mesma falha.

    O que segura o estrago é o que essas faturas são: `due_date` NULL, mês de
    caixa NULL — fora de todo resumo mensal — e `needs_review` nas duas.
    Barulhento e fora do balanço.
    """
    await _importar(svc, _SEM_VENCIMENTO, source=None)
    r = await _importar(svc, _SEM_VENCIMENTO, source=None)
    assert r.ok, r.error

    faturas = await svc.list_open_invoices()
    assert len(faturas) == 2, "sem identidade, duplicar é o comportamento"
    assert {f.status for f in faturas} == {"needs_review"}
    assert {f.due_date for f in faturas} == {None}
    assert {f.source_hash for f in faturas} == {None}
    entries = await svc.list_entries(limit=50)
    assert sum(e.amount for e in entries) == 480.0
    for mes in (7, 8, 9):
        resumo = await svc.get_monthly_summary(mes, 2026)
        assert resumo["expenses"] == 0.0, f"mês {mes} não vê o dinheiro dobrado"


async def test_leitura_boa_e_leitura_tremida_do_mesmo_pdf_sao_a_mesma_fatura(
    svc: FinanceService,
) -> None:
    """As duas leituras do mesmo arquivo discordam justamente no campo que
    faltou numa delas — e é por isso que o reencontro não pode depender de
    campo lido. O hash não muda com a temperatura do modelo."""
    await _importar(svc, _HEADER)
    r = await _importar(svc, _SEM_VENCIMENTO)
    assert r.ok, r.error
    await _conferir_uma_so_fatura(svc)
    # E a fatura boa não é rebaixada nem perde o vencimento que já tinha.
    fatura = (await svc.list_open_invoices())[0]
    assert fatura.due_date == "2026-08-10"
    assert fatura.status == "open"


async def test_a_tremida_primeiro_e_a_boa_depois_do_mesmo_arquivo_sao_uma_so(
    svc: FinanceService,
) -> None:
    """O limite 2 dos rounds anteriores, FECHADO pelo hash.

    A trêmula gravou uma fatura sem data nenhuma; a leitura boa que vem depois
    TEM vencimento, e nenhuma fatura no banco o tem. Pela chave lida isso eram
    duas faturas e o dinheiro dobrado. Pelo arquivo é uma só, e a ordem das
    leituras deixa de importar.
    """
    await _importar(svc, _CABECALHO_CEGO)
    r = await _importar(svc, _HEADER)
    assert r.ok, r.error
    await _conferir_uma_so_fatura(svc)
    fatura = (await svc.list_open_invoices())[0]
    # O reencontro PREENCHE o que faltava: sem vencimento gravado o mês de
    # caixa é NULL e o dinheiro não aparece em mês nenhum, e era assim que
    # ficava para sempre — reenviar o PDF, o reparo que a própria ferramenta
    # recomenda, não o tirava do limbo.
    assert fatura.due_date == "2026-08-10"
    # Mas NÃO promove: preencher e promover são decisões diferentes, e esta
    # segunda não existe em lugar nenhum do produto.
    assert fatura.status == "needs_review"


async def test_outro_arquivo_da_mesma_fatura_sem_vencimento_duplica(
    svc: FinanceService,
) -> None:
    """O limite que SOBRA, com o preço medido.

    O mesmo documento baixado de novo (ou regerado pelo banco) tem outros
    bytes: o hash não casa. Se por cima disso o vencimento não estiver legível
    em nenhuma das duas leituras, não sobra chave — nasce uma gêmea, com
    R$ 480,00 para R$ 240,00 de compras.

    O que segura o estrago é o que essas gêmeas são: `due_date` NULL (mês de
    caixa NULL, fora de todo resumo mensal) e `needs_review` nas duas. É o
    lado escolhido do erro — fundir errado sumiria com um mês inteiro em
    silêncio, dizendo ao modelo que estava tudo completo.

    **E o relatório semanal NÃO tem esse anteparo**, o que é a outra metade
    honesta do preço: ele agrega por data da COMPRA, sem passar por mês de
    caixa, então enxerga as gêmeas em dobro. Medido aqui, e não consertado
    nesta rodada.
    """
    await _importar(svc, _SEM_VENCIMENTO, source="c6-agosto.pdf")
    r = await _importar(svc, _SEM_VENCIMENTO, source="c6-agosto-rebaixado.pdf")
    assert r.ok, r.error

    faturas = await svc.list_open_invoices()
    assert len(faturas) == 2, "outro arquivo sem vencimento vira uma gêmea"
    entries = await svc.list_entries(limit=50)
    assert len(entries) == 4
    assert sum(e.amount for e in entries) == 480.0

    assert {f.status for f in faturas} == {"needs_review"}
    assert {f.due_date for f in faturas} == {None}
    for mes in (7, 8, 9):
        resumo = await svc.get_monthly_summary(mes, 2026)
        assert resumo["expenses"] == 0.0, f"mês {mes} não vê o dinheiro dobrado"

    # O buraco que sobra, com o número: R$ 480,00 para R$ 240,00 de compras.
    from types import SimpleNamespace

    from seraphine.insights.weekly import _build_finance_block

    semana = await _build_finance_block(
        SimpleNamespace(_finance=svc), date(2026, 7, 13), date(2026, 7, 26),
    )
    assert semana["expenses"] == 480.0, \
        "o semanal agrega por data da compra e vê as gêmeas em dobro"


async def test_outro_arquivo_com_vencimento_legivel_ainda_e_a_mesma_fatura(
    svc: FinanceService,
) -> None:
    """A chave forte cobre o que o hash não cobre: PDF regerado, lido direito.

    `(cartão, vencimento)` continua sendo o caminho de todo dia — é ele que
    impede o limite acima de valer para a fatura normal, que tem vencimento.
    """
    await _importar(svc, _HEADER, source="c6-agosto.pdf")
    r = await _importar(svc, _HEADER, source="c6-agosto-rebaixado.pdf")
    assert r.ok, r.error
    await _conferir_uma_so_fatura(svc)


async def test_sem_chave_nenhuma_o_mesmo_arquivo_ainda_e_a_mesma_fatura(
    svc: FinanceService,
) -> None:
    """O cabeçalho mais cego possível: nem vencimento, nem fechamento, nem
    total. Nos rounds anteriores isso era o limite 1 — duplicava sempre. O
    arquivo continua sendo ele mesmo."""
    cego = {**_HEADER, "due_date": "10/08/2026",
            "closing_date": "03/08/2026", "total": "nao encontrado"}
    await _importar(svc, cego)
    r = await _importar(svc, cego)
    assert r.ok, r.error

    faturas = await svc.list_open_invoices()
    assert len(faturas) == 1
    assert faturas[0].status == "needs_review", "sem total ela segue suspeita"
    assert r.metadata.get("transactions") == 0


# A fatura do mês seguinte, com o vencimento podre e o MESMO fechamento que a
# de agosto — o LLM lendo o campo errado nas duas leituras. É OUTRO arquivo,
# que é o que de fato separa uma fatura da outra.
_SETEMBRO = {"card": "C6", "closing_date": "2026-08-03",
             "due_date": "10/09/2026", "total": 500.0}
_TXS_SETEMBRO = [
    {"type": "expense", "amount": 500.0, "category": "compras",
     "description": "NOTEBOOK", "date": "2026-08-25"},
]


async def test_setembro_nao_e_absorvida_por_agosto_que_tem_lancamentos(
    svc: FinanceService,
) -> None:
    """A falha que atravessou cinco rounds, pela porta do fechamento.

    Agosto está íntegra (vencimento, fechamento, R$ 240, 2 lançamentos).
    Setembro chega com o vencimento podre e o mesmo fechamento. Medido com a
    cascata: os R$ 500 de setembro NÃO entravam, e a saída dizia "a fatura ja
    esta completa no banco. Nao registre nada de novo."

    Hoje não há por onde: são dois arquivos, o hash não casa, e o fechamento
    não é chave de coisa nenhuma.
    """
    await _importar(svc, _HEADER, source="c6-agosto.pdf")
    r = await _importar(svc, _SETEMBRO, txs=_TXS_SETEMBRO,
                        source="c6-setembro.pdf")
    assert r.ok, r.error

    # O dinheiro de setembro entrou.
    assert r.metadata.get("transactions") == 1
    entries = await svc.list_entries(limit=50)
    assert len(entries) == 3
    assert sum(e.amount for e in entries) == 740.0

    # E numa fatura própria, não pendurado na de agosto.
    faturas = await svc.list_open_invoices()
    assert len(faturas) == 2
    agosto = next(f for f in faturas if f.due_date == "2026-08-10")
    setembro = next(f for f in faturas if f.id != agosto.id)
    assert setembro.total == 500.0
    assert setembro.status == "needs_review", "sem vencimento legível, suspeita"
    ligados_agosto = await svc.list_invoice_entries(agosto.id)
    assert sum(e.amount for e in ligados_agosto) == 240.0
    (nova,) = await svc.list_invoice_entries(setembro.id)
    assert nova.date == "2026-08-25"


async def test_o_mesmo_pdf_relido_continua_sendo_reencontrado(
    svc: FinanceService,
) -> None:
    """O reencontro que a guarda tinha de proteger, sem guarda nenhuma."""
    await _importar(svc, _SEM_VENCIMENTO)
    r = await _importar(svc, _SEM_VENCIMENTO)
    assert r.ok, r.error
    await _conferir_uma_so_fatura(svc)


async def test_a_releitura_que_desloca_todas_as_datas_e_a_mesma_fatura(
    svc: FinanceService,
) -> None:
    """O limite 4 dos rounds anteriores, FECHADO.

    A segunda leitura do mesmo PDF não volta idêntica — o stream roda com
    `temperature` — e pode deslocar TODAS as datas de compra. A testemunha por
    interseção de datas não reconhecia nada aqui e criava uma gêmea: 2
    faturas, 4 lançamentos, R$ 480,00 num documento de R$ 240,00, com
    `SUCESSO`. Era o preço aceito por não fundir ciclos diferentes.

    O hash não paga esse preço: nada do que o modelo leu entra na conta.
    """
    await _importar(svc, _SEM_VENCIMENTO)
    deslocada = [
        {**_PDF_TXS[0], "date": "2026-07-16"},   # 15 → 16
        {**_PDF_TXS[1], "date": "2026-07-21"},   # 20 → 21
    ]
    r = await _importar(svc, _SEM_VENCIMENTO, txs=deslocada)
    assert r.ok, r.error
    await _conferir_uma_so_fatura(svc)
    assert r.metadata.get("transactions") == 0


async def test_reenviar_setembro_nao_faz_nascer_uma_terceira_fatura(
    svc: FinanceService,
) -> None:
    """O reenvio é o fluxo que o produto convida: a fatura sem vencimento
    legível nasce `needs_review`, que é o sinal de "reenvie o PDF".

    Medido nos rounds anteriores: agosto entrava (fatura 1), setembro numa
    fatura própria (fatura 2, correto), e o reenvio do MESMO PDF de setembro
    caía na fatura 1, era reprovado pela testemunha e criava a fatura 3 com os
    R$ 500 de novo — 3 faturas, R$ 1.240,00 para R$ 740,00 de compras.
    """
    await _importar(svc, _HEADER, source="c6-agosto.pdf")
    await _importar(svc, _SETEMBRO, txs=_TXS_SETEMBRO, source="c6-setembro.pdf")
    r = await _importar(svc, _SETEMBRO, txs=_TXS_SETEMBRO,
                        source="c6-setembro.pdf")
    assert r.ok, r.error

    faturas = await svc.list_open_invoices()
    assert len(faturas) == 2, "o reenvio não pode fazer nascer uma terceira"
    entries = await svc.list_entries(limit=50)
    assert len(entries) == 3, "o reenvio não pode reinserir os R$ 500"
    assert sum(e.amount for e in entries) == 740.0
    assert r.metadata.get("transactions") == 0

    # E o reencontro foi na fatura de setembro, não na de agosto.
    setembro = next(f for f in faturas if f.total == 500.0)
    assert r.metadata.get("invoice_id") == setembro.id
    agosto = next(f for f in faturas if f.id != setembro.id)
    assert sum(e.amount for e in await svc.list_invoice_entries(agosto.id)) == 240.0


async def test_o_parcelamento_nao_entrega_setembro_para_agosto(
    svc: FinanceService,
) -> None:
    """O caso que derrubou a testemunha por interseção de datas, e que não é
    exótico: parcelamento.

    A parcela carrega a data da compra ORIGINAL, então ela se repete em ciclos
    consecutivos — `PARCELA 1/3` em 30/07 na fatura de agosto, `PARCELA 2/3`
    em 30/07 na de setembro. A interseção de datas casava, a fatura de
    setembro inteira nunca entrava, e a saída dizia `NADA FOI INSERIDO: essa
    fatura ja estava no banco` + "a fatura ja esta completa no banco. Nao
    registre nada de novo". Silencioso, e rotineiro em fatura brasileira.

    Setembro aqui vem com o vencimento podre e o mesmo fechamento de agosto,
    que é o pior cabeçalho possível — e mesmo assim é outro arquivo.
    """
    await _importar(svc, {**_HEADER, "total": 300.0}, source="c6-agosto.pdf",
                    txs=[
                        {"type": "expense", "amount": 60.0,
                         "category": "compras", "description": "PARCELA 1/3",
                         "date": "2026-07-30"},
                        {**_PDF_TXS[1], "amount": 240.0, "date": "2026-07-20"},
                    ])
    setembro = [
        {"type": "expense", "amount": 60.0, "category": "compras",
         "description": "PARCELA 2/3", "date": "2026-07-30"},  # a MESMA data
        {"type": "expense", "amount": 500.0, "category": "compras",
         "description": "NOTEBOOK", "date": "2026-08-25"},
    ]
    r = await _importar(svc, {**_SETEMBRO, "total": 560.0}, txs=setembro,
                        source="c6-setembro.pdf")
    assert r.ok, r.error

    # O dinheiro de setembro entrou, e numa fatura própria.
    assert r.metadata.get("transactions") == 2
    entries = await svc.list_entries(limit=50)
    assert len(entries) == 4
    assert sum(e.amount for e in entries) == 860.0
    faturas = await svc.list_open_invoices()
    assert len(faturas) == 2
    agosto = next(f for f in faturas if f.due_date == "2026-08-10")
    assert sum(e.amount for e in await svc.list_invoice_entries(agosto.id)) == 300.0
    nova = next(f for f in faturas if f.id != agosto.id)
    assert sum(e.amount for e in await svc.list_invoice_entries(nova.id)) == 560.0

    # E reenviar o MESMO arquivo de setembro não insere nada.
    r2 = await _importar(svc, {**_SETEMBRO, "total": 560.0}, txs=setembro,
                         source="c6-setembro.pdf")
    assert r2.ok, r2.error
    assert r2.metadata.get("transactions") == 0
    assert r2.metadata.get("invoice_id") == nova.id
    assert len(await svc.list_entries(limit=50)) == 4
    assert len(await svc.list_open_invoices()) == 2


async def test_releitura_sem_nenhuma_data_legivel_nao_cria_fatura_fantasma(
    svc: FinanceService,
) -> None:
    """Nenhuma data de compra volta no ISO: o laço de inserção descarta todas
    essas transações, então nada entra de qualquer jeito. O que não pode
    acontecer é nascer uma segunda fatura vazia só de ruído — e não nasce,
    porque o reencontro não olha para as datas de compra."""
    await _importar(svc, _SEM_VENCIMENTO)
    podres = [{**t, "date": "15/07/2026"} for t in _PDF_TXS]
    r = await _importar(svc, _SEM_VENCIMENTO, txs=podres)
    assert r.ok, r.error

    await _conferir_uma_so_fatura(svc)
    assert r.metadata.get("transactions") == 0
    assert r.metadata.get("already_imported") == 2


async def test_a_fatura_vazia_nao_rouba_os_lancamentos_de_outro_arquivo(
    svc: FinanceService,
) -> None:
    """Agosto e setembro dividem o fechamento, e agosto foi esvaziada (o
    usuário apagou os lançamentos para reimportar). Reenviando o PDF de
    setembro, a cascata antiga podia pendurar os R$ 500 na fatura de agosto —
    e o gasto pesaria no mês errado, com `SUCESSO`.

    O hash não tem como se confundir: cada fatura tem o arquivo que a criou.
    """
    await _importar(svc, {**_HEADER, "due_date": "10/08/2026"},
                    source="c6-agosto.pdf")
    await _importar(svc, _SETEMBRO, txs=_TXS_SETEMBRO, source="c6-setembro.pdf")
    faturas = await svc.list_open_invoices()
    agosto = next(f for f in faturas if f.total == 240.0)
    setembro = next(f for f in faturas if f.total == 500.0)
    for e in await svc.list_invoice_entries(agosto.id):
        await svc.delete_entry(e.id)

    r = await _importar(svc, _SETEMBRO, txs=_TXS_SETEMBRO,
                        source="c6-setembro.pdf")
    assert r.ok, r.error

    assert r.metadata.get("invoice_id") == setembro.id
    assert r.metadata.get("transactions") == 0
    assert await svc.list_invoice_entries(agosto.id) == [], "a vazia segue vazia"
    (unico,) = await svc.list_invoice_entries(setembro.id)
    assert unico.amount == 500.0
    assert len(await svc.list_open_invoices()) == 2


async def test_vencimento_ilegivel_nao_vira_chave(
    svc: FinanceService,
) -> None:
    """As duas pontas decidem "tem vencimento?" com a MESMA régua.

    O cabeçalho cru do LLM traz `10/09/2026`. Decidindo por verdade booleana
    deste lado e por `parse_iso_date` no serviço, a data seria "presente" aqui
    e None lá: a fatura nova nasceria por acidente e não por desenho, e a
    régua só voltaria a importar quando alguém mexesse no serviço.
    """
    await _importar(svc, _HEADER, source="c6-agosto.pdf")
    tool = ImportFinancialPdfTool(service=svc)
    cru = {"card": "C6", "closing_date": "2026-08-03",
           "due_date": "10/09/2026", "total": 500.0}
    assert await tool._existing_invoice(cru, "hash-de-outro-arquivo") is None
    assert await tool._existing_invoice(cru, None) is None


async def test_o_hash_e_o_primeiro_degrau_e_o_vencimento_nem_e_consultado(
    svc: FinanceService,
) -> None:
    """Bateu o hash, é a mesma fatura, ponto. Nenhuma segunda pergunta.

    Não é economia de consulta: é a ordem que faz o reencontro parar de
    depender do que o LLM leu. Se o vencimento fosse consultado depois — ou
    antes —, um cabeçalho trêmulo voltaria a poder mandar numa decisão que o
    arquivo já respondeu.
    """
    await _importar(svc, _HEADER)
    fatura = (await svc.list_open_invoices())[0]
    assert fatura.source_hash

    tool = ImportFinancialPdfTool(service=svc)
    por_vencimento: list[tuple] = []
    buscador = svc.find_invoice

    async def _espia(*args, **kwargs):
        por_vencimento.append(args)
        return await buscador(*args, **kwargs)

    svc.find_invoice = _espia                     # type: ignore[method-assign]

    achada = await tool._existing_invoice(dict(_HEADER), fatura.source_hash)
    assert achada is not None and achada.id == fatura.id
    assert por_vencimento == [], "o hash respondeu; não há segunda pergunta"

    # E o hash de outro arquivo não impede a chave forte de responder.
    achada = await tool._existing_invoice(dict(_HEADER), "outro-hash")
    assert achada is not None and achada.id == fatura.id
    assert len(por_vencimento) == 1


class _ServicoSemODegrauDoHash:
    """Um serviço que conhece `find_invoice` e NÃO conhece o degrau do hash.

    É exatamente o "serviço antigo" que o `# pragma: no cover` de
    `_existing_invoice` sempre nomeou. Proxy em vez de dublê: tudo o mais tem
    de se comportar como o serviço de verdade, senão o teste mede o dublê.
    """

    def __init__(self, svc: FinanceService) -> None:
        self._svc = svc

    def __getattr__(self, nome: str):
        if nome == "find_invoice_by_source_hash":
            raise AttributeError(nome)
        return getattr(self._svc, nome)


async def test_servico_sem_o_degrau_do_hash_ainda_reencontra_pelo_vencimento(
    svc: FinanceService,
) -> None:
    """Degrau que falta degrada para o próximo; não cancela a busca inteira.

    Quando a chamada do hash morava dentro do mesmo `try` que protege
    `find_invoice`, um serviço sem o método novo abortava no degrau 1 e nunca
    chegava no 2. Medido nesse estado, no CAMINHO COMUM (vencimento ISO
    perfeito, mesmo arquivo, duas importações): 2 faturas com o mesmo
    vencimento, 4 lançamentos, R$ 480,00 para R$ 240,00 de compras,
    `already_imported: 0` e `SUCESSO` — e `get_monthly_summary(8, 2026)`
    respondendo `expenses = 480.0`.

    Dobrado DENTRO do resumo mensal é pior que qualquer um dos seis limites
    declarados desta feature: todos eles têm `due_date` NULL e por construção
    ficam fora do balanço. Antes do hash, esta mesma guarda degradava de forma
    benigna, e foi o degrau novo que a envenenou.
    """
    velho = _ServicoSemODegrauDoHash(svc)
    assert not hasattr(velho, "find_invoice_by_source_hash")

    await _importar(velho, _HEADER)
    r = await _importar(velho, _HEADER)
    assert r.ok, r.error

    await _conferir_uma_so_fatura(svc)
    assert r.metadata.get("transactions") == 0
    assert r.metadata.get("already_imported") == 2
    # E o número que o usuário vê continua sendo o do documento.
    assert (await svc.get_monthly_summary(8, 2026))["expenses"] == 240.0


async def test_hash_de_arquivo_que_nao_existe_e_None(
    svc: FinanceService,
) -> None:
    """Um erro de I/O no hash não pode derrubar uma importação que já leu o
    documento: sem identidade, a chave forte ainda responde."""
    tool = ImportFinancialPdfTool(service=svc)
    caminho = _caminho_inexistente(svc)
    assert not Path(caminho).exists(), "a medição só vale se ele não existir"
    assert tool._hash_do_arquivo(caminho) is None
    assert tool._hash_do_arquivo("") is None
    # E um diretório também não é um PDF: OSError, não estouro.
    assert tool._hash_do_arquivo(str(svc._store.path.parent)) is None


async def test_o_hash_gravado_e_o_sha256_dos_bytes_do_pdf(
    svc: FinanceService,
) -> None:
    """A identidade é do ARQUIVO, e não de um id nosso: dois arquivos com o
    mesmo conteúdo são o mesmo documento, e o mesmo arquivo em dois caminhos
    também."""
    import hashlib

    caminho = _arquivo_do_pdf(svc, "c6.pdf")
    esperado = hashlib.sha256(open(caminho, "rb").read()).hexdigest()

    await _importar(svc, _HEADER)
    assert (await svc.list_open_invoices())[0].source_hash == esperado


async def test_vencimento_iso_continua_abrindo_a_fatura_pela_importacao(
    svc: FinanceService,
) -> None:
    """Não-regressão do caminho bom: a data válida atravessa intacta."""
    r = await _importar(svc, _HEADER)
    assert r.ok, r.error
    fatura = (await svc.list_open_invoices())[0]
    assert fatura.due_date == "2026-08-10"
    assert fatura.closing_date == "2026-08-03"
    assert fatura.status == "open"


async def test_total_ilegivel_nao_derruba_a_importacao(
    svc: FinanceService,
) -> None:
    """O LLM devolvendo texto no total não pode custar os lançamentos."""
    r = await _importar(svc, {**_HEADER, "total": "nao encontrado"})
    assert r.ok, r.error
    abertas = await svc.list_open_invoices()
    assert len(abertas) == 1
    assert abertas[0].total is None
    assert abertas[0].status == "needs_review"
    assert len(await svc.list_entries(limit=50)) == 2


async def test_total_em_formato_brasileiro_e_entendido(
    svc: FinanceService,
) -> None:
    """`R$ 240,00` é o formato do documento — recusá-lo daria needs_review."""
    r = await _importar(svc, {**_HEADER, "total": "R$ 240,00"})
    assert r.ok, r.error
    abertas = await svc.list_open_invoices()
    assert abertas[0].total == 240.0
    assert abertas[0].status == "open"


async def test_lancamento_identico_avulso_nao_engole_o_vinculo(
    svc: FinanceService,
) -> None:
    """A armadilha do dedup: ele casa por data/valor/tipo/descrição e IGNORA
    `invoice_id`. Se o lançamento da fatura fosse deduplicado contra um
    avulso vindo do chat, ele devolveria o id antigo e o vínculo se perderia
    em silêncio — o dinheiro ficaria no mês da compra."""
    await svc.add_entry(FinancialEntry(
        id=None, type="expense", amount=100.0, currency="BRL",
        category="alimentacao", description="IFOOD", date="2026-07-15",
        source="chat", status="confirmed",
    ))

    r = await _importar(svc, _HEADER)
    assert r.ok, r.error

    fatura = (await svc.list_open_invoices())[0]
    entries = await svc.list_entries(limit=50)
    ligados = [e for e in entries if e.invoice_id == fatura.id]
    assert len(ligados) == 2, "o lançamento da fatura tem de nascer ligado a ela"
    assert len(entries) == 3


async def test_reimportar_a_mesma_fatura_nao_insere_nada(
    svc: FinanceService,
) -> None:
    """Fatura que já tem lançamentos ligados não recebe mais nada. Ou ela
    está importada, ou está vazia — não há meio termo confiável."""
    await _importar(svc, _HEADER)
    r = await _importar(svc, _HEADER)
    assert r.ok, r.error

    abertas = await svc.list_open_invoices()
    assert len(abertas) == 1, "a fatura reimportada é a mesma, não uma gêmea"
    entries = await svc.list_entries(limit=50)
    assert len(entries) == 2
    assert {e.invoice_id for e in entries} == {abertas[0].id}
    assert r.metadata.get("transactions") == 0
    assert r.metadata.get("already_imported") == 2
    assert r.metadata.get("invoice_reconciles") is True
    assert "NADA FOI INSERIDO" in (r.output or "")
    assert "2 lancamentos" in (r.output or "")
    # A soma mostrada e a soma conferida sao o MESMO numero — sem isso o
    # texto pode dizer R$ 0,00 e o veredito continuar "bate".
    assert "somando R$ 240,00" in (r.output or "")
    assert "total gravado na fatura: R$ 240,00" in (r.output or "")


async def test_segunda_leitura_diferente_tambem_nao_insere_nada(
    svc: FinanceService,
) -> None:
    """O caso que derruba qualquer casamento lançamento a lançamento: o
    stream roda com `temperature`, então a segunda leitura do MESMO PDF vem
    com a descrição, o valor ou a data trocados. Casar por campo deixaria o
    diferente entrar enquanto o gêmeo continua ligado — dinheiro dobrado pela
    metade, com mensagem de sucesso."""
    await _importar(svc, _HEADER)

    variada = [
        {**_PDF_TXS[0], "description": "IFOOD.COM"},
        {**_PDF_TXS[1], "amount": 140.5, "date": "2026-07-21"},
    ]
    r = await _importar(svc, _HEADER, txs=variada)
    assert r.ok, r.error

    entries = await svc.list_entries(limit=50)
    assert len(entries) == 2, "nenhuma variação de leitura pode entrar de novo"
    assert sum(e.amount for e in entries) == 240.0
    assert r.metadata.get("transactions") == 0


async def test_fatura_que_perdeu_lancamento_e_rebaixada_na_reimportacao(
    svc: FinanceService,
) -> None:
    """A fatura entrou completa (R$ 240 gravados, 2 lançamentos) e depois
    perdeu um — apagado na mão. Reimportar não insere nada, mas a divergência
    entre o que está gravado e o total dela tem de ficar VISÍVEL, senão o
    usuário fica preso a uma fatura errada que se apresenta como completa."""
    await _importar(svc, _HEADER)
    fatura = (await svc.list_open_invoices())[0]
    assert fatura.status == "open"
    entries = await svc.list_entries(limit=50)
    await svc.delete_entry(entries[0].id)

    r = await _importar(svc, _HEADER)
    assert r.ok, r.error

    assert (await svc.get_invoice(fatura.id)).status == "needs_review", \
        "a divergência tem de aparecer"
    assert len(await svc.list_entries(limit=50)) == 1
    assert r.metadata.get("invoice_reconciles") is False
    assert "somando R$ 100,00" in (r.output or "")
    assert "total gravado na fatura: R$ 240,00" in (r.output or "")
    assert "NAO bate" in (r.output or "")
    assert "rebaixada" in (r.output or "")
    assert "apague os lancamentos" in (r.output or "")


async def test_reimportar_fatura_ja_suspeita_nao_insere_e_diz_que_ja_estava(
    svc: FinanceService,
) -> None:
    """A leitura pela metade já nasce `needs_review` na criação; reimportar
    não muda isso nem insere nada, e a mensagem não pode fingir que rebaixou
    agora."""
    await _importar(svc, _HEADER, txs=_PDF_TXS[:1])
    fatura = (await svc.list_open_invoices())[0]
    assert fatura.status == "needs_review"

    r = await _importar(svc, _HEADER)
    assert r.ok, r.error
    assert len(await svc.list_entries(limit=50)) == 1
    assert "ja estava em needs_review" in (r.output or "")


@pytest.mark.parametrize(
    "total_tremido", [None, 2400.0, "nao encontrado", ""],
    ids=["omitido", "digito-a-mais", "ilegivel", "vazio"],
)
async def test_total_tremido_na_releitura_nao_rebaixa_fatura_correta(
    svc: FinanceService, total_tremido: object,
) -> None:
    """A premissa deste caminho é que a SEGUNDA leitura não é confiável —
    então não pode ser ela a definir o número de referência. A fatura está
    íntegra: 2 lançamentos, R$ 240,00, total gravado R$ 240,00. Um cabeçalho
    trêmulo não pode marcá-la como suspeita, ainda mais sendo porta de mão
    única: nada no produto devolve uma fatura para `open`."""
    await _importar(svc, _HEADER)
    fatura = (await svc.list_open_invoices())[0]
    assert fatura.status == "open"

    r = await _importar(svc, {**_HEADER, "total": total_tremido})
    assert r.ok, r.error
    assert (await svc.get_invoice(fatura.id)).status == "open"
    assert r.metadata.get("invoice_reconciles") is True
    assert "ja esta completa" in (r.output or "")
    assert "falta lancamento" not in (r.output or "")


async def test_fatura_vazia_reencontrada_pela_metade_e_rebaixada(
    svc: FinanceService,
) -> None:
    """A direção insegura do ramo reencontrado: fatura `open` esvaziada que
    recebe uma leitura pela metade continuaria dizendo que está completa —
    "uma fatura pela metade que se apresenta como completa"."""
    inv = await svc.create_invoice(card="C6", closing_date=None,
                                   due_date="2026-08-10", total=240.0)
    r = await _importar(svc, _HEADER, txs=_PDF_TXS[:1])
    assert r.ok, r.error

    assert (await svc.get_invoice(inv)).status == "needs_review"
    entries = await svc.list_entries(limit=50)
    assert len(entries) == 1
    assert entries[0].invoice_id == inv
    assert "ATENCAO" in (r.output or "")
    assert "revisao" in (r.output or "")


async def test_fatura_vazia_reencontrada_por_inteiro_nao_reabre(
    svc: FinanceService,
) -> None:
    """A direção segura, declarada: não existe primitiva para promover, e uma
    fatura marcada como suspeita voltar sozinha a `open` apagaria um sinal em
    que o usuário pode ter se apoiado."""
    inv = await svc.create_invoice(card="C6", closing_date=None,
                                   due_date="2026-08-10", total=240.0,
                                   status="needs_review")
    r = await _importar(svc, _HEADER)
    assert r.ok, r.error

    assert (await svc.get_invoice(inv)).status == "needs_review"
    entries = await svc.list_entries(limit=50)
    assert len(entries) == 2
    assert {e.invoice_id for e in entries} == {inv}


async def test_reimportar_fatura_ja_paga_nao_duplica(
    svc: FinanceService,
) -> None:
    """Reenviar uma fatura já paga é o jeito natural de perguntar algo sobre
    ela. `list_open_invoices` não a enxerga (`paid_date IS NULL`), então a
    conferência tem de ser por `find_invoice` — senão o PDF entra de novo e o
    dinheiro dobra em dois meses diferentes, onde nenhuma tela mostra dobrado."""
    await _importar(svc, _HEADER)
    fatura = (await svc.list_open_invoices())[0]
    await svc.mark_invoice_paid(fatura.id, "2026-08-11")

    r = await _importar(svc, _HEADER)
    assert r.ok, r.error

    entries = await svc.list_entries(limit=50)
    assert len(entries) == 2
    assert {e.invoice_id for e in entries} == {fatura.id}
    assert await svc.list_open_invoices() == [], "nenhuma segunda fatura aberta"
    assert r.metadata.get("transactions") == 0
    assert r.metadata.get("invoice_id") == fatura.id


async def test_fatura_paga_e_divergente_nao_e_rebaixada_mas_e_dita(
    svc: FinanceService,
) -> None:
    """`status='paid'` anda junto de `paid_date`: rebaixar deixaria uma
    fatura que se diz suspeita e mesmo assim some da lista de abertas."""
    await _importar(svc, _HEADER)
    fatura = (await svc.list_open_invoices())[0]
    await svc.mark_invoice_paid(fatura.id, "2026-08-11")
    entries = await svc.list_entries(limit=50)
    await svc.delete_entry(entries[0].id)

    r = await _importar(svc, _HEADER)
    assert r.ok, r.error
    assert (await svc.get_invoice(fatura.id)).status == "paid"
    assert "ja esta paga" in (r.output or "")


async def test_fatura_vazia_reencontrada_recebe_os_lancamentos(
    svc: FinanceService,
) -> None:
    """A saída para quem apagou os lançamentos e quer reimportar: fatura sem
    nada ligado aceita a importação, e sem criar uma segunda."""
    await svc.create_invoice(card="C6", closing_date=None,
                             due_date="2026-08-10", total=240.0)
    r = await _importar(svc, _HEADER)
    assert r.ok, r.error

    abertas = await svc.list_open_invoices()
    assert len(abertas) == 1
    entries = await svc.list_entries(limit=50)
    assert len(entries) == 2
    assert {e.invoice_id for e in entries} == {abertas[0].id}
    assert r.metadata.get("transactions") == 2


async def test_o_resumo_soma_so_o_que_entrou(svc: FinanceService) -> None:
    """`0 transacoes registradas` ao lado de `expenses: 200` é o modelo
    recebendo duas verdades opostas na mesma mensagem."""
    r = await _importar(svc, None, txs=[
        _PDF_TXS[0],
        {**_PDF_TXS[1], "date": "31/07/2026"},  # data ilegível: não entra
        {"type": "income", "amount": 30.0, "category": "outros",
         "description": "ESTORNO", "date": "2026-07-18"},
        {"type": "income", "amount": 0, "category": "outros",
         "description": "LINHA DE TOTAL", "date": "2026-07-18"},  # zero: não entra
    ])
    assert r.ok, r.error
    assert r.metadata.get("transactions") == 2
    assert r.metadata.get("expenses") == 100.0
    assert r.metadata.get("income") == 30.0
    assert "R$ 100,00" in (r.output or "")
    assert "R$ 240,00" not in (r.output or "")


async def test_duas_compras_iguais_na_mesma_fatura_entram_as_duas(
    svc: FinanceService,
) -> None:
    """Dois cafés idênticos no mesmo dia são dois gastos. Deduplicar dentro
    da própria importação sumiria com dinheiro que existe."""
    gemeas = [dict(_PDF_TXS[0]), dict(_PDF_TXS[0])]
    r = await _importar(svc, {**_HEADER, "total": 200.0}, txs=gemeas)
    assert r.ok, r.error
    entries = await svc.list_entries(limit=50)
    assert len(entries) == 2
    assert (await svc.list_open_invoices())[0].status == "open"


async def test_fatura_de_outro_vencimento_e_outra_fatura(
    svc: FinanceService,
) -> None:
    """A do mês seguinte não pode ser confundida com a reimportação desta."""
    await _importar(svc, _HEADER, source="c6-agosto.pdf")
    await _importar(svc, {**_HEADER, "due_date": "2026-09-10"},
                    source="c6-setembro.pdf",
                    txs=[{"type": "expense", "amount": 240.0,
                          "category": "outros", "description": "MERCADO",
                          "date": "2026-08-15"}])
    assert len(await svc.list_open_invoices()) == 2


# --- o que o serviço passou a saber responder ------------------------


async def test_find_invoice_enxerga_a_fatura_ja_paga(svc: FinanceService) -> None:
    """O motivo de existir: `list_open_invoices` filtra `paid_date IS NULL` e
    responderia "não existe" para uma fatura que existe."""
    inv = await svc.create_invoice(card="C6", closing_date=None,
                                   due_date="2026-08-10", total=240.0)
    await svc.mark_invoice_paid(inv, "2026-08-11")
    achada = await svc.find_invoice("C6", "2026-08-10")
    assert achada is not None
    assert achada.id == inv
    assert achada.paid_date == "2026-08-11"


async def test_find_invoice_nao_confunde_cartao_nem_vencimento(
    svc: FinanceService,
) -> None:
    await svc.create_invoice(card="C6", closing_date=None,
                             due_date="2026-08-10", total=240.0)
    assert await svc.find_invoice("Nubank", "2026-08-10") is None
    assert await svc.find_invoice("C6", "2026-09-10") is None
    # O cartão vem do PDF com caixa e espaço variáveis.
    assert await svc.find_invoice(" c6 ", "2026-08-10") is not None
    # Sem chave nenhuma não dá para afirmar que é a mesma fatura.
    assert await svc.find_invoice("C6", "") is None
    assert await svc.find_invoice("C6", None) is None


async def test_find_invoice_nao_cascateia_para_fechamento_nem_total(
    svc: FinanceService,
) -> None:
    """A cascata FOI REMOVIDA, e este teste é o que impede o retorno dela.

    Fechamento e total casam ciclos DIFERENTES com a mesma facilidade com que
    casam o mesmo — a de setembro grudando na de agosto quando o LLM repete o
    fechamento nas duas leituras, ou quando as duas custam o mesmo (assinatura
    de valor fixo). As testemunhas que tentaram separá-los falharam de forma
    rotineira. Sem vencimento no ISO, a resposta é None e quem chama usa o
    hash do arquivo — identidade gravada, não adivinhada.
    """
    await svc.create_invoice(card="C6", closing_date="2026-08-03",
                             due_date=None, total=240.0)
    assert await svc.find_invoice("C6", None) is None
    assert await svc.find_invoice("C6", "10/08/2026") is None
    # E nem por acidente: os kwargs do degrau fraco não existem mais.
    with pytest.raises(TypeError):
        await svc.find_invoice("C6", None, closing_date="2026-08-03")
    with pytest.raises(TypeError):
        await svc.find_invoice("C6", None, total=240.0)


async def test_find_invoice_by_source_hash_e_a_identidade_do_arquivo(
    svc: FinanceService,
) -> None:
    """O degrau que substituiu a cascata inteira.

    Ele responde onde o cabeçalho não responde nada, que é justamente o caso
    que empurra a fatura para `needs_review` e convida o usuário a reenviar o
    PDF — o fluxo em que a duplicata nascia.
    """
    inv = await svc.create_invoice(card="C6", closing_date=None,
                                   due_date=None, total=None,
                                   source_hash="abc123")
    achada = await svc.find_invoice_by_source_hash("abc123")
    assert achada is not None and achada.id == inv
    assert achada.source_hash == "abc123"
    assert await svc.find_invoice_by_source_hash("outro") is None


async def test_find_invoice_by_source_hash_enxerga_a_fatura_ja_paga(
    svc: FinanceService,
) -> None:
    """Mesmo motivo de sempre: `list_open_invoices` filtra `paid_date IS NULL`
    e o mesmo PDF entraria de novo, dobrando o dinheiro em DOIS meses."""
    inv = await svc.create_invoice(card="C6", closing_date=None,
                                   due_date="2026-08-10", total=240.0,
                                   source_hash="abc123")
    await svc.mark_invoice_paid(inv, "2026-08-11")
    achada = await svc.find_invoice_by_source_hash("abc123")
    assert achada is not None and achada.id == inv
    assert achada.paid_date == "2026-08-11"


async def test_hash_vazio_nao_casa_com_a_fatura_criada_a_mao(
    svc: FinanceService,
) -> None:
    """Hash vazio não é identidade — e a guarda tem de estar em Python.

    Para `source_hash` NULL quem protege é o SQL (`= NULL` nunca é verdade em
    SQLite), mas para a string vazia não: `WHERE source_hash = ''` casaria, e
    uma importação cujo arquivo não pôde ser lido cairia na primeira fatura de
    hash vazio do banco — que pode ser de qualquer mês. Casar "vazio com
    vazio" é o modo mais silencioso de errar.
    """
    a_mao = await svc.create_invoice(card="C6", closing_date=None,
                                     due_date="2026-08-10", total=240.0)
    assert await svc.find_invoice_by_source_hash("") is None
    assert await svc.find_invoice_by_source_hash(None) is None  # type: ignore[arg-type]

    vazia = await svc.create_invoice(card="C6", closing_date=None,
                                     due_date="2026-09-10", total=500.0,
                                     source_hash="")
    assert vazia != a_mao
    assert await svc.find_invoice_by_source_hash("") is None, \
        "hash vazio gravado continua não sendo chave"


async def test_list_invoice_entries_traz_so_os_daquela_fatura(
    svc: FinanceService,
) -> None:
    a = await svc.create_invoice(card="C6", closing_date=None,
                                 due_date="2026-08-10", total=None)
    b = await svc.create_invoice(card="C6", closing_date=None,
                                 due_date="2026-09-10", total=None)
    for inv, valor in ((a, 100.0), (a, 140.0), (b, 50.0), (None, 7.0)):
        await svc.add_entry(FinancialEntry(
            id=None, type="expense", amount=valor, currency="BRL",
            category="outros", description=f"x{valor}", date="2026-07-15",
            source="pdf", status="confirmed", invoice_id=inv,
        ))
    ligados = await svc.list_invoice_entries(a)
    assert len(ligados) == 2
    assert sum(e.amount for e in ligados) == 240.0


async def test_flag_invoice_for_review_nao_mexe_em_fatura_paga(
    svc: FinanceService,
) -> None:
    """`needs_review` com `paid_date` seria uma fatura que se diz suspeita e
    mesmo assim fica fora da lista de abertas — ninguém mais olha para ela."""
    inv = await svc.create_invoice(card="C6", closing_date=None,
                                   due_date="2026-08-10", total=240.0)
    assert await svc.flag_invoice_for_review(inv) is True
    assert (await svc.get_invoice(inv)).status == "needs_review"

    await svc.mark_invoice_paid(inv, "2026-08-11")
    assert await svc.flag_invoice_for_review(inv) is False
    assert (await svc.get_invoice(inv)).status == "paid"


async def test_o_prompt_pede_o_cabecalho_da_fatura() -> None:
    """Sem isso o LLM devolve o array de sempre e nada disso é alcançável."""
    tool = ImportFinancialPdfTool(service=None, llm=None)
    prompt = tool._pdf_prompt("outros")
    assert "FATURA DE CARTAO" in prompt
    assert '"invoice"' in prompt
    assert "due_date" in prompt
    assert "omita o campo" in prompt
