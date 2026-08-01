"""Round-trip de ferramenta no formato OpenAI.

Bug de produção: via OpenRouter o chat funcionava até executar a primeira
ferramenta e então devolvia 500. `ChatMessage` não tem campo para
`tool_calls`, então o engine grava só a mensagem `role="tool"`; achatá-la
para `{"role","content"}` produz um histórico que API compatível com OpenAI
rejeita — mensagem `tool` sem `tool_call_id` e sem `assistant` com
`tool_calls` antes.
"""

import json

import pytest
from llm_adapters.types import ChatMessage

from seraphine.deepsearch.providers import _to_openai_messages


def _tool_msg(**body) -> ChatMessage:
    return ChatMessage(role="tool", content=json.dumps(body))


def test_mensagem_de_tool_vira_par_assistant_mais_tool():
    msgs = [
        ChatMessage(role="user", content="que horas sao?"),
        _tool_msg(tool="get_time", args={"tz": "America/Sao_Paulo"}, ok=True, output="18:40"),
    ]
    out = _to_openai_messages(msgs)

    assert [m["role"] for m in out] == ["user", "assistant", "tool"]

    assistant, tool = out[1], out[2]
    assert assistant["tool_calls"][0]["function"]["name"] == "get_time"
    assert tool["content"] == "18:40"


def test_tool_call_id_casa_dos_dois_lados():
    """Ids que não casam são exatamente o que o upstream rejeita."""
    out = _to_openai_messages([_tool_msg(tool="x", args={}, ok=True, output="ok")])
    assert out[1]["tool_call_id"] == out[0]["tool_calls"][0]["id"]


def test_ids_sao_unicos_entre_varias_ferramentas():
    out = _to_openai_messages(
        [
            _tool_msg(tool="a", args={}, ok=True, output="1"),
            _tool_msg(tool="b", args={}, ok=True, output="2"),
        ]
    )
    ids = [m["tool_call_id"] for m in out if m["role"] == "tool"]
    assert len(ids) == len(set(ids)) == 2


def test_arguments_e_string_json_nao_objeto():
    """No formato OpenAI `arguments` é string. Objeto quebra o parse upstream."""
    out = _to_openai_messages([_tool_msg(tool="x", args={"a": 1}, ok=True, output="ok")])
    args = out[0]["tool_calls"][0]["function"]["arguments"]
    assert isinstance(args, str)
    assert json.loads(args) == {"a": 1}


def test_args_reais_sobrevivem():
    """Args vazios fazem o modelo repetir a mesma tool em loop.

    Com `arguments: "{}"` no histórico, o modelo lê "chamei sem argumentos,
    preciso refazer direito" e reexecuta até estourar o limite de iterações.
    A mesma armadilha já documentada no adaptador Anthropic.
    """
    out = _to_openai_messages(
        [_tool_msg(tool="busca", args={"query": "clima hoje", "n": 3}, ok=True, output="sol")]
    )
    assert json.loads(out[0]["tool_calls"][0]["function"]["arguments"]) == {
        "query": "clima hoje",
        "n": 3,
    }


def test_erro_de_ferramenta_vira_conteudo_da_mensagem_tool():
    """`ok: False` traz `error` em vez de `output` — não pode virar vazio."""
    out = _to_openai_messages([_tool_msg(tool="x", args={}, ok=False, error="deu ruim")])
    assert out[1]["content"] == "deu ruim"


def test_conteudo_nao_json_nao_estoura():
    out = _to_openai_messages([ChatMessage(role="tool", content="texto solto")])
    assert out[1]["content"] == "texto solto"
    assert out[0]["tool_calls"][0]["function"]["name"] == "unknown_tool"


def test_mensagens_normais_atravessam_inalteradas():
    msgs = [
        ChatMessage(role="system", content="voce e a Seraphine"),
        ChatMessage(role="user", content="oi"),
        ChatMessage(role="assistant", content="ola"),
    ]
    out = _to_openai_messages(msgs)
    assert out == [
        {"role": "system", "content": "voce e a Seraphine"},
        {"role": "user", "content": "oi"},
        {"role": "assistant", "content": "ola"},
    ]


def test_nenhuma_mensagem_tool_fica_sem_tool_call_id():
    """A invariante que o upstream cobra, afirmada diretamente."""
    msgs = [
        ChatMessage(role="user", content="a"),
        _tool_msg(tool="t1", args={}, ok=True, output="x"),
        ChatMessage(role="assistant", content="pronto"),
        _tool_msg(tool="t2", args={}, ok=True, output="y"),
    ]
    out = _to_openai_messages(msgs)

    for i, m in enumerate(out):
        if m["role"] == "tool":
            assert m.get("tool_call_id"), "mensagem tool sem tool_call_id"
            anterior = out[i - 1]
            assert anterior["role"] == "assistant"
            assert anterior.get("tool_calls"), "tool sem assistant(tool_calls) antes"


@pytest.mark.parametrize("blocos", [[{"type": "text", "text": "oi"}]])
def test_conteudo_em_blocos_continua_sendo_achatado(blocos):
    out = _to_openai_messages([ChatMessage(role="user", content=blocos)])
    assert out == [{"role": "user", "content": "oi"}]
