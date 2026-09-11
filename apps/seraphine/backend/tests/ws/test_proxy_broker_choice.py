"""Para QUEM o broker manda um `tool_proxy_request`.

Antes ele fazia `pool[0]` sobre um **set**, cuja ordem de iteração é
arbitrária. Com o Mac e o iPhone conectados ao mesmo tempo, o pedido caía em
qualquer um dos dois — e para o relé da casa (`lan_request`) isso é a
diferença entre funcionar e não funcionar, porque o aparelho que está fora de
casa não alcança a LAN.

O outro eixo destes testes é o que NÃO pode acontecer: tentar o próximo
aparelho depois de o primeiro ter RESPONDIDO. `lan_request` carrega POSTs que
não são idempotentes (`/api/play` enfileira faixa), então repetir depois de
uma resposta tocaria a música duas vezes.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from seraphine.tools.base import ToolResult
from seraphine.ws.proxy_broker import ProxyBroker


class FakeWS:
    """Cliente conectado, com o que ele declarou no `client_hello`."""

    def __init__(self, nome: str, *, tauri: bool = True, tools: list[str] | None = None):
        self.nome = nome
        self._is_tauri = tauri
        self._proxy_tools = tools if tools is not None else []
        self.enviados: list[dict[str, Any]] = []
        self.responde = True

    async def send_json(self, msg: dict[str, Any]) -> None:
        self.enviados.append(msg)

    def __repr__(self) -> str:  # deixa a falha legível
        return f"<FakeWS {self.nome}>"


class FakeState:
    def __init__(self, *clients: FakeWS):
        self.ws_clients = list(clients)
        self.proxy_broker = ProxyBroker()


# ---------------------------------------------------------------------------
# Escolha
# ---------------------------------------------------------------------------


def test_who_declared_the_tool_comes_first():
    mac = FakeWS("mac", tools=["lan_request", "run_shell"])
    fone = FakeWS("fone", tools=["health_read"])
    st = FakeState(fone, mac)  # ordem de conexão contrária de propósito

    escolha = st.proxy_broker.clients_for(st, "lan_request")
    assert [c.nome for c in escolha] == ["mac"]


def test_a_client_that_declared_without_the_tool_is_skipped():
    """Ele já disse que não sabe: mandar assim mesmo só gasta o timeout."""
    fone = FakeWS("fone", tools=["health_read"])
    st = FakeState(fone)
    assert st.proxy_broker.clients_for(st, "lan_request") == []


def test_an_older_client_that_declared_nothing_is_still_tried():
    """Cliente anterior ao campo `tools` provavelmente atende.

    Ignorá-lo quebraria a casa para quem não atualizou o app — e tentar custa
    um timeout, enquanto não tentar custa a feature inteira.
    """
    velho = FakeWS("velho", tools=[])
    st = FakeState(velho)
    assert [c.nome for c in st.proxy_broker.clients_for(st, "lan_request")] == ["velho"]


def test_declared_beats_silent():
    velho = FakeWS("velho", tools=[])
    mac = FakeWS("mac", tools=["lan_request"])
    st = FakeState(velho, mac)

    escolha = [c.nome for c in st.proxy_broker.clients_for(st, "lan_request")]
    assert escolha == ["mac", "velho"]


def test_a_browser_tab_is_last_resort_only():
    """Aba do navegador não tem Tauri: ela não executa `lan_request`.

    Fica na lista só quando não há mais ninguém — é melhor uma tentativa que
    falha explicando do que "nenhum cliente conectado" com um cliente ali.
    """
    aba = FakeWS("aba", tauri=False, tools=[])
    mac = FakeWS("mac", tools=["lan_request"])

    st = FakeState(aba, mac)
    assert [c.nome for c in st.proxy_broker.clients_for(st, "lan_request")] == ["mac"]

    so_aba = FakeState(aba)
    assert [c.nome for c in so_aba.proxy_broker.clients_for(so_aba, "lan_request")] == ["aba"]


def test_the_order_does_not_depend_on_set_iteration():
    """A regressão original: `ws_clients` era um set.

    Com os mesmos clientes, a resposta tem de ser sempre a mesma — senão o
    mesmo comando funciona ou não conforme o humor do hash.
    """
    mac = FakeWS("mac", tools=["lan_request"])
    fone = FakeWS("fone", tools=["lan_request"])
    st = FakeState(mac, fone)

    respostas = {
        tuple(c.nome for c in st.proxy_broker.clients_for(st, "lan_request"))
        for _ in range(20)
    }
    assert len(respostas) == 1


# ---------------------------------------------------------------------------
# Despacho: quando tentar o próximo, e quando NÃO
# ---------------------------------------------------------------------------


@pytest.fixture()
def despachar(monkeypatch):
    from seraphine.conversation import engine as eng

    monkeypatch.setattr(eng, "_PROXY_TIMEOUT_SECONDS", 0.05)
    return eng._proxy_tool_via_client


@pytest.mark.asyncio
async def test_no_client_at_all_says_so_without_naming_the_mac(despachar):
    """A mensagem antiga dizia "needs a Mac client".

    O relé vale nos dois alvos — `lan_request` está registrado em
    `run_mobile` —, então culpar o Mac manda o usuário conferir o aparelho
    errado.
    """
    st = FakeState()
    r = await despachar(st, "lan_request", {})

    assert r.ok is False
    assert "Mac" not in r.error
    assert "nenhum está conectado" in r.error


@pytest.mark.asyncio
async def test_a_silent_client_lets_the_next_one_try(despachar):
    """Aparelho fora de casa, ou com o app em segundo plano, não pode
    condenar o comando quando há outro capaz do lado."""
    mudo = FakeWS("mudo", tools=["lan_request"])
    bom = FakeWS("bom", tools=["lan_request"])
    st = FakeState(mudo, bom)

    async def responder():
        # Espera o pedido CHEGAR no segundo, em vez de cronometrar a espera:
        # amarrar o teste ao relógio o faria falhar por causa do próprio
        # timeout que ele quer exercitar.
        while not bom.enviados:
            await asyncio.sleep(0.005)
        req = bom.enviados[0]["request_id"]
        st.proxy_broker.resolve(req, ToolResult(ok=True, output="{}"))

    tarefa = asyncio.create_task(responder())
    r = await despachar(st, "lan_request", {})
    await tarefa

    assert r.ok is True
    assert len(mudo.enviados) == 1 and len(bom.enviados) == 1


@pytest.mark.asyncio
async def test_an_answer_stops_the_line_even_when_it_is_a_failure(despachar):
    """O ponto mais importante do arquivo.

    Se o cliente respondeu, ele EXECUTOU o pedido. `/api/play` não é
    idempotente: repetir num segundo aparelho enfileiraria a música duas
    vezes. Erro respondido é resposta, e resposta encerra.
    """
    primeiro = FakeWS("primeiro", tools=["lan_request"])
    segundo = FakeWS("segundo", tools=["lan_request"])
    st = FakeState(primeiro, segundo)

    async def responder():
        await asyncio.sleep(0.01)
        req = primeiro.enviados[0]["request_id"]
        st.proxy_broker.resolve(req, ToolResult(ok=False, error="rede: conexão recusada"))

    tarefa = asyncio.create_task(responder())
    r = await despachar(st, "lan_request", {})
    await tarefa

    assert r.ok is False
    assert "rede:" in r.error
    # Ausência afirmada: o segundo aparelho NÃO recebeu nada.
    assert segundo.enviados == []


@pytest.mark.asyncio
async def test_all_silent_reports_the_last_failure(despachar):
    a = FakeWS("a", tools=["lan_request"])
    b = FakeWS("b", tools=["lan_request"])
    st = FakeState(a, b)

    r = await despachar(st, "lan_request", {})

    assert r.ok is False
    assert "não respondeu a tempo" in r.error
    assert len(a.enviados) == 1 and len(b.enviados) == 1
