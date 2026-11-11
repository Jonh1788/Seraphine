"""Esforço de raciocínio (`reasoning.effort`) no chat via OpenRouter.

O que estes testes protegem, em ordem de importância:

1. **Desligado é byte-a-byte o corpo de antes da feature.** O default tem de
   ser indistinguível do comportamento anterior — é o que torna a feature
   segura de mandar para produção. Um `reasoning` vazando no corpo por engano
   mudaria o custo de toda conversa sem ninguém pedir.

2. **O bloco enviado é o normalizado da OpenRouter** (`reasoning.effort`), não
   o `reasoning_effort` nativo da OpenAI. É o bloco normalizado que a
   OpenRouter traduz para o orçamento de tokens dos modelos Anthropic e
   Gemini; mandar o nativo funcionaria só na OpenAI.

3. **Um esforço inválido nunca vira requisição.** O valor vem de um kv que
   qualquer versão do cliente escreve, e um 400 no meio da conversa é caro.

4. **Recusa do provedor não derruba o turno.** A UI só oferece esforço onde o
   catálogo anuncia suporte, mas o ajuste fica gravado e o modelo pode mudar
   depois: repetir sem o bloco entrega a resposta sem o raciocínio.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from seraphine.deepsearch import schema as deepsearch_schema
from seraphine.deepsearch.providers import (
    OpenRouterChatClient,
    _anuncia_reasoning,
    normalize_effort,
)
from seraphine.deepsearch.service import DeepSearchService
from seraphine.memory.store import MemoryStore


# ---------------------------------------------------------------------------
# normalize_effort — a fronteira que protege a requisição
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "entrada",
    ["minimal", "low", "medium", "high", "xhigh", "max", " HIGH ", "Medium"],
)
def test_normalize_effort_accepts_the_documented_levels(entrada):
    assert normalize_effort(entrada) == entrada.strip().lower()


@pytest.mark.parametrize(
    "entrada",
    [
        "",
        None,
        "  ",
        "altíssimo",
        "none",  # fora de propósito: DESLIGA o raciocínio, não é "não mandar"
        "1",
        123,
        {"effort": "high"},
        ["high"],
    ],
)
def test_normalize_effort_rejects_everything_else(entrada):
    assert normalize_effort(entrada) is None


# ---------------------------------------------------------------------------
# Suporte anunciado pelo catálogo
# ---------------------------------------------------------------------------


def test_reasoning_support_comes_from_supported_parameters():
    """Medido no catálogo real em 2026-08-02, não inventado."""
    gpt5 = {"supported_parameters": ["reasoning", "reasoning_effort", "tools"]}
    claude = {"supported_parameters": ["reasoning", "max_tokens", "tools"]}
    mini = {"supported_parameters": ["max_tokens", "temperature", "tools"]}

    assert _anuncia_reasoning(gpt5) is True
    assert _anuncia_reasoning(claude) is True
    # `gpt-4o-mini` não raciocina: oferecer o controle nele seria mentira.
    assert _anuncia_reasoning(mini) is False
    # Campo ausente ou de tipo inesperado não pode explodir a listagem.
    assert _anuncia_reasoning({}) is False
    assert _anuncia_reasoning({"supported_parameters": None}) is False
    assert _anuncia_reasoning({"supported_parameters": "reasoning"}) is False


# ---------------------------------------------------------------------------
# O corpo da requisição
# ---------------------------------------------------------------------------


class _RespostaFalsa:
    """Resposta streamada mínima, no formato SSE que o adaptador consome."""

    def __init__(self, status=200, linhas=None, corpo_erro=""):
        self.status_code = status
        self._linhas = linhas or ['data: {"choices":[{"delta":{"content":"oi"}}]}']
        self._corpo_erro = corpo_erro

    async def aread(self):
        return self._corpo_erro.encode()

    async def aiter_lines(self):
        for linha in self._linhas:
            yield linha

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


class _ClienteFalso:
    """Captura os corpos enviados e devolve respostas roteirizadas."""

    def __init__(self, respostas):
        self.respostas = list(respostas)
        self.corpos = []

    def stream(self, method, url, *, headers=None, json=None):
        self.corpos.append(json)
        return self.respostas.pop(0)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


@pytest.fixture
def captura(monkeypatch):
    """Instala um httpx.AsyncClient falso e devolve o capturador."""

    caixa = {}

    def instalar(respostas):
        cli = _ClienteFalso(respostas)
        caixa["cli"] = cli
        monkeypatch.setattr(
            "seraphine.deepsearch.providers.httpx.AsyncClient",
            lambda **kw: cli,
        )
        return cli

    return instalar


async def _consumir(client, **kw):
    return [t async for t in client.chat([{"role": "user", "content": "oi"}], **kw)]


@pytest.mark.asyncio
async def test_no_effort_sends_no_reasoning_block(captura):
    """O default é indistinguível do comportamento de antes da feature."""
    cli = captura([_RespostaFalsa()])
    await _consumir(OpenRouterChatClient("k"), model="openai/gpt-5")

    corpo = cli.corpos[0]
    assert "reasoning" not in corpo
    # Ausência afirmada também da forma nativa da OpenAI: nada de raciocínio
    # pode entrar no corpo por nenhuma porta quando ninguém pediu.
    assert "reasoning_effort" not in corpo


@pytest.mark.asyncio
async def test_effort_sends_the_normalized_openrouter_block(captura):
    cli = captura([_RespostaFalsa()])
    await _consumir(OpenRouterChatClient("k", effort="high"), model="openai/gpt-5")

    corpo = cli.corpos[0]
    assert corpo["reasoning"] == {"effort": "high"}
    # É o bloco normalizado que a OpenRouter traduz para Anthropic/Gemini; o
    # `reasoning_effort` nativo só funcionaria na OpenAI.
    assert "reasoning_effort" not in corpo


@pytest.mark.asyncio
async def test_invalid_effort_never_reaches_the_wire(captura):
    """Kv corrompido não pode custar um 400 no meio da conversa."""
    cli = captura([_RespostaFalsa()])
    await _consumir(
        OpenRouterChatClient("k", effort="altíssimo"), model="openai/gpt-5"
    )
    assert "reasoning" not in cli.corpos[0]


@pytest.mark.asyncio
async def test_provider_refusal_retries_once_without_reasoning(captura):
    """O usuário perde o raciocínio, não a resposta."""
    cli = captura(
        [
            _RespostaFalsa(
                status=400,
                corpo_erro='{"error":{"message":"reasoning is not supported"}}',
            ),
            _RespostaFalsa(),
        ]
    )
    tokens = await _consumir(
        OpenRouterChatClient("k", effort="high"), model="vendor/sem-raciocinio"
    )

    assert len(cli.corpos) == 2
    assert cli.corpos[0]["reasoning"] == {"effort": "high"}
    # A segunda tentativa é a primeira menos o bloco — e só isso.
    assert "reasoning" not in cli.corpos[1]
    assert {k: v for k, v in cli.corpos[0].items() if k != "reasoning"} == cli.corpos[1]
    # E a resposta chegou.
    assert any(getattr(t, "text", "") == "oi" for t in tokens)


@pytest.mark.asyncio
async def test_a_400_unrelated_to_reasoning_still_raises(captura):
    """O retry é para UM caso. Crédito acabado tem de continuar falhando alto."""
    captura(
        [_RespostaFalsa(status=402, corpo_erro='{"error":{"message":"no credits"}}')]
    )
    with pytest.raises(RuntimeError, match="402"):
        await _consumir(OpenRouterChatClient("k", effort="high"), model="openai/gpt-5")


@pytest.mark.asyncio
async def test_failure_without_effort_is_not_retried(captura):
    """Sem esforço no corpo não há o que repetir — uma tentativa, e falha."""
    cli = captura(
        [_RespostaFalsa(status=400, corpo_erro="reasoning something something")]
    )
    with pytest.raises(RuntimeError):
        await _consumir(OpenRouterChatClient("k"), model="openai/gpt-5")
    assert len(cli.corpos) == 1


# ---------------------------------------------------------------------------
# Persistência (kv) via service
# ---------------------------------------------------------------------------


@pytest.fixture
async def svc(tmp_path: Path) -> DeepSearchService:
    s = MemoryStore(tmp_path / "effort.sqlite")
    s.register_migrator("seraphine_deepsearch", deepsearch_schema.migrate)
    await s.ensure_schema()

    class _Tools:
        def get(self, name):
            return object()

    return DeepSearchService(s, llm=object(), tools=_Tools(), settings=None)


@pytest.mark.asyncio
async def test_effort_defaults_to_off(svc):
    assert await svc.get_chat_effort() == ""


@pytest.mark.asyncio
async def test_effort_round_trips_and_can_be_turned_back_off(svc):
    assert await svc.set_chat_effort("high") == "high"
    assert await svc.get_chat_effort() == "high"

    # Voltar atrás é `""` — e tem de funcionar, senão o usuário fica preso.
    assert await svc.set_chat_effort("") == ""
    assert await svc.get_chat_effort() == ""


@pytest.mark.asyncio
async def test_garbage_is_normalized_on_write_and_on_read(svc):
    assert await svc.set_chat_effort("altíssimo") == ""

    # E na LEITURA também: um cliente antigo pode ter escrito direto no kv.
    await svc.store.set_kv("chat_reasoning_effort", "turbo")
    assert await svc.get_chat_effort() == ""


@pytest.mark.asyncio
async def test_catalog_carries_the_reasoning_flag(svc, monkeypatch):
    class _OR:
        def __init__(self, key):
            pass

        async def list_models(self):
            return [
                {"id": "v/pensa", "name": "Pensa", "reasoning": True},
                {"id": "v/nao-pensa", "name": "Nao pensa", "reasoning": False},
            ]

    monkeypatch.setattr("seraphine.deepsearch.service.OpenRouterClient", _OR)
    await svc.set_config(
        fanout_model="cliproxy", synth_model="cliproxy", openrouter_key="sk-or-x"
    )

    porid = {m["id"]: m for m in (await svc.list_models())["openrouter"]}
    assert porid["openrouter:v/pensa"]["reasoning"] is True
    assert porid["openrouter:v/nao-pensa"]["reasoning"] is False


def test_route_body_accepts_empty_string_for_off():
    """`""` é o valor legítimo de desligado — um `min_length=1` prenderia o
    usuário no esforço que ele escolheu uma vez."""
    from seraphine.deepsearch.routes import ChatEffortBody

    assert ChatEffortBody(**json.loads('{"effort": ""}')).effort == ""
    assert ChatEffortBody(**json.loads('{"effort": "low"}')).effort == "low"
