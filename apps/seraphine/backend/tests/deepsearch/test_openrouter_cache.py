"""Cache de prompt no cliente OpenRouter.

Medido em produção: 1.061.331 tokens de entrada contra 1.300 de saída (816:1),
$3,08 em 18 chamadas — ~59k de entrada por chamada, quase toda reenviada a preço
cheio a cada turno. O adaptador Anthropic (`llm_adapters/anthropic.py`) marca o
prompt de sistema e o bloco de ferramentas com `cache_control` em 8 pontos; o
caminho do OpenRouter não marcava nada.

O formato é o ponto delicado: o corpo do OpenRouter é OpenAI-shaped, então o
marcador vai DENTRO de um bloco de conteúdo da mensagem — não num campo
`cache_control` separado como na API da Anthropic. Só a PRIMEIRA mensagem
`system` leva o marcador: o engine empilha várias `system` depois dela (data,
humor, música, recall) que mudam a cada turno; marcar qualquer uma delas
moveria o breakpoint para dentro do trecho volátil e o cache nunca acertaria.
Como a Anthropic renderiza `tools` → `system` → `messages`, o breakpoint no
primeiro system cobre TAMBÉM o bloco de ferramentas, que é a maior parte fixa.
"""

from __future__ import annotations

import json

import httpx
import pytest
import respx
from llm_adapters.types import ChatMessage

from seraphine.deepsearch.providers import (
    OpenRouterChatClient,
    _supports_cache_breakpoints,
    _to_openai_messages,
)

EPHEMERAL = {"type": "ephemeral"}
ANTHROPIC_MODEL = "anthropic/claude-sonnet-4.5"


def _tool_msg(**body) -> ChatMessage:
    return ChatMessage(role="tool", content=json.dumps(body))


# ---------------------------------------------------------------- o marcador


def test_marcador_de_cache_sai_dentro_do_bloco_de_conteudo():
    """O formato exato que vai no fio. `cache_control` é campo do BLOCO."""
    out = _to_openai_messages(
        [ChatMessage(role="system", content="prompt grande e estável")],
        cache_system=True,
    )
    assert out == [
        {
            "role": "system",
            "content": [
                {
                    "type": "text",
                    "text": "prompt grande e estável",
                    "cache_control": EPHEMERAL,
                }
            ],
        }
    ]


def test_so_o_primeiro_system_e_marcado():
    """As `system` seguintes carregam contexto volátil (data, humor, recall).

    Um breakpoint dentro delas invalida o prefixo a cada turno — cache com
    100% de miss, pagando 1,25x na escrita e nunca lendo.
    """
    out = _to_openai_messages(
        [
            ChatMessage(role="system", content="prompt base"),
            ChatMessage(role="system", content="Hoje é 02/08/2026, 00:49."),
            ChatMessage(role="system", content="humor: animada"),
            ChatMessage(role="user", content="oi"),
        ],
        cache_system=True,
    )
    marcados = [
        m
        for m in out
        if isinstance(m["content"], list)
        and any("cache_control" in b for b in m["content"])
    ]
    assert len(marcados) == 1
    assert marcados[0]["content"][0]["text"] == "prompt base"
    # As voláteis atravessam como string simples, exatamente como antes.
    assert out[1] == {"role": "system", "content": "Hoje é 02/08/2026, 00:49."}
    assert out[2] == {"role": "system", "content": "humor: animada"}
    assert out[3] == {"role": "user", "content": "oi"}


def test_system_fora_da_primeira_posicao_ainda_e_o_alvo():
    """O alvo é a primeira mensagem COM role system, não `messages[0]`."""
    out = _to_openai_messages(
        [
            ChatMessage(role="user", content="oi"),
            ChatMessage(role="system", content="prompt base"),
        ],
        cache_system=True,
    )
    assert out[0] == {"role": "user", "content": "oi"}
    assert out[1]["content"][0]["cache_control"] == EPHEMERAL


def test_sem_mensagem_system_nao_quebra_nem_marca():
    out = _to_openai_messages(
        [ChatMessage(role="user", content="oi")], cache_system=True
    )
    assert out == [{"role": "user", "content": "oi"}]


def test_system_vazio_nao_vira_bloco():
    """Bloco de texto vazio é inútil (nunca atinge o mínimo cacheável) e a
    Anthropic rejeita `text` vazio — mandar isso troca economia por 400."""
    out = _to_openai_messages(
        [
            ChatMessage(role="system", content="   "),
            ChatMessage(role="user", content="oi"),
        ],
        cache_system=True,
    )
    assert out[0] == {"role": "system", "content": "   "}


def test_desligado_por_padrao_mantem_o_fio_byte_a_byte():
    """O default não pode mudar nada: 300+ modelos passam por aqui."""
    msgs = [
        ChatMessage(role="system", content="prompt base"),
        ChatMessage(role="user", content="oi"),
    ]
    assert _to_openai_messages(msgs) == [
        {"role": "system", "content": "prompt base"},
        {"role": "user", "content": "oi"},
    ]


def test_round_trip_de_ferramenta_sobrevive_ao_cache():
    """A invariante que o upstream cobra continua valendo com o cache ligado.

    Mensagem `tool` sem `tool_call_id`, ou sem o `assistant` com `tool_calls`
    antes, devolve 500 e derruba o chat inteiro. Já aconteceu em produção.
    """
    out = _to_openai_messages(
        [
            ChatMessage(role="system", content="prompt base"),
            ChatMessage(role="user", content="que horas sao?"),
            _tool_msg(tool="get_time", args={"tz": "America/Sao_Paulo"}, ok=True, output="18:40"),
        ],
        cache_system=True,
    )
    assert [m["role"] for m in out] == ["system", "user", "assistant", "tool"]
    assert out[2]["tool_calls"][0]["function"]["name"] == "get_time"
    assert out[3]["tool_call_id"] == out[2]["tool_calls"][0]["id"]
    assert out[3]["content"] == "18:40"
    # E o par tool continua string pura — o marcador não vaza para ele.
    assert isinstance(out[3]["content"], str)


# ------------------------------------------------------------------- o gate


@pytest.mark.parametrize(
    "model",
    [
        "anthropic/claude-sonnet-4.5",
        "anthropic/claude-opus-4.1",
        "anthropic/claude-3.5-haiku:beta",
        "ANTHROPIC/claude-sonnet-4.5",
        "  anthropic/claude-sonnet-4.5  ",
    ],
)
def test_gate_liga_para_anthropic(model):
    assert _supports_cache_breakpoints(model) is True


@pytest.mark.parametrize(
    "model",
    [
        "openai/gpt-4o-mini",
        "google/gemini-2.5-flash",
        "meta-llama/llama-3.3-70b-instruct",
        "deepseek/deepseek-chat",
        "",
        None,
    ],
)
def test_gate_desliga_para_o_resto_do_catalogo(model):
    """300+ modelos no catálogo; só a Anthropic exige breakpoint explícito.

    Para os demais o cache é automático (OpenAI, DeepSeek, Grok) ou tem
    economia diferente (Gemini explícito cobra armazenamento por hora).
    """
    assert _supports_cache_breakpoints(model) is False


# ------------------------------------------------------------- fio completo


def _sse(*lines: str) -> bytes:
    return ("\n".join([*lines, ""])).encode("utf-8")


_DONE = _sse('data: {"choices":[{"delta":{"content":"ok"}}]}', "data: [DONE]")


@pytest.mark.asyncio
@respx.mock
async def test_chat_marca_o_prompt_quando_o_modelo_suporta():
    respx.post("https://openrouter.ai/api/v1/chat/completions").mock(
        return_value=httpx.Response(
            200, headers={"content-type": "text/event-stream"}, content=_DONE
        )
    )
    c = OpenRouterChatClient(api_key="sk-or-x")
    async for _ in c.chat(
        [
            ChatMessage(role="system", content="prompt base"),
            ChatMessage(role="user", content="oi"),
        ],
        model=ANTHROPIC_MODEL,
    ):
        pass

    sent = json.loads(respx.calls.last.request.content)
    assert sent["messages"][0]["content"][0]["cache_control"] == EPHEMERAL


@pytest.mark.asyncio
@respx.mock
async def test_chat_nao_marca_modelo_sem_suporte():
    respx.post("https://openrouter.ai/api/v1/chat/completions").mock(
        return_value=httpx.Response(
            200, headers={"content-type": "text/event-stream"}, content=_DONE
        )
    )
    c = OpenRouterChatClient(api_key="sk-or-x")
    async for _ in c.chat(
        [
            ChatMessage(role="system", content="prompt base"),
            ChatMessage(role="user", content="oi"),
        ],
        model="openai/gpt-4o-mini",
    ):
        pass

    sent = json.loads(respx.calls.last.request.content)
    assert sent["messages"] == [
        {"role": "system", "content": "prompt base"},
        {"role": "user", "content": "oi"},
    ]


# ------------------------------------------------------- contadores de cache


def test_contadores_de_cache_chegam_na_telemetria():
    """Sem isso a mudança sobe e a gente torce.

    O OpenRouter devolve leitura/escrita de cache em `prompt_tokens_details`
    no frame final. É o único jeito de confirmar a economia com dado.
    """
    recebidos: list[dict] = []
    c = OpenRouterChatClient(api_key="sk-or-x", telemetry=recebidos.append)
    c._emit_usage(
        ANTHROPIC_MODEL,
        {
            "prompt_tokens": 59000,
            "completion_tokens": 72,
            "cost": 0.0071,
            "prompt_tokens_details": {
                "cached_tokens": 51200,
                "cache_write_tokens": 0,
            },
        },
    )
    assert recebidos == [
        {
            "backend": "openrouter",
            "model": ANTHROPIC_MODEL,
            "input_tokens": 59000,
            "output_tokens": 72,
            "cost_usd": 0.0071,
            "cache_read_tokens": 51200,
            "cache_write_tokens": 0,
        }
    ]


def test_escrita_de_cache_tambem_e_reportada():
    """O primeiro turno paga 1,25x — precisa aparecer, não só a leitura."""
    recebidos: list[dict] = []
    c = OpenRouterChatClient(api_key="sk-or-x", telemetry=recebidos.append)
    c._emit_usage(
        ANTHROPIC_MODEL,
        {
            "prompt_tokens": 59000,
            "completion_tokens": 72,
            "prompt_tokens_details": {"cached_tokens": 0, "cache_write_tokens": 51200},
        },
    )
    assert recebidos[0]["cache_write_tokens"] == 51200
    assert recebidos[0]["cache_read_tokens"] == 0


def test_usage_sem_bloco_de_cache_reporta_zero_e_nao_estoura():
    """Modelo sem cache / provedor que não reporta: zero, não KeyError."""
    recebidos: list[dict] = []
    c = OpenRouterChatClient(api_key="sk-or-x", telemetry=recebidos.append)
    c._emit_usage("openai/gpt-4o-mini", {"prompt_tokens": 10, "completion_tokens": 2})
    assert recebidos[0]["cache_read_tokens"] == 0
    assert recebidos[0]["cache_write_tokens"] == 0


def test_contadores_nao_numericos_viram_zero():
    """`prompt_tokens_details: null` é uma resposta real de alguns provedores."""
    recebidos: list[dict] = []
    c = OpenRouterChatClient(api_key="sk-or-x", telemetry=recebidos.append)
    c._emit_usage(ANTHROPIC_MODEL, {"prompt_tokens": 10, "prompt_tokens_details": None})
    assert recebidos[0]["cache_read_tokens"] == 0
    c._emit_usage(
        ANTHROPIC_MODEL,
        {"prompt_tokens": 10, "prompt_tokens_details": {"cached_tokens": "n/a"}},
    )
    assert recebidos[1]["cache_read_tokens"] == 0


@pytest.mark.asyncio
@respx.mock
async def test_contadores_saem_do_frame_final_do_stream():
    """Ponta a ponta: o frame de usage do SSE chega no sink."""
    body = _sse(
        'data: {"choices":[{"delta":{"content":"ok"}}]}',
        'data: {"choices":[],"usage":{"prompt_tokens":59000,"completion_tokens":72,'
        '"cost":0.0071,"prompt_tokens_details":{"cached_tokens":51200,'
        '"cache_write_tokens":0}}}',
        "data: [DONE]",
    )
    respx.post("https://openrouter.ai/api/v1/chat/completions").mock(
        return_value=httpx.Response(
            200, headers={"content-type": "text/event-stream"}, content=body
        )
    )
    recebidos: list[dict] = []
    c = OpenRouterChatClient(api_key="sk-or-x", telemetry=recebidos.append)
    async for _ in c.chat(
        [ChatMessage(role="user", content="oi")], model=ANTHROPIC_MODEL
    ):
        pass

    assert recebidos[0]["cache_read_tokens"] == 51200
    assert recebidos[0]["cache_write_tokens"] == 0
